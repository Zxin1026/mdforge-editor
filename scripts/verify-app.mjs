import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import iconv from 'iconv-lite'
import { _electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const root = process.cwd()

// 1x1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
)

/** 造一张指定尺寸的纯色 PNG，用于验证预览尺寸与放大 */
function makePng(width, height) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const rows = []
  for (let y = 0; y < height; y++) {
    rows.push(Buffer.from([0]))
    const line = Buffer.alloc(width * 3)
    line.fill(0x66)
    rows.push(line)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const HEADING = '# 中文标题'
const BODY =
  '\n\n这是 **GBK** 文件。\n\n![预览](assets/preview.png)\n\n- [x] 已完成\n- [ ] 待办\n\n```js\nconst total = 1 + 2\n```\n'
const GBK_TEXT_LF = HEADING + BODY
const EDITED_LF = `${HEADING}（已修改）${BODY}`
const TOGGLED_LF = EDITED_LF.replace('- [ ] 待办', '- [x] 待办')

const failures = []
const pageErrors = []
const consoleErrors = []
/** 原生对话框出现次数：文件层的确认全部改到应用内后应始终为 0 */
let nativeDialogs = 0

function check(name, condition, detail = '') {
  const note = String(detail).replace(/\r?\n/g, '\\n').slice(0, 70)
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${note ? ` -> ${note}` : ''}`)
  if (!condition) failures.push(name)
}

async function lines(win) {
  return win.$$eval('.cm-line', (els) => els.map((el) => ({ text: el.innerText, cls: el.className })))
}

/** 点应用内确认框里的按钮：原生 confirm 已全部换成自定义对话框 */
async function answer(win, label) {
  await win.locator(`.mdf-dialog-button:text-is("${label}")`).click()
  await win.waitForTimeout(250)
}

function dialogButtons(win) {
  return win.$$eval('.mdf-dialog-button', (els) => els.map((el) => el.textContent))
}

function dialogText(win) {
  return win.evaluate(() => {
    const box = document.querySelector('.mdf-dialog')
    return box ? box.innerText.replace(/\s+/g, ' ') : ''
  })
}

function menuLabels(win) {
  return win.$$eval('.mdf-menu-item', (els) => els.map((el) => el.dataset.menuLabel))
}

/** 轮询等待某个条件成立，返回最后一次取值 */
async function until(read, ok, timeoutMs = 9000, step = 120) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (ok(value)) return value
    if (Date.now() > deadline) return value
    await new Promise((resolve) => setTimeout(resolve, step))
  }
}

/** 保存按钮随工具栏一起并进菜单栏：统一用快捷键，等价于点 文件 → 保存 */
async function saveDoc(w) {
  await w.keyboard.press('Control+s')
}

function asGbk(text) {
  return iconv.encode(text.replace(/\n/g, '\r\n'), 'gbk')
}

/* 会话与崩溃草稿存在全局 userData 下，供后面的草稿/会话用例读写 */
const userData = path.join(process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), 'mdforge-editor')
const draftRoot = path.join(userData, 'drafts')
/* 上一次没跑完的验证会留下崩溃草稿和会话（含自动保存开关），首个窗口要么先弹恢复框要么根本不自动保存：
   开跑前把 userData 里的这两样清干净，用例之间才有确定的初始状态 */
const clearDrafts = () => rmSync(draftRoot, { recursive: true, force: true })
const resetAppData = () => {
  clearDrafts()
  rmSync(path.join(userData, 'session.json'), { force: true })
}
/* Windows 上 playwright 经 cmd.exe /c 拉起 electron，process().kill() 只杀得掉 cmd 这一层，
   electron 会作为孤儿窗口继续挂着：close() 等不到进程退出，孤儿还会周期性写草稿搅乱后面的用例。
   硬杀必须用 taskkill 连整棵进程树一起收 */
const killApp = (app) => {
  spawnSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' })
}
const draftCount = () => {
  try {
    return readdirSync(draftRoot).filter((name) => name.endsWith('.json')).length
  } catch {
    return 0
  }
}
const readSafe = (target) => {
  try {
    return readFileSync(target, 'utf8')
  } catch {
    return null
  }
}

const workDir = mkdtempSync(path.join(tmpdir(), 'mdforge-e2e-'))
mkdirSync(path.join(workDir, 'assets'), { recursive: true })
writeFileSync(path.join(workDir, 'assets', 'preview.png'), PNG)

const fixture = path.join(workDir, 'GBK 文档.md')
const gbkBytes = asGbk(GBK_TEXT_LF)
writeFileSync(fixture, gbkBytes)

/* 上一次没跑完的验证会留下崩溃草稿，首个窗口会先弹恢复框挡住所有点击：开跑前清干净 */
resetAppData()

const app = await _electron.launch({
  executablePath: require('electron'),
  args: [root, fixture],
  cwd: root
})

const win = await app.firstWindow()
win.on('dialog', (dialog) => {
  nativeDialogs += 1
  dialog.accept().catch(() => {})
})
win.on('pageerror', (error) => pageErrors.push(error.message))
win.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
await win.waitForSelector('.cm-content')
await win.waitForTimeout(400)

const shownMeta = await win.textContent('#file-meta')
const shownName = await win.textContent('#file-name')
let rendered = await lines(win)

check('界面标注编码为 GBK', shownMeta.includes('GBK'), shownMeta)
check('标注换行符为 CRLF', shownMeta.includes('CRLF'), shownMeta)
check('标题栏显示文件名', shownName.includes('GBK 文档.md'), shownName)
check('未改动时不显示脏标记', !shownName.includes('•'), shownName)
check('标题行带 mdf-heading-1 类', rendered[0].cls.includes('mdf-heading-1'), rendered[0].cls)
check('光标所在行保留 # 标记', rendered[0].text.includes('#'), rendered[0].text)

const boldLine = rendered.find((line) => line.text.includes('GBK'))
check('非光标行的 ** 标记被隐藏', boldLine !== undefined && !boldLine.text.includes('**'), boldLine?.text)
check('隐藏标记后文字仍完整', boldLine?.text.includes('这是') && boldLine?.text.includes('文件。'), boldLine?.text)

await win.locator('.cm-line', { hasText: 'GBK' }).click()
await win.waitForTimeout(150)
rendered = await lines(win)
check(
  '光标进入后标记符恢复可编辑',
  rendered.find((line) => line.text.includes('GBK'))?.text.includes('**'),
  rendered.find((line) => line.text.includes('文件。'))?.text
)

await win.locator('.cm-line', { hasText: '中文标题' }).click()
await win.waitForTimeout(150)
rendered = await lines(win)
check('光标离开后标记符再次隐藏', !rendered.find((line) => line.text.includes('文件。')).text.includes('**'))

const headingUnderline = await win.evaluate(() => {
  const line = document.querySelector('.cm-line')
  const span = line?.querySelector('span')
  return span ? getComputedStyle(span).textDecorationLine : 'no span'
})
check('标题与链接不加默认下划线', headingUnderline === 'none', headingUnderline)

/* 块级预览 */
let imageOk = false
let imageWidth = -1
try {
  await win.waitForSelector('.mdf-preview-img', { timeout: 3000 })
  imageWidth = await win.$eval('.mdf-preview-img', (el) => el.naturalWidth)
  imageOk = imageWidth > 0
} catch {
  imageOk = false
}
check('本地图片经 mdasset 协议显示', imageOk, `naturalWidth=${imageWidth}`)

const boxes = await win.$$('.mdf-task-box')
check('任务列表渲染为复选框', boxes.length === 2, `count=${boxes.length}`)
if (boxes.length === 2) {
  check('复选框反映原始勾选状态', (await boxes[0].isChecked()) && !(await boxes[1].isChecked()))
}

// defaultHighlightStyle 注入的是匿名类，所以按实际渲染色判定，而不是类名
const highlightColors = await win.evaluate(() => {
  const line = [...document.querySelectorAll('.cm-line')].find((el) => el.innerText.includes('const total'))
  const token = [...(line?.querySelectorAll('span') ?? [])].find(
    (el) => !el.className.startsWith('mdf-') && el.textContent.includes('const')
  )
  if (!token) return null
  const sheets = [...document.querySelectorAll('style')].map((el) => el.textContent)
  return {
    token: getComputedStyle(token).color,
    base: getComputedStyle(document.querySelector('.cm-content')).color,
    tokenClass: token.className,
    styleTags: sheets.length,
    hasRule: sheets.some((text) => text && text.includes(token.className))
  }
})
check(
  '围栏代码块语法高亮',
  highlightColors !== null && highlightColors.token !== highlightColors.base,
  JSON.stringify(highlightColors)
)

mkdirSync(path.join(root, 'verify'), { recursive: true })
await win.screenshot({ path: path.join(root, 'verify', 'block-preview.png') })

/* 保存与字节保真 */
await saveDoc(win)
await win.waitForTimeout(400)
check('零改动保存后字节完全一致', Buffer.compare(readFileSync(fixture), gbkBytes) === 0)

await win.locator('.cm-line', { hasText: '中文标题' }).click()
await win.keyboard.press('End')
await win.keyboard.type('（已修改）')
await win.waitForTimeout(150)
check('输入后标题出现脏标记', (await win.textContent('#file-name')).includes('•'))

await saveDoc(win)
await win.waitForTimeout(400)
check('编辑后按 GBK + CRLF 写回', Buffer.compare(readFileSync(fixture), asGbk(EDITED_LF)) === 0)
check('保存后脏标记消失', !(await win.textContent('#file-name')).includes('•'))

/* 勾选任务写回源文本 */
const freshBoxes = await win.$$('.mdf-task-box')
check('编辑后复选框仍在', freshBoxes.length === 2, `count=${freshBoxes.length}`)
if (freshBoxes.length === 2) {
  await freshBoxes[1].click()
  await win.waitForTimeout(200)
  await saveDoc(win)
  await win.waitForTimeout(400)
  const afterToggle = iconv.decode(readFileSync(fixture), 'gbk').replace(/\r\n/g, '\n')
  check('点击复选框写回 [x]', afterToggle === TOGGLED_LF, afterToggle.slice(0, 60))
}

/* 撤销：回退勾选后保存，文件应回到 [ ] */
await win.locator('.cm-content').click()
await win.keyboard.press('Control+z')
await win.waitForTimeout(200)
await saveDoc(win)
await win.waitForTimeout(400)
const afterUndo = iconv.decode(readFileSync(fixture), 'gbk').replace(/\r\n/g, '\n')
check('撤销回退了勾选', afterUndo === EDITED_LF, afterUndo.slice(0, 60))

/* 第二轮：用真实手册副本验证大纲与跳转 */
const HANDBOOK = path.join(root, '..', 'MDForge-完整开发流程与操作手册.md')
if (existsSync(HANDBOOK)) {
  const copy = path.join(workDir, '手册副本.md')
  copyFileSync(HANDBOOK, copy)

  const app2 = await _electron.launch({
    executablePath: require('electron'),
    args: [root, copy],
    cwd: root
  })
  const win2 = await app2.firstWindow()
  win2.on('dialog', (dialog) => {
    nativeDialogs += 1
    dialog.accept().catch(() => {})
  })
  win2.on('pageerror', (error) => pageErrors.push(error.message))
  await win2.waitForSelector('.outline-item')
  await win2.waitForTimeout(400)

  const outline = await win2.$$eval('.outline-item', (els) =>
    els.map((el) => ({ text: el.textContent, title: el.title }))
  )
  check('大纲列出全部标题', outline.length >= 25, `count=${outline.length}`)
  check(
    '带标点标题的锚点去掉标点',
    outline.some((item) => item.title === '#51-输入模型'),
    outline.find((item) => item.text.includes('输入模型'))?.title
  )

  const target = outline.findIndex((item) => item.text === '11. 安全要求')
  check('大纲含目标标题', target >= 0, `index=${target}`)
  if (target >= 0) {
    await win2.locator('.outline-item').nth(target).click()
    await win2.waitForTimeout(300)
    const active = await win2.$$eval('.outline-item.is-active', (els) => els.map((el) => el.textContent))
    check('点击后该项标记为当前标题', active.includes('11. 安全要求'), JSON.stringify(active))
    const visible = await win2.evaluate(() => {
      const line = [...document.querySelectorAll('.cm-line')].find((el) => el.innerText.includes('安全要求'))
      if (!line) return 'line not found'
      const box = line.getBoundingClientRect()
      const view = document.querySelector('.cm-scroller').getBoundingClientRect()
      return box.top >= view.top - 2 && box.bottom <= view.bottom + 2
        ? 'visible'
        : `offscreen ${Math.round(box.top)}/${Math.round(view.top)}`
    })
    check('目标标题滚动进可视区', visible === 'visible', visible)
  }

  /* 顶栏换成菜单栏：按钮行不再存在，导出等动作从菜单进入 */
  const barButtons = await win2.$$eval('.mdf-menubar-button', (els) => els.map((el) => el.textContent))
  check('菜单栏替换原按钮行', barButtons.join(',') === '文件,编辑,段落,格式,视图,主题,帮助', JSON.stringify(barButtons))
  await win2.click('.mdf-menubar-button[data-menu="file"]')
  await win2.waitForSelector('.mdf-menu--bar')
  const fileMenu = await menuLabels(win2)
  check('文件菜单含导出与保存', fileMenu.includes('导出') && fileMenu.includes('保存'), JSON.stringify(fileMenu))
  await win2.keyboard.press('Escape')
  await win2.waitForTimeout(150)
  check('Esc 收起菜单', (await win2.locator('.mdf-menu').count()) === 0)

  const savedStatus = await win2.evaluate(() => document.querySelector('#status').textContent)
  check('未操作时状态栏为空', savedStatus === '', savedStatus)

  await win2.screenshot({ path: path.join(root, 'verify', 'outline.png') })
  await app2.close()
} else {
  console.log('跳过大纲验证：找不到手册文件')
}

/* 编辑体验：快捷键 / 查找替换 / 列表续写 / 悬浮预览 / 标签页 / 状态栏 */
function readLines(w) {
  return w.$$eval('.cm-line', (els) => els.filter((e) => e.offsetParent !== null).map((e) => e.innerText))
}

const app3 = await _electron.launch({ executablePath: require('electron'), args: [root], cwd: root })
const win3 = await app3.firstWindow()
win3.on('dialog', (d) => {
  nativeDialogs += 1
  d.accept().catch(() => {})
})
win3.on('pageerror', (e) => pageErrors.push(e.message))
await win3.waitForSelector('.cm-content')
await win3.waitForTimeout(350)
await win3.locator('.cm-content').click()

/* 编辑器区右键菜单与视图设置：趁首次编辑之前检查。
   这几秒的耗时若夹在“最后一次编辑”与“关闭脏标签”之间，会先触发自动保存（3 秒延迟），
   标签变干净后关标签就不再弹确认框，后面的用例会等不到 .mdf-dialog */
await win3.locator('.cm-line').first().click({ button: 'right' })
await win3.waitForSelector('.mdf-menu[data-context="1"]')
const ctxLabels = await win3.$$eval('.mdf-menu[data-context="1"] .mdf-menu-item', (els) =>
  els.map((el) => el.dataset.menuLabel)
)
check(
  '右键菜单条目齐全',
  [
    '撤销',
    '重做',
    '剪切',
    '复制',
    '粘贴',
    '全选',
    '加粗',
    '斜体',
    '删除线',
    '行内代码',
    '插入表格',
    '查找',
    '替换'
  ].every((label) => ctxLabels.includes(label)),
  JSON.stringify(ctxLabels)
)
await win3.locator('.mdf-menu[data-context="1"] .mdf-menu-item[data-menu-label="查找"]').click()
await win3.waitForTimeout(250)
check('右键菜单能执行动作（打开查找）', (await win3.locator('.cm-panel').count()) > 0)
await win3.keyboard.press('Escape')
await win3.waitForTimeout(200)
await win3.locator('.cm-line').first().click({ button: 'right' })
await win3.waitForSelector('.mdf-menu[data-context="1"]')
await win3.keyboard.press('Escape')
await win3.waitForTimeout(150)
check('Esc 收起右键菜单', (await win3.locator('.mdf-menu[data-context="1"]').count()) === 0)

/* 视图设置：字号与编辑区宽度即时生效，并能还原 */
async function pickViewItem(submenu, item) {
  await win3.click('.mdf-menubar-button[data-menu="view"]')
  await win3.waitForSelector('.mdf-menu--bar')
  await win3.locator(`.mdf-menu--bar .mdf-menu-item[data-menu-label="${submenu}"]`).click()
  await win3.waitForTimeout(200)
  await win3.locator(`.mdf-menu--sub .mdf-menu-item[data-menu-label="${item}"]`).click()
  await win3.waitForTimeout(200)
  await win3.keyboard.press('Escape')
  await win3.waitForTimeout(150)
}
await pickViewItem('字体大小', '大 (15 px)')
const fontNow = await win3.evaluate(() => getComputedStyle(document.querySelector('.cm-scroller')).fontSize)
check('字号菜单立即生效', fontNow === '15px', fontNow)
await pickViewItem('编辑区宽度', '中 (900 px)')
const widthNow = await win3.evaluate(() => getComputedStyle(document.querySelector('.cm-content')).maxWidth)
check('编辑区宽度菜单立即生效', widthNow === '900px', widthNow)
await win3.screenshot({ path: path.join(root, 'verify', 'view-settings.png') })
await pickViewItem('字体大小', '标准 (14 px)')
await pickViewItem('编辑区宽度', '铺满')
const widthBack = await win3.evaluate(() => getComputedStyle(document.querySelector('.cm-content')).maxWidth)
check('编辑区宽度可还原为铺满', widthBack === 'none', widthBack)

async function replaceAll(selectAllText, text) {
  await win3.keyboard.press('Control+a')
  await win3.keyboard.type(text)
}

await replaceAll(true, '粗体测试')
await win3.keyboard.press('Control+a')
await win3.keyboard.press('Control+b')
await win3.waitForTimeout(150)
let l3 = await readLines(win3)
check('Ctrl+B 包裹加粗标记', l3[0] === '**粗体测试**', l3[0])

await replaceAll(true, '小节')
await win3.keyboard.press('Control+2')
await win3.waitForTimeout(120)
l3 = await readLines(win3)
check('Ctrl+2 设置二级标题', l3[0].startsWith('## '), l3[0])

await replaceAll(true, '- 甲')
await win3.keyboard.press('Enter')
await win3.keyboard.type('乙')
await win3.waitForTimeout(120)
l3 = await readLines(win3)
check(
  '回车续写列表：两行都带标记',
  l3.some((t) => t.includes('甲')) && l3.some((t) => /-\s*乙/.test(t)),
  JSON.stringify(l3)
)

await replaceAll(true, '- ')
await win3.keyboard.press('Enter')
await win3.waitForTimeout(120)
l3 = await readLines(win3)
check(
  '空条目回车退出列表（清掉标记）',
  l3.every((t) => !/^\s*-\s/.test(t)),
  JSON.stringify(l3)
)

await replaceAll(true, 'hello hello hello')
await win3.keyboard.press('Control+f')
await win3.waitForTimeout(200)
check('Ctrl+F 打开查找替换面板', (await win3.locator('.cm-panel.cm-search').count()) === 1)
const searchInput = win3.locator('.cm-panel.cm-search input[name="search"]')
await searchInput.fill('hello')
await searchInput.press('Enter')
await win3.waitForTimeout(250)
const matchCount = await win3.locator('.cm-searchMatch').count()
check('查找命中并高亮', matchCount >= 1, `matches=${matchCount}`)
await win3.locator('.cm-panel.cm-search input[name="replace"]').fill('bye')
await win3.locator('.cm-panel.cm-search button[name="replaceAll"]').click()
await win3.waitForTimeout(200)
await win3.keyboard.press('Escape')
await win3.waitForTimeout(120)
l3 = await readLines(win3)
check('替换全部生效', l3[0] === 'bye bye bye', l3[0])

await replaceAll(true, '见 [示例](https://example.com) 结束')
await win3.waitForTimeout(150)
const linkBox = await win3.locator('.mdf-link').first().boundingBox()
if (linkBox) {
  await win3.mouse.move(linkBox.x + linkBox.width / 2, linkBox.y + linkBox.height / 2)
  await win3.waitForTimeout(250)
  const hoverText = await win3.$$eval('.mdf-hover', (els) =>
    els.filter((e) => e.style.display !== 'none').map((e) => e.textContent)
  )
  check('悬浮链接显示目标地址', hoverText.join('').includes('https://example.com'), JSON.stringify(hoverText))
} else {
  check('悬浮链接显示目标地址', false, '找不到 .mdf-link 位置')
}

const tabsBefore = await win3.locator('.tab').count()
await win3.keyboard.press('Control+n')
await win3.waitForTimeout(150)
const tabsAfter = await win3.locator('.tab').count()
check('Ctrl+N 新建标签', tabsAfter === tabsBefore + 1, `${tabsBefore}->${tabsAfter}`)
await win3.locator('.tab-close').last().click()
await win3.waitForTimeout(150)
const tabsClosed = await win3.locator('.tab').count()
check('关闭标签回到原数量', tabsClosed === tabsBefore, `count=${tabsClosed}`)

const metrics = await win3.textContent('#status-metrics')
check('状态栏显示字数与行列', metrics.includes('字数') && metrics.includes('列'), metrics)

// 关闭脏标签：自定义确认框选“不保存关闭”，回到干净的空白标签，窗口才关得掉
await win3.locator('.tab-close').first().click()
await win3.waitForSelector('.mdf-dialog')
await answer(win3, '不保存关闭')
await win3.waitForTimeout(200)
check('脏标签关闭用应用内确认框（原生对话框为 0）', nativeDialogs === 0, `count=${nativeDialogs}`)

await win3.screenshot({ path: path.join(root, 'verify', 'editing.png') })
await app3.close()

/* 相对 .md 链接：Ctrl+点击在本应用内打开 */
const relDir = mkdtempSync(path.join(tmpdir(), 'mdforge-rel-'))
writeFileSync(path.join(relDir, 'sibling.md'), '# 兄弟文档\n')
const baseFile = path.join(relDir, 'base.md')
writeFileSync(baseFile, '[去](./sibling.md)\n')
const app4 = await _electron.launch({ executablePath: require('electron'), args: [root, baseFile], cwd: root })
const win4 = await app4.firstWindow()
win4.on('dialog', (d) => {
  nativeDialogs += 1
  d.accept().catch(() => {})
})
win4.on('pageerror', (e) => pageErrors.push(e.message))
await win4.waitForSelector('.cm-content')
await win4.waitForTimeout(350)
const relTabs0 = await win4.locator('.tab').count()
await win4
  .locator('.mdf-url')
  .first()
  .click({ modifiers: ['Control'] })
await win4.waitForTimeout(600)
const relTabs1 = await win4.locator('.tab').count()
const relName = await win4.textContent('#file-name')
const relErr = await win4.textContent('#status')
check('Ctrl+点击相对链接新开标签', relTabs1 === relTabs0 + 1, `${relTabs0}->${relTabs1}${relErr ? ' | ' + relErr : ''}`)
check('打开的是相对目标文件', relName.includes('sibling.md'), relName)
await app4.close()

/* 会话恢复：开一个文件 → 关闭 → 无文件参数重启应恢复标签 */
const sessionTarget = path.join(relDir, 'session-target.md')
writeFileSync(sessionTarget, '# 会话目标\n')
const app5 = await _electron.launch({ executablePath: require('electron'), args: [root, sessionTarget], cwd: root })
const win5 = await app5.firstWindow()
win5.on('dialog', (d) => {
  nativeDialogs += 1
  d.accept().catch(() => {})
})
win5.on('pageerror', (e) => pageErrors.push(e.message))
await win5.waitForSelector('.cm-content')
await win5.waitForTimeout(1000)
await app5.close()

const app6 = await _electron.launch({ executablePath: require('electron'), args: [root], cwd: root })
const win6 = await app6.firstWindow()
win6.on('dialog', (d) => {
  nativeDialogs += 1
  d.accept().catch(() => {})
})
win6.on('pageerror', (e) => pageErrors.push(e.message))
await win6.waitForSelector('.cm-content')
await win6.waitForTimeout(500)
const restoredName = await win6.textContent('#file-name')
const restoredTabs = await win6.locator('.tab').count()
check(
  '重启后恢复上次会话标签',
  restoredName.includes('session-target.md') && restoredTabs >= 1,
  `${restoredName} | tabs=${restoredTabs}`
)
await app6.close()

/* 渲染能力：front matter / 数学 / mermaid / 表格 / 图片放大与拖宽 / 粘贴落盘 */
const renderDir = mkdtempSync(path.join(tmpdir(), 'mdforge-render-'))
mkdirSync(path.join(renderDir, 'assets'), { recursive: true })
writeFileSync(path.join(renderDir, 'assets', 'pic.png'), makePng(400, 200))

const RENDER_LINES = [
  '---',
  'title: 渲染测试',
  'tags: [数学, 图表]',
  'note: *假斜体*',
  '---',
  '',
  '# 渲染',
  '',
  '行内公式 $a^2 + b^2 = c^2$ 结束。',
  '',
  '$$',
  'E = mc^2',
  '$$',
  '',
  '```mermaid',
  'graph TD',
  '  A[开始] --> B[结束]',
  '```',
  '',
  '| 名称 | 数量 |',
  '| :--- | ---: |',
  '| 苹果 | 3 |',
  '| 梨 | 12 |',
  '',
  '![配图](assets/pic.png)',
  ''
]
const renderDoc = path.join(renderDir, '渲染.md')
writeFileSync(renderDoc, RENDER_LINES.join('\r\n'), 'utf8')

const app7 = await _electron.launch({ executablePath: require('electron'), args: [root, renderDoc], cwd: root })
const win7 = await app7.firstWindow()
win7.on('dialog', (d) => {
  nativeDialogs += 1
  d.accept().catch(() => {})
})
win7.on('pageerror', (e) => pageErrors.push(e.message))
win7.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
await win7.waitForSelector('.cm-content')
await win7.waitForTimeout(700)

const fmLines = await win7.locator('.mdf-frontmatter').count()
check('front matter 逐行弱化', fmLines === 5, `lines=${fmLines}`)
const fmItalic = await win7.evaluate(() =>
  [...document.querySelectorAll('.mdf-frontmatter')].some((el) => el.querySelector('.mdf-em, .mdf-strong') !== null)
)
check('front matter 里的星号不被当成强调', !fmItalic)
const outlineText = await win7.$$eval('.outline-item', (els) => els.map((el) => el.textContent))
check(
  '大纲不含 front matter 的 YAML 行',
  !outlineText.some((text) => text.includes('title:')),
  JSON.stringify(outlineText)
)
const fmWeight = await win7.evaluate(() => {
  const lines = [...document.querySelectorAll('.cm-line.mdf-frontmatter')]
  for (const line of lines) {
    for (const span of [...line.querySelectorAll('span')]) {
      const weight = getComputedStyle(span).fontWeight
      if (span.textContent && span.textContent.trim() !== '') return `${weight}:${span.textContent.trim()}`
    }
  }
  return 'no span'
})
check('front matter 正文不被高亮加粗', fmWeight === 'no span' || fmWeight.startsWith('400'), fmWeight)

await win7.locator('.mdf-fm-toggle').click()
await win7.waitForTimeout(250)
check('点击折叠后只剩占位条', (await win7.locator('.mdf-fm-collapsed').count()) === 1)
const foldedText = await win7.evaluate(() => document.querySelector('.cm-content').innerText)
check('折叠后隐藏 YAML 内容', !foldedText.includes('假斜体'), foldedText.slice(0, 40))
await win7.locator('.mdf-fm-collapsed').click()
await win7.waitForTimeout(250)
check(
  '再点展开恢复原文',
  (await win7.locator('.mdf-fm-toggle').count()) === 1 && (await win7.locator('.mdf-fm-collapsed').count()) === 0
)

// 光标停在标题行，块级预览才全部出现（此时 # 已被隐藏，按类名定位）
await win7.locator('.cm-line.mdf-heading-1').click()
await win7.waitForTimeout(300)

const mathBlock = await win7.evaluate(() => {
  const block = document.querySelector('.mdf-math-block')
  return block ? { katex: block.querySelector('.katex') !== null, text: block.textContent } : null
})
check(
  '$$ 块渲染为 KaTeX',
  mathBlock !== null && mathBlock.katex && mathBlock.text.includes('m'),
  JSON.stringify(mathBlock)
)
check('行内公式渲染', (await win7.locator('.mdf-math-inline .katex').count()) === 1)
const rawInline = await win7.evaluate(() => document.querySelector('.cm-content').innerText)
check('行内源码被公式替换', !rawInline.includes('$a^2'), rawInline.slice(0, 60))

let mermaidOk = false
try {
  await win7.waitForSelector('.mdf-mermaid svg', { timeout: 9000 })
  mermaidOk = true
} catch {
  mermaidOk = false
}
check('mermaid 渲染成 SVG', mermaidOk)
const mermaidNote = await win7.evaluate(() => document.querySelector('.mdf-mermaid')?.textContent ?? '')
check('mermaid 未报错', !mermaidNote.includes('失败'), mermaidNote.slice(0, 70))

const grid = await win7.evaluate(() => {
  const table = document.querySelector('.mdf-table-grid')
  if (!table) return null
  return {
    head: [...table.querySelectorAll('th')].map((el) => el.textContent),
    rows: [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent)),
    align: [...table.querySelectorAll('tbody td')].map((td) => td.style.textAlign)
  }
})
check(
  '表格渲染成真实网格',
  grid !== null && grid.head.join(',') === '名称,数量' && grid.rows.length === 2 && grid.rows[1].join('|') === '梨|12',
  JSON.stringify(grid)
)
check(
  '对齐标记落到单元格',
  grid !== null && grid.align.join(',') === 'left,right,left,right',
  JSON.stringify(grid?.align)
)

/* 表格源码被网格顶掉；点单元格就地编辑，回车写回、撤销可回退 */
const tableNow = await win7.evaluate(() => ({
  grid: document.querySelector('.mdf-table-grid') !== null,
  rawAligner: document.querySelector('.cm-content').innerText.includes(':---')
}))
check('表格源码不显示，只留网格', tableNow.grid && !tableNow.rawAligner, JSON.stringify(tableNow))
await win7.locator('.mdf-table-grid tbody td').first().click()
await win7.waitForSelector('.mdf-table-edit')
await win7.locator('.mdf-table-edit').fill('苹果干')
await win7.locator('.mdf-table-edit').press('Enter')
await win7.waitForTimeout(300)
const editedCell = await win7.evaluate(() => document.querySelector('.mdf-table-grid tbody td')?.textContent ?? '')
check('单元格就地编辑写回表格', editedCell === '苹果干', editedCell)
await win7.keyboard.press('Control+z')
await win7.waitForTimeout(300)
const undoCell = await win7.evaluate(() => document.querySelector('.mdf-table-grid tbody td')?.textContent ?? '')
check('撤销回退单元格修改', undoCell === '苹果', undoCell)
await win7.screenshot({ path: path.join(root, 'verify', 'table-edit.png') })

await win7.waitForSelector('.mdf-preview-img', { timeout: 4000 })
const natural = await win7.$eval('.mdf-preview-img', (el) => el.naturalWidth)
check('预览图经协议加载原图', natural === 400, `naturalWidth=${natural}`)

await win7.locator('.mdf-preview-img').click()
await win7.waitForTimeout(300)
const lightbox = await win7.evaluate(() => {
  const box = document.querySelector('.mdf-lightbox')
  return box
    ? { display: getComputedStyle(box).display, width: document.querySelector('.mdf-lightbox-img')?.naturalWidth ?? -1 }
    : null
})
check(
  '点击预览打开放大层',
  lightbox !== null && lightbox.display === 'flex' && lightbox.width === 400,
  JSON.stringify(lightbox)
)
await win7.screenshot({ path: path.join(root, 'verify', 'lightbox.png') })
await win7.keyboard.press('Escape')
await win7.waitForTimeout(200)
check('Esc 关闭放大层', (await win7.locator('.mdf-lightbox').count()) === 0)

const gripBox = await win7.locator('.mdf-resize-grip').boundingBox()
await win7.locator('.mdf-preview-img').hover()
await win7.waitForTimeout(250)
await win7.screenshot({ path: path.join(root, 'verify', 'render-lower.png') })
if (gripBox) {
  await win7.mouse.move(gripBox.x + 4, gripBox.y + 4)
  await win7.mouse.down()
  await win7.mouse.move(gripBox.x - 130, gripBox.y + 4, { steps: 8 })
  await win7.mouse.up()
  await win7.waitForTimeout(350)
  const resized = await win7.evaluate(() => {
    const content = document.querySelector('.cm-content').innerText
    const match = /assets\/pic\.png "w=(\d+)"/.exec(content)
    return {
      width: match ? Number(match[1]) : -1,
      shown: document.querySelector('.mdf-preview-img')?.getBoundingClientRect().width ?? -1
    }
  })
  check('拖拽手柄把宽度写进源码', resized.width > 100 && resized.width < 320, JSON.stringify(resized))
  check('预览宽度随源码生效', Math.abs(resized.shown - resized.width) < 5, JSON.stringify(resized))

  await saveDoc(win7)
  await win7.waitForTimeout(400)
  const saved = readFileSync(renderDoc, 'utf8')
  check('保存后宽度提示留在文件里', new RegExp(`assets/pic.png "w=${resized.width}"`).test(saved))
  check('保存保持 CRLF', saved.includes('\r\n'))
} else {
  check('拖拽手柄把宽度写进源码', false, '找不到 .mdf-resize-grip')
}

// 先把光标放到文档末尾新起一行，粘贴落点与用户手动插入一致
await win7.locator('.cm-line', { hasText: '配图' }).click()
await win7.keyboard.press('End')
await win7.keyboard.press('Enter')
await win7.waitForTimeout(200)

const pasted = await win7.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
  const transfer = new DataTransfer()
  transfer.items.add(new File([bytes], '屏幕截图.PNG', { type: 'image/png' }))
  const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
  const notHandled = document.querySelector('.cm-content').dispatchEvent(event)
  return { taken: !notHandled, files: transfer.files.length }
}, PNG.toString('base64'))
check('粘贴图片被接管', pasted.taken, JSON.stringify(pasted))
await win7.waitForTimeout(1200)
const pastedText = await win7.evaluate(() => document.querySelector('.cm-content').innerText)
// 中文名会被主进程净化成 ASCII 文件名
check('粘贴后插入 assets 相对链接', /!\[[^\]]*\]\(assets\/image\.png\)/.test(pastedText), pastedText.slice(-70))
check('剪贴板图片落盘到 assets/', existsSync(path.join(renderDir, 'assets', 'image.png')))
// 插入后光标停在链接末尾：预览应立即渲染（源码行仍可见，方便顺手改 alt）
const previewNow = await win7.locator('.mdf-preview-img').count()
check('粘贴后预览立即渲染', previewNow >= 2, `count=${previewNow}`)
await win7.locator('.cm-line.mdf-heading-1').click()
await win7.waitForTimeout(400)
const previewCount = await win7.locator('.mdf-preview-img').count()
check('光标移开后预览保持', previewCount >= 2, `count=${previewCount}`)
await win7.screenshot({ path: path.join(root, 'verify', 'render-capabilities.png') })
await win7.locator('.tab-close').first().click()
await win7.waitForSelector('.mdf-dialog')
await answer(win7, '不保存关闭')
await win7.waitForTimeout(300)
await app7.close()

/* 文件层补全：编码/换行符切换、外部修改实时监测、自动保存与崩溃草稿、自定义关闭确认 */
const flDir = mkdtempSync(path.join(tmpdir(), 'mdforge-fl-'))
const FL_DOC = path.join(flDir, '说明.md')
writeFileSync(FL_DOC, '# 说明\r\n\r\n第一段\r\n', 'utf8')
resetAppData()

const app8 = await _electron.launch({ executablePath: require('electron'), args: [root, FL_DOC], cwd: root })
const win8 = await app8.firstWindow()
win8.on('dialog', (d) => {
  nativeDialogs += 1
  d.accept().catch(() => {})
})
win8.on('pageerror', (e) => pageErrors.push(e.message))
await win8.waitForSelector('.cm-content')
await win8.waitForTimeout(600)

const metaText = () => win8.textContent('#file-meta')
const nameText = () => win8.textContent('#file-name')
const statusText = () => win8.evaluate(() => document.querySelector('#status').textContent)
const editorText = () => win8.evaluate(() => document.querySelector('.cm-content').innerText)

const chip0 = await metaText()
check(
  '自动保存默认开启（新会话没有残留开关）',
  (await win8.textContent('#btn-autosave')).includes('开'),
  await win8.textContent('#btn-autosave')
)
check('编码芯片显示 UTF-8 与 CRLF', chip0.includes('UTF-8') && chip0.includes('CRLF'), chip0)

await win8.click('#file-meta')
await win8.waitForSelector('.mdf-menu')
const menuRoot = await menuLabels(win8)
check(
  '芯片点开后有编码两个入口与换行符选项',
  menuRoot.includes('以其他编码重新载入') && menuRoot.includes('以其他编码另存为') && menuRoot.includes('Unix (LF)'),
  JSON.stringify(menuRoot)
)
await win8.screenshot({ path: path.join(root, 'verify', 'encoding-menu.png') })
await win8.locator('.mdf-menu-item[data-menu-label="Unix (LF)"]').click()
await win8.waitForTimeout(250)
const chipLf = await metaText()
check('切到 LF 后芯片立即反映', chipLf.includes('LF') && !chipLf.includes('CRLF'), chipLf)
check('只换换行符也算未保存', (await nameText()).includes('•'), await nameText())

const afterAuto = await until(
  () => readSafe(FL_DOC),
  (text) => text !== null && !text.includes('\r\n'),
  9000
)
check('自动保存把换行符统一成 LF', afterAuto !== null && !afterAuto.includes('\r\n'), JSON.stringify(afterAuto))
check('自动保存后脏标记消失', !(await nameText()).includes('•'), await nameText())
check('状态栏说明自动保存', (await statusText()).includes('自动保存'), await statusText())

/* 以其他编码重新载入 */
// 残留的确认框会吃掉后面所有点击（Playwright 只会干等 30 秒），先把它报出来并按 Esc  dismiss
const blocking = await win8.evaluate(() => document.querySelector('.mdf-dialog')?.innerText.replace(/\s+/g, ' ') ?? '')
if (blocking !== '') {
  check('进入编码重开前没有对话框挡路', false, blocking.slice(0, 90))
  await win8.keyboard.press('Escape')
  await win8.waitForTimeout(200)
}
await win8.click('#file-meta')
await win8.locator('.mdf-menu-item[data-menu-label="以其他编码重新载入"]').click()
await win8.waitForTimeout(200)
const subReload = await menuLabels(win8)
check('重载入子页列出五个可选编码', subReload.length === 5 && subReload.includes('GBK'), JSON.stringify(subReload))
await win8.locator('.mdf-menu-item[data-menu-label="GBK"]').click()
await win8.waitForTimeout(500)
const garbled = await editorText()
check('按 GBK 重开后芯片显示 GBK', (await metaText()).includes('GBK'), await metaText())
check('UTF-8 正文按 GBK 解会走样', !garbled.includes('# 说明'), garbled.slice(0, 24))
check('强制重开本身不算未保存', !(await nameText()).includes('•'), await nameText())

await win8.click('#file-meta')
await win8.locator('.mdf-menu-item[data-menu-label="以其他编码重新载入"]').click()
await win8.locator('.mdf-menu-item[data-menu-label="UTF-8"]').click()
await win8.waitForTimeout(500)
check(
  '换回 UTF-8 后正文恢复',
  (await editorText()).includes('# 说明') && (await metaText()).includes('UTF-8'),
  await metaText()
)

await win8.click('#file-meta')
await win8.locator('.mdf-menu-item[data-menu-label="以其他编码另存为"]').click()
await win8.waitForTimeout(200)
const subSave = await menuLabels(win8)
check(
  '另存为子页含 UTF-8 (BOM)',
  subSave.includes('UTF-8 (BOM)') && subSave.includes('GB18030'),
  JSON.stringify(subSave)
)
await win8.keyboard.press('Escape')
await win8.waitForTimeout(120)
await win8.keyboard.press('Escape')
await win8.waitForTimeout(120)
check('Esc 能退出子页再关菜单', (await win8.locator('.mdf-menu').count()) === 0)

/* 自动保存关掉，后面的外部修改与冲突判定才有确定的时序 */
await win8.click('#btn-autosave')
check(
  '自动保存可切换',
  (await win8.textContent('#btn-autosave')).includes('关'),
  await win8.textContent('#btn-autosave')
)

/* 外部修改：干净的标签跟着磁盘走 */
const EXTERNAL_1 = '# 说明\r\n\r\n第一段\r\n\r\n外部加了一段\r\n'
writeFileSync(FL_DOC, EXTERNAL_1, 'utf8')
const reloaded = await until(editorText, (text) => text.includes('外部加了一段'))
check('干净标签遇到外部修改自动重新载入', reloaded.includes('外部加了一段'), reloaded.slice(0, 40))
check('自动重载不弹框', (await win8.locator('.mdf-dialog').count()) === 0)
check('状态栏说明自动重新载入', (await statusText()).includes('自动重新载入'), await statusText())

/* 外部修改：有未保存改动时给三条路 */
await win8.locator('.cm-line').first().click()
await win8.keyboard.press('End')
await win8.keyboard.type('（本地改动）')
await win8.waitForTimeout(200)
const EXTERNAL_2 = EXTERNAL_1.replace('外部加了一段', '外部又改了一段')
writeFileSync(FL_DOC, EXTERNAL_2, 'utf8')
await win8.waitForSelector('.mdf-dialog', { timeout: 9000 })
const externalButtons = await dialogButtons(win8)
check(
  '外部修改框有重新载入/保留/稍后',
  externalButtons.includes('重新载入磁盘版本') &&
    externalButtons.includes('保留我的版本') &&
    externalButtons.includes('稍后处理'),
  JSON.stringify(externalButtons)
)
await win8.screenshot({ path: path.join(root, 'verify', 'external-change.png') })
await answer(win8, '保留我的版本')
await win8.waitForTimeout(600)
check(
  '选保留后当前内容覆盖到磁盘',
  String(readSafe(FL_DOC)).includes('（本地改动）'),
  String(readSafe(FL_DOC)).slice(0, 50)
)

/* 保存冲突也走同一个框，并且这次选重新载入 */
await win8.locator('.cm-line').first().click()
await win8.keyboard.press('End')
await win8.keyboard.type('（还没保存）')
await win8.waitForTimeout(200)
const EXTERNAL_3 = EXTERNAL_2.replace('外部又改了一段', '外部最终版')
writeFileSync(FL_DOC, EXTERNAL_3, 'utf8')
await win8.waitForSelector('.mdf-dialog', { timeout: 9000 })
await answer(win8, '稍后处理')
await win8.waitForTimeout(250)
await saveDoc(win8)
await win8.waitForSelector('.mdf-dialog', { timeout: 5000 })
const conflictText = await dialogText(win8)
check('保存被拦下时说明是外部修改冲突', conflictText.includes('外部'), conflictText.slice(0, 60))
await answer(win8, '重新载入磁盘版本')
await win8.waitForTimeout(400)
check('冲突框选重新载入后回到磁盘内容', (await editorText()).includes('外部最终版'), (await editorText()).slice(0, 40))
check('冲突框选重新载入后不再是脏的', !(await nameText()).includes('•'), await nameText())

/* 关掉自动保存后不会偷偷写盘 */
await win8.locator('.cm-line').first().click()
await win8.keyboard.press('End')
await win8.keyboard.type('（不会自动写）')
await win8.waitForTimeout(4000)
check(
  '关闭自动保存后不写盘',
  !String(readSafe(FL_DOC)).includes('（不会自动写）'),
  String(readSafe(FL_DOC)).slice(0, 40)
)
check('未保存标记仍在', (await nameText()).includes('•'), await nameText())

/* 关闭标签：自定义确认框 */
await win8.locator('.tab-close').first().click()
await win8.waitForSelector('.mdf-dialog', { timeout: 5000 })
const closeButtons = await dialogButtons(win8)
check(
  '关闭标签框有保存/不保存/取消',
  closeButtons.includes('保存并关闭') && closeButtons.includes('不保存关闭') && closeButtons.includes('取消'),
  JSON.stringify(closeButtons)
)
await answer(win8, '取消')
await win8.waitForTimeout(300)
check(
  '点取消后标签还在',
  (await win8.locator('.tab').count()) === 1 && (await nameText()).includes('•'),
  await nameText()
)
await win8.locator('.tab-close').first().click()
await win8.waitForSelector('.mdf-dialog', { timeout: 5000 })
await answer(win8, '不保存关闭')
await win8.waitForTimeout(400)
check('不保存关闭后回到未命名标签', (await nameText()).includes('未命名'), await nameText())
check('不保存关闭没有写盘', !String(readSafe(FL_DOC)).includes('（不会自动写）'), String(readSafe(FL_DOC)).slice(0, 40))
check('关闭脏标签没有触发原生对话框', nativeDialogs === 0, `count=${nativeDialogs}`)
await app8.close()

/* 崩溃草稿：硬杀进程后重启应能恢复 */
const DRAFT_DOC = path.join(flDir, '草稿.md')
writeFileSync(DRAFT_DOC, '# 草稿\n', 'utf8')
clearDrafts()

const app9 = await _electron.launch({ executablePath: require('electron'), args: [root, DRAFT_DOC], cwd: root })
const win9 = await app9.firstWindow()
win9.on('pageerror', (e) => pageErrors.push(e.message))
await win9.waitForSelector('.cm-content')
await win9.waitForTimeout(600)
if ((await win9.textContent('#btn-autosave')).includes('开')) await win9.click('#btn-autosave')
await win9.locator('.cm-line').first().click()
await win9.keyboard.press('End')
await win9.keyboard.type('（崩溃前的改动）')
await win9.waitForTimeout(2000)
check('未保存内容写成崩溃草稿', draftCount() >= 1, `drafts=${draftCount()}`)
killApp(app9)

const app10 = await _electron.launch({ executablePath: require('electron'), args: [root, DRAFT_DOC], cwd: root })
const win10 = await app10.firstWindow()
win10.on('pageerror', (e) => pageErrors.push(e.message))
await win10.waitForSelector('.mdf-dialog', { timeout: 9000 })
const draftText = await win10.evaluate(
  () => document.querySelector('.mdf-dialog')?.innerText.replace(/\s+/g, ' ') ?? ''
)
check('重启后提示有内容没保存下来', draftText.includes('上次有内容没保存下来'), draftText.slice(0, 60))
check('草稿框列出文件名', draftText.includes('草稿.md'), draftText.slice(0, 90))
await win10.screenshot({ path: path.join(root, 'verify', 'draft-restore.png') })
await win10.locator(`.mdf-dialog-button:text-is("恢复这些草稿")`).click()
await win10.waitForTimeout(500)
const restoredText = await win10.evaluate(() => document.querySelector('.cm-content').innerText)
check('草稿内容回到编辑器', restoredText.includes('（崩溃前的改动）'), restoredText.slice(0, 40))
check('恢复后标为未保存', (await win10.textContent('#file-name')).includes('•'), await win10.textContent('#file-name'))
await saveDoc(win10)
await win10.waitForTimeout(700)
check('保存后草稿被清理', draftCount() === 0, `drafts=${draftCount()}`)
check(
  '崩溃内容落到文件里',
  String(readSafe(DRAFT_DOC)).includes('（崩溃前的改动）'),
  String(readSafe(DRAFT_DOC)).slice(0, 40)
)
await app10.close()

/* 关窗确认：取消留下窗口，放弃修改才放行 */
const CLOSE_DOC = path.join(flDir, '关闭.md')
writeFileSync(CLOSE_DOC, '# 关闭测试\n', 'utf8')
clearDrafts()

const app11 = await _electron.launch({ executablePath: require('electron'), args: [root, CLOSE_DOC], cwd: root })
const win11 = await app11.firstWindow()
win11.on('pageerror', (e) => pageErrors.push(e.message))
await win11.waitForSelector('.cm-content')
await win11.waitForTimeout(600)
await win11.locator('.cm-line').first().click()
await win11.keyboard.press('End')
await win11.keyboard.type('（没保存）')
await win11.waitForTimeout(300)
const closing11 = app11.close().catch(() => {})
await win11.waitForSelector('.mdf-dialog', { timeout: 9000 })
const quitText = await win11.evaluate(() => document.querySelector('.mdf-dialog')?.innerText.replace(/\s+/g, ' ') ?? '')
check('关窗走应用内确认框', quitText.includes('关闭窗口前保存？'), quitText.slice(0, 60))
check(
  '关窗框给出全部保存/放弃/取消',
  quitText.includes('全部保存并关闭') && quitText.includes('放弃修改并关闭'),
  quitText.slice(0, 120)
)
await win11.locator(`.mdf-dialog-button:text-is("取消")`).click()
await win11.waitForTimeout(400)
const alive = await win11.evaluate(() => document.querySelector('#file-name').textContent).catch(() => 'closed')
check('点取消后窗口还活着', String(alive).includes('关闭.md'), String(alive))
check('关窗确认没有用原生对话框', nativeDialogs === 0, `count=${nativeDialogs}`)
killApp(app11)
// 进程被硬杀后 Playwright 的 close() 可能永远不 settle，只能限时等它
await Promise.race([closing11, new Promise((resolve) => setTimeout(resolve, 3000))])

// app11 是被硬杀的，它留下的崩溃草稿会在 app12 启动时先弹恢复框挡住点击：这里当作"用户已丢弃"清掉
clearDrafts()

const app12 = await _electron.launch({ executablePath: require('electron'), args: [root, CLOSE_DOC], cwd: root })
const win12 = await app12.firstWindow()
win12.on('pageerror', (e) => pageErrors.push(e.message))
await win12.waitForSelector('.cm-content')
await win12.waitForTimeout(600)
await win12.locator('.cm-line').first().click()
await win12.keyboard.press('End')
await win12.keyboard.type('（准备放弃）')
await win12.waitForTimeout(1800)
const closing12 = app12.close().catch(() => {})
await win12.waitForSelector('.mdf-dialog', { timeout: 9000 })
await win12.locator(`.mdf-dialog-button:text-is("放弃修改并关闭")`).click()
const gone = await until(
  () => win12.isClosed(),
  (closed) => closed === true,
  9000
)
check('放弃修改后窗口真的关了', gone === true, String(gone))
check(
  '放弃修改没有写盘',
  !String(readSafe(CLOSE_DOC)).includes('（准备放弃）'),
  String(readSafe(CLOSE_DOC)).slice(0, 40)
)
check('主动放弃会连草稿一起丢', draftCount() === 0, `drafts=${draftCount()}`)
await Promise.race([closing12, new Promise((resolve) => setTimeout(resolve, 3000))])

/* 导出与文档检查：资源复制/内联、目录与主题、纯文本副本，以及检查面板、文件列表与侧边栏开关 */
const expDir = mkdtempSync(path.join(tmpdir(), 'mdforge-export-'))
mkdirSync(path.join(expDir, 'assets'), { recursive: true })
writeFileSync(path.join(expDir, 'assets', 'p1.png'), makePng(640, 120))
writeFileSync(path.join(expDir, 'assets', 'orphan.png'), makePng(8, 8))
const EXP_DOC = path.join(expDir, '导出.md')
const EXP_HTML = path.join(expDir, 'out-copy.html')
const EXP_TOC = path.join(expDir, 'out-toc.html')
const EXP_DARK = path.join(expDir, 'out-dark.html')
const EXP_MKMDT = path.join(expDir, 'out-mdmdt.html')
const EXP_INLINE = path.join(expDir, 'out-inline.html')
const EXP_PDF = path.join(expDir, 'out.pdf')
const EXP_TXT = path.join(expDir, 'out.txt')
const EXP_MD = path.join(expDir, 'out.md')
const EXP_SOURCE = [
  '# 导出测试',
  '',
  '![宽图](assets/p1.png "w=320")',
  '',
  '![丢了](assets/missing.png)',
  '',
  '[去](gone.md) 与 [锚点](#不存在)',
  '',
  '### 三级开头',
  '',
  '正文 **加粗** 与 `代码`。',
  '',
  '参考 [官网](https://example.com) 了解更多。',
  ''
].join('\r\n')
writeFileSync(EXP_DOC, EXP_SOURCE, 'utf8')

const app13 = await _electron.launch({ executablePath: require('electron'), args: [root, EXP_DOC], cwd: root })
const win13 = await app13.firstWindow()
win13.on('dialog', (d) => {
  nativeDialogs += 1
  d.accept().catch(() => {})
})
win13.on('pageerror', (e) => pageErrors.push(e.message))
await win13.waitForSelector('.cm-content')
await win13.waitForTimeout(600)

/* 别人（或上一次没跑完的验证）留下的崩溃草稿会弹恢复框，把这一节的点击全挡住：先丢掉 */
if ((await win13.locator('.mdf-dialog-backdrop').count()) > 0) {
  const text = await win13.evaluate(() => document.querySelector('.mdf-dialog')?.innerText.replace(/\s+/g, ' ') ?? '')
  console.log(`  跳过上次运行留下的恢复提示：${text.slice(0, 40)}`)
  await answer(win13, '全部丢弃')
  await win13.waitForTimeout(300)
}

/* 系统保存框点不到：换成按顺序交出预先选好的路径 */
await app13.evaluate(
  ({ dialog }, targets) => {
    let index = 0
    dialog.showSaveDialog = async () => {
      const filePath = targets[Math.min(index, targets.length - 1)]
      index += 1
      return { canceled: false, filePath }
    }
  },
  [EXP_HTML, EXP_TOC, EXP_DARK, EXP_MKMDT, EXP_INLINE, EXP_PDF, EXP_TXT, EXP_MD]
)

const statusText13 = () => win13.textContent('#status')
const menuMark = (label) =>
  win13.evaluate((name) => {
    const item = [...document.querySelectorAll('.mdf-menu-item')].find((el) => el.dataset.menuLabel === name)
    if (!item) return 'missing'
    return item.querySelector('.mdf-menu-mark')?.textContent ?? ''
  }, label)

async function ensureMenuClosed() {
  for (let step = 0; step < 3 && (await win13.locator('.mdf-menu').count()) > 0; step++) {
    await win13.keyboard.press('Escape')
    await win13.waitForTimeout(150)
  }
}

async function setOption(label) {
  await win13.locator(`.mdf-menu-item[data-menu-label="${label}"]`).click()
  await win13.waitForTimeout(200)
}

async function ensureOptionOff(label) {
  if ((await menuMark(label)) === '✓') await setOption(label)
}

/* 导出动作在菜单栏：文件 → 导出 ▸ → 目标；导出选项在再下一层浮层里 */
async function openExportFlyout() {
  await ensureMenuClosed()
  await win13.click('.mdf-menubar-button[data-menu="file"]')
  await win13.waitForSelector('.mdf-menu--bar')
  await win13.locator('.mdf-menu-item[data-menu-label="导出"]').click()
  await win13.waitForSelector('.mdf-menu--sub')
}

async function openOptions() {
  await openExportFlyout()
  await win13.locator('.mdf-menu-item[data-menu-label="导出选项"]').click()
  await win13.waitForTimeout(200)
}

/* 导出选项随会话持久化：先把基线钉死，否则上一轮留下的内联/衬排会让这一节的断言指错方向 */
await openOptions()
await setOption('复制图片')
await setOption('默认')
await ensureOptionOff('在开头插入目录')
await ensureMenuClosed()

async function exportTo(label, marker) {
  await openExportFlyout()
  await win13.locator(`.mdf-menu-item[data-menu-label="${label}"]`).click()
  return until(statusText13, (text) => text.includes(marker), 25000)
}

const menu0 = await (async () => {
  await openExportFlyout()
  const labels = await win13.$$eval('.mdf-menu--sub .mdf-menu-item', (els) => els.map((el) => el.dataset.menuLabel))
  await win13.keyboard.press('Escape')
  await win13.waitForTimeout(150)
  return labels
})()
check(
  '导出浮层给出四种目标与选项页',
  ['导出 HTML…', '导出 PDF…', '导出 Markdown 副本…', '导出纯文本…', '导出选项'].every((label) => menu0.includes(label)),
  JSON.stringify(menu0)
)
check('一次 Esc 收起整条菜单链', (await win13.locator('.mdf-menu').count()) === 0)

const copyNote = await exportTo('导出 HTML…', 'out-copy')
const copyHtml = existsSync(EXP_HTML) ? readFileSync(EXP_HTML, 'utf8') : ''
check(
  '状态栏报告复制了图片',
  copyNote.includes('复制 1 张图片') && copyNote.includes('1 处图片引用找不到文件'),
  copyNote
)
check(
  '图片复制到导出文件旁边并改写地址',
  existsSync(path.join(expDir, 'out-copy.assets', 'p1.png')) && copyHtml.includes('src="out-copy.assets/p1.png"'),
  copyHtml.slice(copyHtml.indexOf('<img'), copyHtml.indexOf('<img') + 90)
)
check('宽度提示还原成 width 属性', copyHtml.includes('width="320"'))
check('找不到的图片保持原样', copyHtml.includes('src="assets/missing.png"'))
check(
  '默认主题与纸张写进样式',
  copyHtml.includes('@page { size: A4; margin: 20mm; }') && copyHtml.includes('-apple-system')
)
check(
  '导出没有改动文档，也不需要原生对话框',
  nativeDialogs === 0 && (await win13.textContent('#file-name')).includes('导出.md')
)

await openOptions()
const optionLabels = await menuLabels(win13)
check(
  '选项页列出资源、目录、主题、纸张与页边距',
  [
    '复制图片',
    '内联 base64',
    '保持原路径',
    '在开头插入目录',
    '默认',
    '衬排',
    '朴素',
    '深色',
    'mdmdt',
    'A4',
    'Letter',
    '窄 (12 mm)'
  ].every((label) => optionLabels.includes(label)),
  JSON.stringify(optionLabels)
)
await win13.locator('.mdf-menu-item[data-menu-label="在开头插入目录"]').click()
await win13.waitForTimeout(200)
check(
  '选项点完菜单不关，勾选状态立即反映',
  (await win13.locator('.mdf-menu-item[data-menu-label="在开头插入目录"]').isVisible()) &&
    (await menuMark('在开头插入目录')) === '✓',
  await menuMark('在开头插入目录')
)
await win13.locator('.mdf-menu-item[data-menu-label="衬排"]').click()
await win13.waitForTimeout(200)
await win13.keyboard.press('Escape')
await win13.waitForTimeout(200)
const tocNote = await exportTo('导出 HTML…', 'out-toc')
const tocHtml = existsSync(EXP_TOC) ? readFileSync(EXP_TOC, 'utf8') : ''
check('第二次导出用的是新选项', tocNote.includes('out-toc') && !tocNote.includes('out-copy'), tocNote)
check('目录按标题层级生成锚点', tocHtml.includes('<nav class="mdf-toc"') && tocHtml.includes('href="#三级开头"'))
check('主题换成了衬排', tocHtml.includes('Georgia') && !tocHtml.includes('-apple-system'))
check('目录同样带上图片副本', existsSync(path.join(expDir, 'out-toc.assets', 'p1.png')))

await openOptions()
await win13.locator('.mdf-menu-item[data-menu-label="深色"]').click()
await win13.waitForTimeout(200)
await win13.keyboard.press('Escape')
await win13.waitForTimeout(200)
const darkNote = await exportTo('导出 HTML…', 'out-dark')
const darkHtml = existsSync(EXP_DARK) ? readFileSync(EXP_DARK, 'utf8') : ''
check(
  '深色导出主题写进样式',
  darkHtml.includes('color-scheme: dark') && darkHtml.includes('background: #1b1d1f'),
  darkNote
)
await openOptions()
await win13.locator('.mdf-menu-item[data-menu-label="mdmdt"]').click()
await win13.waitForTimeout(200)
await win13.keyboard.press('Escape')
await win13.waitForTimeout(200)
const mdmdtNote = await exportTo('导出 HTML…', 'out-mdmdt')
const mdmdtHtml = existsSync(EXP_MKMDT) ? readFileSync(EXP_MKMDT, 'utf8') : ''
check(
  'mdmdt 导出主题写进样式',
  mdmdtHtml.includes("'Microsoft YaHei UI'") && mdmdtHtml.includes('background: rgba(62, 105, 215, 0.06)'),
  mdmdtNote
)
await openOptions()
await win13.locator('.mdf-menu-item[data-menu-label="默认"]').click()
await win13.waitForTimeout(200)
await win13.keyboard.press('Escape')
await win13.waitForTimeout(200)

await openOptions()
await win13.locator('.mdf-menu-item[data-menu-label="内联 base64"]').click()
await win13.waitForTimeout(200)
await win13.keyboard.press('Escape')
await win13.waitForTimeout(200)
const inlineNote = await exportTo('导出 HTML…', 'out-inline')
const inlineHtml = existsSync(EXP_INLINE) ? readFileSync(EXP_INLINE, 'utf8') : ''
check('内联模式把图片写成数据地址', inlineHtml.includes('src="data:image/png;base64,'), inlineNote)
check('内联后不再产生资源目录', !existsSync(path.join(expDir, 'out-inline.assets')))

const pdfNote = await exportTo('导出 PDF…', 'out.pdf')
const pdfBytes = existsSync(EXP_PDF) ? readFileSync(EXP_PDF) : Buffer.alloc(0)
check(
  'PDF 真的打印出来了',
  pdfBytes.length > 2000 && pdfBytes.subarray(0, 4).toString() === '%PDF',
  `bytes=${pdfBytes.length}`
)
check('PDF 也报告了内联数量', pdfNote.includes('内联 1 张图片'), pdfNote)

await exportTo('导出纯文本…', 'out.txt')
const txtOut = existsSync(EXP_TXT) ? readFileSync(EXP_TXT, 'utf8') : ''
check(
  '纯文本去掉了标记但留下文字',
  txtOut.includes('正文 加粗 与 代码') &&
    txtOut.includes('宽图') &&
    !txtOut.includes('**') &&
    !txtOut.includes('](assets'),
  JSON.stringify(txtOut.slice(0, 40))
)
const mdNote = await exportTo('导出 Markdown 副本…', 'out.md')
const mdOut = existsSync(EXP_MD) ? readFileSync(EXP_MD, 'utf8') : ''
check(
  'Markdown 副本与源文件一致',
  mdOut === EXP_SOURCE,
  `${mdNote.slice(0, 30)} | 长度 ${mdOut.length}/${EXP_SOURCE.length}`
)
await win13.screenshot({ path: path.join(root, 'verify', 'export-menu.png') })

/* 菜单栏：主题切换与源代码模式 */
const dataTheme = () => win13.evaluate(() => document.documentElement.dataset.theme)
const bodyBg = () => win13.evaluate(() => getComputedStyle(document.body).backgroundColor)
await win13.click('.mdf-menubar-button[data-menu="theme"]')
await win13.waitForSelector('.mdf-menu--bar')
await win13.locator('.mdf-menu-item[data-menu-label="深色"]').click()
await win13.waitForTimeout(250)
check('主题菜单切到深色', (await dataTheme()) === 'dark', await dataTheme())
check('深色选项立即打勾', (await menuMark('深色')) === '✓', await menuMark('深色'))
const darkSkin = await win13.evaluate(() => ({
  bg: getComputedStyle(document.body).backgroundColor,
  font: getComputedStyle(document.querySelector('.cm-scroller')).fontFamily
}))
check(
  '深色即 mdmdt-dark 外观（底色 + 雅黑正文）',
  darkSkin.bg === 'rgb(27, 27, 31)' && darkSkin.font.includes('YaHei'),
  JSON.stringify(darkSkin)
)
await win13.screenshot({ path: path.join(root, 'verify', 'theme-dark.png') })
await win13.locator('.mdf-menu-item[data-menu-label="浅色"]').click()
await win13.waitForTimeout(250)
check('主题菜单切回浅色', (await dataTheme()) === 'light', await dataTheme())
check('浅色即 mdmdt-light 外观（底色 #fafafc）', (await bodyBg()) === 'rgb(250, 250, 252)', await bodyBg())
await win13.screenshot({ path: path.join(root, 'verify', 'theme-light.png') })
await win13.keyboard.press('Escape')
await win13.waitForTimeout(150)

await win13.click('.mdf-menubar-button[data-menu="view"]')
await win13.waitForSelector('.mdf-menu--bar')
await win13.locator('.mdf-menu-item[data-menu-label="源代码模式"]').click()
await win13.waitForTimeout(350)
const sourceView = await win13.evaluate(() => ({
  previews: document.querySelectorAll('.mdf-preview-img').length,
  raw: document.querySelector('.cm-content').innerText.includes('![宽图](assets/p1.png')
}))
check('源代码模式隐藏渲染结果', sourceView.previews === 0 && sourceView.raw, JSON.stringify(sourceView))
await win13.click('.mdf-menubar-button[data-menu="view"]')
await win13.waitForSelector('.mdf-menu--bar')
check('重开菜单勾上源代码模式', (await menuMark('源代码模式')) === '✓', await menuMark('源代码模式'))
await win13.locator('.mdf-menu-item[data-menu-label="源代码模式"]').click()
await win13.waitForTimeout(350)
check('再切一次恢复渲染', (await win13.locator('.mdf-preview-img').count()) >= 1)
await win13.screenshot({ path: path.join(root, 'verify', 'menubar.png') })

/* 文档检查面板：标签位让给了文件页，入口在「视图 → 文档检查」 */
await ensureMenuClosed()
await win13.click('.mdf-menubar-button[data-menu="view"]')
await win13.waitForSelector('.mdf-menu--bar')
await win13.locator('.mdf-menu-item[data-menu-label="文档检查"]').click()
await win13.waitForSelector('.issue-item', { timeout: 9000 })
const heads = await win13.$$eval('.issue-group-head', (els) => els.map((el) => el.textContent))
check(
  '检查面板按缺图/坏链/跳级/未引用分组',
  heads.some((text) => text.includes('缺图 1')) &&
    heads.some((text) => text.includes('坏链 2')) &&
    heads.some((text) => text.includes('标题跳级 1')) &&
    heads.some((text) => text.includes('未引用资源 1')),
  JSON.stringify(heads)
)
const details = await win13.$$eval('.issue-detail', (els) => els.map((el) => el.textContent))
check(
  '缺图指出文件不存在',
  details.some((text) => text.includes('第 5 行') && text.includes('文件不存在')),
  JSON.stringify(details)
)
check(
  '文内锚点失效被当成坏链',
  details.some((text) => text.includes('#不存在'))
)
check(
  '标题跳级说明跳了几级',
  details.some((text) => text.includes('H1') && text.includes('H3'))
)
check(
  '未引用资源列出孤立图片',
  details.some((text) => text.includes('正文里没有引用'))
)
check(
  '检查结果给问题总数',
  (await win13.textContent('.issues-summary')).includes('5 个问题'),
  await win13.textContent('.issues-summary')
)
check(
  '笔记说明本地引用查了几个、外部链接不联网',
  (await win13.textContent('.issues-note')).includes('3 个本地引用') &&
    (await win13.textContent('.issues-note')).includes('1 个外部链接未联网核对'),
  await win13.textContent('.issues-note')
)

await win13.locator('.issue-item[data-issue-kind="missing-image"]').first().click()
await win13.waitForTimeout(400)
check(
  '点问题跳到自己那一行',
  (await win13.textContent('#status-metrics')).includes('行 5'),
  await win13.textContent('#status-metrics')
)
const unusedLine = await win13
  .locator('.issue-item[data-issue-kind="unused-asset"]')
  .first()
  .getAttribute('data-issue-line')
check('未引用资源没有行号，只给显示入口', unusedLine === '0', `line=${unusedLine}`)
await win13.screenshot({ path: path.join(root, 'verify', 'issues.png') })

/* 后面要留一个"脏标签"验证关闭确认：中途的菜单往返会撞上 3 秒自动保存把文档写干净，先关掉 */
if ((await win13.textContent('#btn-autosave')).includes('开')) {
  await win13.click('#btn-autosave')
  await win13.waitForTimeout(200)
}

await win13.locator('.cm-line').first().click()
await win13.keyboard.type('（改动）')
await win13.waitForTimeout(500)
check(
  '正文改动后提示结果过期',
  (await win13.textContent('.issues-note')).includes('建议重新检查'),
  await win13.textContent('.issues-note')
)

/* 打开文件夹 → 文件页预览列表 → 视图侧边栏开关 */
const folderFixture = path.join(workDir, '笔记文件夹')
mkdirSync(folderFixture, { recursive: true })
writeFileSync(path.join(folderFixture, 'day01.md'), '# Day 1 命令行入门\n\n第一条笔记。\n', 'utf8')
writeFileSync(path.join(folderFixture, 'day02.md'), '# Day 2 环境初始化\n\n第二条笔记。\n', 'utf8')
await app13.evaluate(({ dialog }, dir) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
}, folderFixture)

await ensureMenuClosed()
await win13.click('.mdf-menubar-button[data-menu="file"]')
await win13.waitForSelector('.mdf-menu--bar')
check('文件菜单有「打开文件夹…」', (await menuLabels(win13)).includes('打开文件夹…'), '')
await win13.locator('.mdf-menu-item[data-menu-label="打开文件夹…"]').click()
await win13.waitForSelector('.file-item', { timeout: 9000 })
const fileItems = await win13.$$eval('.file-item', (els) =>
  els.map((el) => ({
    name: el.querySelector('.file-name')?.innerText ?? '',
    preview: el.querySelector('.file-preview')?.textContent ?? ''
  }))
)
check('文件页列出文件夹里的 md', fileItems.length === 2, JSON.stringify(fileItems))
check(
  '列表按名称排序并带首行预览',
  fileItems[0]?.name.includes('day01.md') &&
    fileItems[0]?.preview.includes('Day 1 命令行入门') &&
    fileItems[1]?.name.includes('day02.md') &&
    fileItems[1]?.preview.includes('Day 2 环境初始化'),
  JSON.stringify(fileItems)
)
check(
  '打开文件夹后自动切到文件页',
  await win13.evaluate(
    () => document.querySelector('.side-tab[data-side-tab="files"]')?.classList.contains('is-active') === true
  )
)

await win13.locator('.file-item').first().click()
await win13.waitForTimeout(500)
check('点列表项在标签里打开', (await win13.textContent('#file-name')).includes('day01.md'), await win13.textContent('#file-name'))
check(
  '当前文件在列表里高亮',
  (await win13.$$eval('.file-item.is-active', (els) => els.map((el) => el.dataset.filePath))).some((p) =>
    p?.endsWith('day01.md')
  )
)
await win13.screenshot({ path: path.join(root, 'verify', 'files-panel.png') })
await win13.locator('.tab-close').nth(1).click()
await win13.waitForTimeout(300)

/* 视图 → 侧边栏开关 */
await win13.click('.mdf-menubar-button[data-menu="view"]')
await win13.waitForSelector('.mdf-menu--bar')
check('视图菜单有侧边栏开关且默认勾选', (await menuMark('侧边栏')) === '✓', await menuMark('侧边栏'))
await win13.locator('.mdf-menu-item[data-menu-label="侧边栏"]').click()
await win13.waitForTimeout(250)
const hiddenBox = await win13.locator('#outline').boundingBox()
check('关掉侧边栏后整列隐藏', hiddenBox === null, JSON.stringify(hiddenBox))
await win13.locator('.mdf-menu-item[data-menu-label="侧边栏"]').click()
await win13.waitForTimeout(250)
const shownBox = await win13.locator('#outline').boundingBox()
check('再点一次又显示', shownBox !== null && shownBox.width > 0, JSON.stringify(shownBox))
await ensureMenuClosed()

await win13.locator('.tab-close').first().click()
await win13.waitForSelector('.mdf-dialog')
await answer(win13, '不保存关闭')
await win13.waitForTimeout(300)
await app13.close()

/* 重启后从「最近打开」进：会话里的历史路径要重新授权，不能报"未经用户选择授权" */
const recentDir = mkdtempSync(path.join(tmpdir(), 'mdforge-recent-'))
const recentFile = path.join(recentDir, '昨日笔记.md')
writeFileSync(recentFile, '# 昨天的笔记\n\n重启后从最近打开进来。\n', 'utf8')
clearDrafts()
mkdirSync(userData, { recursive: true })
writeFileSync(
  path.join(userData, 'session.json'),
  JSON.stringify({ openDocs: [], active: null, recents: [recentFile], autoSave: false }, null, 2),
  'utf8'
)
const app14 = await _electron.launch({ executablePath: require('electron'), args: [root], cwd: root })
const win14 = await app14.firstWindow()
win14.on('dialog', (d) => {
  nativeDialogs += 1
  d.accept().catch(() => {})
})
win14.on('pageerror', (e) => pageErrors.push(e.message))
await win14.waitForSelector('.cm-content')
await win14.waitForTimeout(600)
await win14.click('.mdf-menubar-button[data-menu="file"]')
await win14.waitForSelector('.mdf-menu--bar')
await win14.click('.mdf-menu-item[data-menu-label="最近打开"]')
await win14.waitForSelector('.mdf-menu--sub .mdf-menu-item[data-menu-label="昨日笔记.md"]', { timeout: 5000 })
await win14.locator('.mdf-menu--sub .mdf-menu-item[data-menu-label="昨日笔记.md"]').click()
await win14.waitForTimeout(600)
const recentStatus = await win14.textContent('#status')
check(
  '重启后从最近打开能读到文件',
  (await win14.textContent('#file-name')).includes('昨日笔记.md'),
  await win14.textContent('#file-name')
)
check('最近打开不再报无权限', !recentStatus.includes('拒绝访问'), recentStatus)
await app14.close()

const windowStateFile = path.join(process.env.APPDATA ?? homedir(), 'mdforge-editor', 'window-state.json')
check('关闭时记住窗口尺寸位置', existsSync(windowStateFile), windowStateFile)
check('全流程不使用原生对话框', nativeDialogs === 0, `count=${nativeDialogs}`)
check('渲染进程无未捕获错误', pageErrors.length === 0, pageErrors.join(' | '))
if (consoleErrors.length > 0) console.log(`控制台错误：\n  ${consoleErrors.slice(0, 6).join('\n  ')}`)

await app.close()

console.log(failures.length === 0 ? '\n端到端验证全部通过' : `\n失败项：${failures.join(', ')}`)
process.exitCode = failures.length === 0 ? 0 : 1
