import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
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

/** 造一张指定尺寸的 PNG；noise=true 时填伪随机像素，让无损压缩压不下去（测压缩用） */
function makePng(width, height, noise = false) {
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
  const noiseBytes = noise ? randomBytes(width * height * 3) : Buffer.alloc(0)
  for (let y = 0; y < height; y++) {
    rows.push(Buffer.from([0]))
    const line = Buffer.alloc(width * 3)
    if (noise) {
      noiseBytes.copy(line, 0, y * width * 3, (y + 1) * width * 3)
    } else {
      line.fill(0x66)
    }
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
  /* 自定义导出主题与页面模板也清掉：不然后面的用例会读到上一轮留下的列表 */
  rmSync(path.join(userData, 'export-styles'), { recursive: true, force: true })
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
  check(
    '菜单栏替换原按钮行',
    barButtons.join(',') === '文件,编辑,段落,格式,视图,导航,主题,帮助',
    JSON.stringify(barButtons)
  )
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

/* 视图设置：字号与编辑区宽度即时生效，勾选也要在同一份菜单里跟着走 */
async function pickViewItem(submenu, item) {
  await win3.click('.mdf-menubar-button[data-menu="view"]')
  await win3.waitForSelector('.mdf-menu--bar')
  await win3.locator(`.mdf-menu--bar .mdf-menu-item[data-menu-label="${submenu}"]`).click()
  await win3.waitForTimeout(200)
  await win3.locator(`.mdf-menu--sub .mdf-menu-item[data-menu-label="${item}"]`).click()
  await win3.waitForTimeout(200)
  const mark = await win3.evaluate((label) => {
    const found = [...document.querySelectorAll('.mdf-menu--sub .mdf-menu-item')].find(
      (el) => el.dataset.menuLabel === label
    )
    return found?.querySelector('.mdf-menu-mark')?.textContent ?? ''
  }, item)
  await win3.keyboard.press('Escape')
  await win3.waitForTimeout(150)
  return mark
}
const fontMark = await pickViewItem('字体大小', '大 (15 px)')
check('字号菜单勾选即时更新', fontMark === '✓', fontMark)
const fontNow = await win3.evaluate(() => getComputedStyle(document.querySelector('.cm-scroller')).fontSize)
check('字号菜单立即生效', fontNow === '15px', fontNow)
const widthMark = await pickViewItem('编辑区宽度', '中 (900 px)')
check('编辑区宽度勾选即时更新', widthMark === '✓', widthMark)
const widthNow = await win3.evaluate(() => getComputedStyle(document.querySelector('.cm-content')).maxWidth)
check('编辑区宽度菜单立即生效', widthNow === '900px', widthNow)
await win3.screenshot({ path: path.join(root, 'verify', 'view-settings.png') })
const fontBackMark = await pickViewItem('字体大小', '标准 (14 px)')
check('字号勾选能移回标准', fontBackMark === '✓', fontBackMark)
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

/* 括号配对 / 反引号围栏 / 语言补全：输入手感 */
await replaceAll(true, '配对')
await win3.keyboard.type('(中')
await win3.waitForTimeout(150)
l3 = await readLines(win3)
check('左括号自动补右括号，输入落在括号里', l3[0] === '配对(中)', l3[0])
await win3.keyboard.type(')')
await win3.waitForTimeout(120)
l3 = await readLines(win3)
check('补出的右括号被跳过而不是叠加', l3[0] === '配对(中)', l3[0])

await replaceAll(true, '围栏')
await win3.keyboard.type('```')
await win3.waitForTimeout(150)
l3 = await readLines(win3)
check('连敲三个反引号原样落字（围栏不被配对撑成四个）', l3[0] === '围栏```', l3[0])

await replaceAll(true, '标签')
await win3.keyboard.type(' <di')
await win3.waitForTimeout(500)
const popupCount = await win3.locator('.cm-tooltip-autocomplete').count()
check('输入 <di 弹出 HTML 标签补全', popupCount >= 1, `popups=${popupCount}`)
await win3.keyboard.press('Escape')
await win3.waitForTimeout(200)

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

/* 折叠槽：可折叠的行（代码块/章节）出现标记，点一下收拢、再点展开 */
const foldTarget = await win7.evaluate(() => {
  const els = [...document.querySelectorAll('.cm-foldGutter .cm-gutterElement')]
  for (const el of els) {
    const span = el.querySelector('span')
    if (!span || getComputedStyle(el).visibility === 'hidden') continue
    const box = span.getBoundingClientRect()
    if (box.width > 0) return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }
  return null
})
check('折叠槽出现折叠标记', foldTarget !== null, JSON.stringify(foldTarget))
if (foldTarget) {
  await win7.mouse.click(foldTarget.x, foldTarget.y)
  await win7.waitForTimeout(300)
  check('点折叠标记能收拢代码块', (await win7.locator('.cm-foldPlaceholder').count()) >= 1, '')
  await win7.mouse.click(foldTarget.x, foldTarget.y)
  await win7.waitForTimeout(300)
  check('再点一次恢复展开', (await win7.locator('.cm-foldPlaceholder').count()) === 0, '')
}

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

/* 表格结构按钮：悬停行首/列表头浮出加删按钮，落字后撤销回原样 */
const rowCount0 = await win7.locator('.mdf-table-grid tbody tr').count()
await win7.locator('.mdf-table-grid tbody tr').first().hover()
await win7.locator('.mdf-table-grid tbody tr').first().locator('[data-op="row-add"]').click()
await win7.waitForTimeout(350)
check('行首 ＋ 插入一条空行', (await win7.locator('.mdf-table-grid tbody tr').count()) === rowCount0 + 1, '')

const colCount0 = await win7.locator('.mdf-table-grid thead th').count()
await win7.locator('.mdf-table-grid thead th').first().hover()
await win7.locator('.mdf-table-grid thead th').first().locator('[data-op="col-add"]').click()
await win7.waitForTimeout(350)
check('列头 ＋ 插入一列', (await win7.locator('.mdf-table-grid thead th').count()) === colCount0 + 1, '')
await win7.screenshot({ path: path.join(root, 'verify', 'table-ops.png') })

await win7.locator('.mdf-table-grid tbody tr').first().hover()
await win7.locator('.mdf-table-grid tbody tr').first().locator('[data-op="row-del"]').click()
await win7.waitForTimeout(350)
check('行首 － 删掉一行', (await win7.locator('.mdf-table-grid tbody tr').count()) === rowCount0, '')

await win7.locator('.mdf-table-grid thead th').nth(1).hover()
await win7.locator('.mdf-table-grid thead th').nth(1).locator('[data-op="col-del"]').click()
await win7.waitForTimeout(350)
check('列头 － 删掉一列', (await win7.locator('.mdf-table-grid thead th').count()) === colCount0, '')

for (let step = 0; step < 4; step++) {
  await win7.keyboard.press('Control+z')
  await win7.waitForTimeout(200)
}
const restoredCell7 = await win7.evaluate(() => document.querySelector('.mdf-table-grid tbody td')?.textContent ?? '')
check(
  '四个结构操作都进了撤销栈，撤销后回到原表格',
  restoredCell7 === '苹果' && (await win7.locator('.mdf-table-grid tbody tr').count()) === rowCount0,
  restoredCell7
)

/* 粘贴一张 Markdown 表格（光标停在表格末尾）：网格常驻、单元格去掉标记；走进内部才切源码 */
const PASTED_TABLE = [
  '| 优先级 | 功能 | 价值 |',
  '| --- | --- | --- |',
  '| P0 | **工作区全文搜索与批量替换** | 目前 [folder.ts](E:/DATA_FILE/File/MDForge/mdforge-editor/src/main/fs/folder.ts) 只列出文件夹直接子级 |'
].join('\n')
await win7.locator('.cm-content').focus()
await win7.keyboard.press('Control+End')
await win7.waitForTimeout(150)
await win7.evaluate((text) => {
  const content = document.querySelector('.cm-content')
  const data = new DataTransfer()
  data.setData('text/plain', text)
  content.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
}, PASTED_TABLE)
await win7.waitForTimeout(500)
const pastedGrid = await win7.evaluate(() => {
  const grids = [...document.querySelectorAll('.mdf-table-grid')]
  const grid = grids[grids.length - 1]
  if (!grid) return null
  return {
    count: grids.length,
    rows: [...grid.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent)),
    strong: grid.querySelector('td .mdf-strong')?.textContent ?? null,
    link: grid.querySelector('td .mdf-link')?.textContent ?? null,
    text: grid.textContent
  }
})
check(
  '粘贴后光标停在表格末尾，网格保持显示',
  pastedGrid !== null && pastedGrid.count === 2,
  JSON.stringify({ count: pastedGrid?.count })
)
check(
  '网格单元格去掉行内标记，链接只留文字',
  pastedGrid?.rows[0]?.join('|') === 'P0|工作区全文搜索与批量替换|目前 folder.ts 只列出文件夹直接子级' &&
    pastedGrid?.strong === '工作区全文搜索与批量替换' &&
    pastedGrid?.link === 'folder.ts' &&
    !String(pastedGrid?.text).includes('E:/DATA_FILE'),
  JSON.stringify(pastedGrid?.rows?.[0])
)
await win7.screenshot({ path: path.join(root, 'verify', 'paste-table-grid.png') })

await win7.keyboard.press('ArrowLeft')
await win7.waitForTimeout(350)
const pasteInside = await win7.evaluate(() => ({
  grids: document.querySelectorAll('.mdf-table-grid').length,
  text: document.querySelector('.cm-content').innerText
}))
check(
  '光标走进表格内部仍切回源码',
  pasteInside.grids === 1 && pasteInside.text.includes('E:/DATA_FILE'),
  JSON.stringify({ grids: pasteInside.grids })
)
await win7.keyboard.press('ArrowRight')
await win7.waitForTimeout(350)
await win7.keyboard.press('Control+z')
await win7.waitForTimeout(350)
check(
  '撤销后粘贴内容完全回退',
  (await win7.evaluate(() => document.querySelector('.cm-content').innerText.includes('优先级'))) === false
)

/* 富文本粘贴：剪贴板带 HTML（聊天界面复制表格的样子）时转成 Markdown，Tab 版纯文本不再被照单全收 */
const RICH_TAB_TEXT = [
  '优先级\t功能\t价值\t实现难度',
  'P0\t工作区全文搜索与批量替换\t当前查找主要针对当前文档\t中',
  'P0\t递归文件树与文件操作\t目前 [folder.ts](E:/DATA_FILE/File/MDForge/mdforge-editor/src/main/fs/folder.ts) 只列出文件夹直接子级\t中'
].join('\n')
const RICH_HTML = [
  '<p><span>从代码和 README 看，MDForge 的核心编辑体验已经比较完整。</span></p>',
  '<div><table><thead><tr><th><span>优先级</span></th><th><span>功能</span></th><th><span>价值</span></th><th><span>实现难度</span></th></tr></thead><tbody>',
  '<tr><td><span>P0</span></td><td><strong><span>工作区全文搜索与批量替换</span></strong></td><td><span>当前查找主要针对当前文档</span></td><td><span>中</span></td></tr>',
  '<tr><td><span>P0</span></td><td><strong><span>递归文件树与文件操作</span></strong></td><td><span>目前 </span><span data-prompt-link-label="folder.ts" data-prompt-link-href="E:/DATA_FILE/File/MDForge/mdforge-editor/src/main/fs/folder.ts">[folder.ts](E:/DATA_FILE/File/MDForge/mdforge-editor/src/main/fs/folder.ts)</span><span> 只列出文件夹直接子级</span></td><td><span>中</span></td></tr>',
  '</tbody></table></div>'
].join('')
await win7.locator('.cm-content').focus()
await win7.keyboard.press('Control+End')
await win7.waitForTimeout(150)
await win7.evaluate(
  ([text, html]) => {
    const content = document.querySelector('.cm-content')
    const data = new DataTransfer()
    data.setData('text/plain', text)
    data.setData('text/html', html)
    content.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  },
  [RICH_TAB_TEXT, RICH_HTML]
)
await win7.waitForTimeout(500)
const richGrid = await win7.evaluate(() => {
  const grids = [...document.querySelectorAll('.mdf-table-grid')]
  const grid = grids[grids.length - 1]
  if (!grid) return null
  return {
    count: grids.length,
    head: [...grid.querySelectorAll('th')].map((el) => el.textContent),
    rows: [...grid.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent)),
    link: grid.querySelector('td .mdf-link')?.textContent ?? null,
    strong: grid.querySelector('td .mdf-strong')?.textContent ?? null,
    text: grid.textContent,
    docText: document.querySelector('.cm-content').innerText
  }
})
check(
  '带 HTML 的粘贴转成 Markdown 表格',
  richGrid !== null &&
    richGrid.count === 2 &&
    richGrid.head?.join('|') === '优先级|功能|价值|实现难度' &&
    richGrid.rows?.length === 2,
  JSON.stringify({ count: richGrid?.count, head: richGrid?.head?.join('|') })
)
check(
  'HTML 粘贴的单元格去标记，链接只留文字',
  richGrid?.link === 'folder.ts' &&
    richGrid?.strong === '工作区全文搜索与批量替换' &&
    String(richGrid?.rows?.[1]?.[2] ?? '').includes('目前 folder.ts 只列出文件夹直接子级') &&
    !String(richGrid?.text).includes('E:/DATA_FILE') &&
    !String(richGrid?.text).includes('**'),
  JSON.stringify({ link: richGrid?.link, cell: richGrid?.rows?.[1]?.[2]?.slice(0, 30) })
)
check(
  'HTML 粘贴保留表格前的段落',
  String(richGrid?.docText).includes('从代码和 README 看'),
  String(richGrid?.docText).slice(0, 30)
)
await win7.screenshot({ path: path.join(root, 'verify', 'rich-paste.png') })
await win7.keyboard.press('Control+z')
await win7.waitForTimeout(350)
check(
  '撤销后富文本粘贴完全回退',
  (await win7.evaluate(() => document.querySelector('.cm-content').innerText.includes('优先级'))) === false
)

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
win13.on('pageerror', (e) => {
  pageErrors.push(e.message)
  console.log(`  渲染进程错误：${e.message}`)
})
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
try {
  await openOptions()
  await setOption('复制图片')
} catch (error) {
  // 断在菜单层级上时把当时可见的菜单项与截图留下来，方便定位
  const openLabels = await win13.$$eval('.mdf-menu-item', (els) => els.map((el) => el.dataset.menuLabel))
  console.log(`  诊断：菜单项 = ${JSON.stringify(openLabels)}`)
  await win13.screenshot({ path: path.join(root, 'verify', 'diag-options.png') }).catch(() => {})
  throw error
}
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

/* 护眼与高对比度：明暗之外的两档皮肤 */
await win13.locator('.mdf-menu-item[data-menu-label="护眼"]').click()
await win13.waitForTimeout(300)
check('主题切到护眼皮肤（暖纸色）', (await dataTheme()) === 'sepia' && (await bodyBg()) === 'rgb(246, 238, 219)', `${await dataTheme()}|${await bodyBg()}`)
check('护眼菜单项打勾', (await menuMark('护眼')) === '✓', await menuMark('护眼'))
await win13.screenshot({ path: path.join(root, 'verify', 'theme-sepia.png') })
await win13.locator('.mdf-menu-item[data-menu-label="高对比度"]').click()
await win13.waitForTimeout(300)
check(
  '高对比度是纯黑底',
  (await dataTheme()) === 'high-contrast' && (await bodyBg()) === 'rgb(0, 0, 0)',
  `${await dataTheme()}|${await bodyBg()}`
)
await win13.screenshot({ path: path.join(root, 'verify', 'theme-high-contrast.png') })
await win13.locator('.mdf-menu-item[data-menu-label="浅色"]').click()
await win13.waitForTimeout(250)
check('主题能切回浅色', (await dataTheme()) === 'light', await dataTheme())
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
await win13.waitForTimeout(300)
check(
  '正文改动后先提示结果过期',
  (await win13.textContent('.issues-note')).includes('建议重新检查'),
  await win13.textContent('.issues-note')
)
await win13.waitForTimeout(1500)
check(
  '停顿后自动重跑检查，过期提示消失',
  !(await win13.textContent('.issues-note')).includes('建议重新检查'),
  await win13.textContent('.issues-note')
)

/* 打开文件夹 → 递归文件树 → 文件操作 → 检查器新规则 → 工作区搜索 → 反向链接/导航 → 视图侧边栏开关 */
const folderFixture = path.join(workDir, '笔记文件夹')
mkdirSync(path.join(folderFixture, '子目录'), { recursive: true })
mkdirSync(path.join(folderFixture, 'assets'), { recursive: true })
writeFileSync(path.join(folderFixture, 'assets', 'p1.png'), makePng(8, 8))
writeFileSync(path.join(folderFixture, 'day01.md'), '# Day 1 命令行入门\n\n第一条笔记。\n', 'utf8')
writeFileSync(
  path.join(folderFixture, 'day02.md'),
  '# Day 2 环境初始化\n\n第二条笔记，引用了 [Day 1](day01.md)。\n',
  'utf8'
)
writeFileSync(
  path.join(folderFixture, 'day03.md'),
  '# Day 3 常用命令\n\n从 [Day 1](day01.md) 继续。\n\n搜一下 checkout 这个词。\n',
  'utf8'
)
writeFileSync(path.join(folderFixture, '子目录', 'inner.md'), '# 子目录笔记\n\n[回 day01](../day01.md)\n', 'utf8')
/* 文档同级的孤立图片：未引用资源要连它一起查出来（不能只看 assets/） */
writeFileSync(path.join(folderFixture, '封面.png'), makePng(20, 20))
/* 检查器新规则的靶子：重复标题、空图片描述、未闭合代码块、front matter 问题、
   超长行、待办占位符、跨文档锚点（目标存在但没有这一节） */
writeFileSync(
  path.join(folderFixture, 'lint-问题.md'),
  [
    '---',
    'title: A',
    'title: B',
    '这行不是键值',
    '---',
    '',
    '# 重复标题',
    '',
    '## 重复标题',
    '',
    '![](assets/p1.png)',
    '',
    'TODO: 发布前补上演示图',
    '',
    '[跳 day01 的一节](day01.md#不存在的标题)',
    '',
    'x'.repeat(220),
    '',
    '```',
    'const a = 1',
    ''
  ].join('\n'),
  'utf8'
)
await app13.evaluate(({ dialog }, dir) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
}, folderFixture)

await ensureMenuClosed()
await win13.click('.mdf-menubar-button[data-menu="file"]')
await win13.waitForSelector('.mdf-menu--bar')
check('文件菜单有「打开文件夹…」', (await menuLabels(win13)).includes('打开文件夹…'), '')
await win13.locator('.mdf-menu-item[data-menu-label="打开文件夹…"]').click()
await win13.waitForSelector('.file-item', { timeout: 9000 })
const fileItems = await win13.$$eval('.file-item:not(.is-dir)', (els) =>
  els.map((el) => ({
    name: el.querySelector('.file-name')?.innerText ?? '',
    preview: el.querySelector('.file-preview')?.textContent ?? ''
  }))
)
check('文件页列出文件夹里的 md', fileItems.length === 4, JSON.stringify(fileItems))
check(
  '列表按名称排序并带首行预览',
  fileItems[0]?.name.includes('day01.md') &&
    fileItems[0]?.preview.includes('Day 1 命令行入门') &&
    fileItems[1]?.name.includes('day02.md') &&
    fileItems[1]?.preview.includes('Day 2 环境初始化'),
  JSON.stringify(fileItems)
)
check(
  '目录条目排在文件前面',
  await win13.evaluate(() => {
    const first = document.querySelector('.file-item')
    return (
      first?.classList.contains('is-dir') === true &&
      [...document.querySelectorAll('.file-item.is-dir .file-stem')].some((el) => el.textContent === '子目录')
    )
  }),
  ''
)
check(
  '打开文件夹后自动切到文件页',
  await win13.evaluate(
    () => document.querySelector('.side-tab[data-side-tab="files"]')?.classList.contains('is-active') === true
  )
)

/* 递归文件树：展开子目录看到嵌套文件、新建文件夹、重命名 */
await win13.locator('.file-item.is-dir[data-file-path$="子目录"]').click()
await win13.waitForTimeout(500)
const expandedFiles = await win13.$$eval('.file-item:not(.is-dir)', (els) => els.map((el) => el.dataset.filePath ?? ''))
check(
  '展开子目录后看到嵌套的 md',
  expandedFiles.some((p) => p.endsWith('inner.md')),
  JSON.stringify(expandedFiles)
)
await win13.click('.files-tool[data-tool="new-folder"]')
await win13.waitForSelector('.file-rename-input')
await win13.locator('.file-rename-input').fill('新建目录')
await win13.keyboard.press('Enter')
await win13.waitForTimeout(700)
check('工具按钮能新建文件夹', (await win13.locator('.file-item.is-dir[data-file-path$="新建目录"]').count()) === 1, '')
await win13.locator('.file-item[data-file-path$="day03.md"]').click({ button: 'right' })
await win13.waitForSelector('.mdf-menu [data-menu-label="重命名"]')
await win13.locator('.mdf-menu [data-menu-label="重命名"]').click()
await win13.waitForSelector('.file-rename-input')
await win13.locator('.file-rename-input').fill('day03-改名.md')
await win13.keyboard.press('Enter')
await win13.waitForTimeout(700)
check(
  '重命名后文件树显示新名字',
  (await win13.locator('.file-item[data-file-path$="day03-改名.md"]').count()) === 1 &&
    (await win13.locator('.file-item[data-file-path$="day03.md"]').count()) === 0,
  ''
)

/* 新建文件：工具按钮 → 就地输入名字 → 建好直接打开 */
await win13.click('.files-tool[data-tool="new-file"]')
await win13.waitForSelector('.file-rename-input')
await win13.locator('.file-rename-input').fill('新笔记')
await win13.keyboard.press('Enter')
await win13.waitForTimeout(800)
check(
  '工具按钮新建 Markdown 文件并直接打开',
  (await win13.locator('.file-item[data-file-path$="新笔记.md"]').count()) === 1 &&
    (await win13.textContent('#file-name')).includes('新笔记.md'),
  await win13.textContent('#file-name')
)

/* 删除：右键 → 移入回收站（应用内确认框），已打开的标签一起关掉 */
await win13.locator('.file-item[data-file-path$="新笔记.md"]').click({ button: 'right' })
await win13.waitForSelector('.mdf-menu [data-menu-label="删除（移入回收站）"]')
await win13.locator('.mdf-menu [data-menu-label="删除（移入回收站）"]').click()
await win13.waitForSelector('.mdf-dialog')
check('删除前弹确认框', (await dialogText(win13)).includes('回收站'), await dialogText(win13))
await answer(win13, '移入回收站')
await win13.waitForTimeout(900)
check(
  '删除后文件树与标签都不再显示',
  (await win13.locator('.file-item[data-file-path$="新笔记.md"]').count()) === 0 &&
    !(await win13.textContent('#file-name')).includes('新笔记.md'),
  await win13.textContent('#file-name')
)

/* 检查器新规则与编辑器内联标记：打开带问题的文档跑一次文档检查 */
await win13.locator('.file-item[data-file-path$="lint-问题.md"]').click()
await win13.waitForTimeout(600)
await win13.click('.mdf-menubar-button[data-menu="view"]')
await win13.waitForSelector('.mdf-menu--bar')
await win13.locator('.mdf-menu-item[data-menu-label="文档检查"]').click()
await win13.waitForSelector('.issue-item', { timeout: 9000 })
const lintHeads = await win13.$$eval('.issue-group-head', (els) => els.map((el) => el.textContent))
check(
  '检查器新规则按类别分组',
  lintHeads.some((text) => text.includes('重复标题 1')) &&
    lintHeads.some((text) => text.includes('空图片描述 1')) &&
    lintHeads.some((text) => text.includes('未闭合代码块 1')) &&
    lintHeads.some((text) => text.includes('Front Matter 问题 2')) &&
    lintHeads.some((text) => text.includes('超长行 1')) &&
    lintHeads.some((text) => text.includes('待办占位符 1')) &&
    lintHeads.some((text) => text.includes('坏链 1')) &&
    lintHeads.some((text) => text.includes('未引用资源 1')),
  JSON.stringify(lintHeads)
)
const lintDetails = await win13.$$eval('.issue-detail', (els) => els.map((el) => el.textContent))
check(
  '待办占位符与跨文档锚点各有说明',
  lintDetails.some((text) => text.includes('占位符')) &&
    lintDetails.some((text) => text.includes('#不存在的标题') && text.includes('目标文档')),
  JSON.stringify(lintDetails.slice(0, 2))
)
const lintLabels = await win13.$$eval('.issue-label', (els) => els.map((el) => el.textContent))
check(
  '同级散落的未引用图片被点名',
  lintLabels.some((text) => text.includes('封面.png')),
  JSON.stringify(lintLabels)
)
/* 行内标记只看当前显示的编辑器：隐藏标签的 cm-line 也在 DOM 里 */
const readActiveMarks = () =>
  win13.evaluate(() => {
    const shown = [...document.querySelectorAll('#editor-host .editor-mount')].find((el) => el.style.display !== 'none')
    return shown ? shown.querySelectorAll('.cm-line.mdf-issue-line').length : 0
  })
const markLines = await until(readActiveMarks, (count) => count >= 6)
check('编辑器里出现行内问题标记', markLines >= 6, `marks=${markLines}`)
await win13.screenshot({ path: path.join(root, 'verify', 'issues-inline.png') })
await win13.locator('.tab-close').last().click()
await win13.waitForTimeout(400)

/* 检查面板切走过 files 视图，切回来再点文件 */
await win13.click('.side-tab[data-side-tab="files"]')
await win13.waitForSelector('.file-item[data-file-path$="day01.md"]', { timeout: 9000 })

await win13.locator('.file-item[data-file-path$="day01.md"]').click()
await win13.waitForTimeout(500)
check(
  '点列表项在标签里打开',
  (await win13.textContent('#file-name')).includes('day01.md'),
  await win13.textContent('#file-name')
)
check(
  '当前文件在列表里高亮',
  (await win13.$$eval('.file-item.is-active', (els) => els.map((el) => el.dataset.filePath))).some((p) =>
    p?.endsWith('day01.md')
  )
)

/* 收藏：点星后进入收藏区，再点一次取消 */
await win13.locator('.file-item[data-file-path$="day02.md"] .file-star').click()
await win13.waitForTimeout(350)
check(
  '收藏后出现在收藏区且星标点亮',
  (await win13.locator('.files-favs .files-fav').count()) === 1 &&
    (await win13.locator('.file-item[data-file-path$="day02.md"] .file-star.is-on').count()) === 1,
  ''
)
await win13.locator('.files-favs .files-fav .file-star').click()
await win13.waitForTimeout(350)
check('取消收藏后收藏区清空', (await win13.locator('.files-favs .files-fav').count()) === 0, '')
await win13.screenshot({ path: path.join(root, 'verify', 'files-panel.png') })

/* 反向链接 → 文档关系图 → 导航历史 */
await win13.click('.side-tab[data-side-tab="links"]')
await win13.waitForTimeout(700)
const backLinks = await win13.$$eval('.link-item', (els) =>
  els.map((el) => ({
    name: el.querySelector('.link-name')?.textContent ?? '',
    detail: el.querySelector('.link-detail')?.textContent ?? ''
  }))
)
check(
  '反向链接列出指向当前文档的文档',
  backLinks.some((link) => link.name.includes('day02.md') && link.detail.includes('第 3 行')),
  JSON.stringify(backLinks)
)
await win13.locator('.link-item').first().click()
await win13.waitForTimeout(500)
check(
  '点反向链接打开来源文档',
  (await win13.textContent('#file-name')).includes('day02.md'),
  await win13.textContent('#file-name')
)
check(
  '点反向链接跳到链接所在行',
  (await win13.textContent('#status-metrics')).includes('行 3'),
  await win13.textContent('#status-metrics')
)
await win13.keyboard.press('Alt+ArrowLeft')
await win13.waitForTimeout(450)
check(
  'Alt+← 后退到上一个位置',
  (await win13.textContent('#file-name')).includes('day01.md'),
  await win13.textContent('#file-name')
)
await win13.keyboard.press('Alt+ArrowRight')
await win13.waitForTimeout(450)
check(
  'Alt+→ 前进回后一个位置',
  (await win13.textContent('#file-name')).includes('day02.md'),
  await win13.textContent('#file-name')
)

await win13.click('.mdf-menubar-button[data-menu="nav"]')
await win13.waitForSelector('.mdf-menu--bar')
const navLabels = await menuLabels(win13)
check(
  '导航菜单列出后退/前进/关系图',
  navLabels.includes('后退') && navLabels.includes('前进') && navLabels.includes('文档关系图…'),
  JSON.stringify(navLabels)
)
check(
  '导航菜单里后退可用',
  await win13.evaluate(
    () => document.querySelector('.mdf-menu-item[data-menu-label="后退"]')?.classList.contains('is-disabled') === false
  ),
  ''
)
await ensureMenuClosed()

await win13.locator('.side-tab[data-side-tab="links"]').click()
await win13.waitForTimeout(400)
await win13.click('.issues-run[data-action="links-graph"]')
await win13.waitForSelector('.mdf-graph-node', { timeout: 9000 })
const graphNodes = await win13.locator('.mdf-graph-node').count()
const graphEdges = await win13.locator('.mdf-graph-edge').count()
check('关系图画出全部文档与链接', graphNodes === 5 && graphEdges === 4, `nodes=${graphNodes} edges=${graphEdges}`)
await win13.screenshot({ path: path.join(root, 'verify', 'graph.png') })
await win13.keyboard.press('Escape')
await win13.waitForTimeout(300)
check('Esc 关闭关系图', (await win13.locator('.mdf-graph').count()) === 0, '')

/* 关掉 day02 标签，回到 day01 继续测搜索 */
await win13.locator('.tab-close').last().click()
await win13.waitForTimeout(400)

/* 工作区搜索与批量替换 */
await win13.click('.side-tab[data-side-tab="search"]')
await win13.waitForSelector('.search-input')
await win13.locator('.search-input').first().fill('笔记')
await win13.keyboard.press('Enter')
await win13.waitForSelector('.search-hit', { timeout: 9000 })
check(
  '工作区搜索列出内容命中',
  (await win13.locator('.search-hit').count()) === 3,
  `${await win13.locator('.search-hit').count()} 处`
)
check(
  '命中行带高亮片段',
  (await win13.locator('.search-hit mark').count()) >= 3,
  `${await win13.locator('.search-hit mark').count()} 处`
)
await win13.locator('.search-hit').first().click()
await win13.waitForTimeout(450)
check(
  '点命中跳到命中行',
  (await win13.textContent('#file-name')).includes('day01.md') &&
    (await win13.textContent('#status-metrics')).includes('行 3'),
  await win13.textContent('#status-metrics')
)

await win13.locator('.search-input').first().fill('day0')
await win13.keyboard.press('Enter')
await win13.waitForTimeout(700)
check(
  '文件名命中也列出',
  (await win13.locator('.search-name-hit').count()) === 3,
  `${await win13.locator('.search-name-hit').count()} 个`
)

await win13.locator('.search-input').first().fill('第一条笔记')
await win13.keyboard.press('Enter')
await win13.waitForSelector('.search-hit', { timeout: 9000 })
await win13.locator('.search-input').nth(1).fill('第一条笔记（已更新）')
await win13.click('.search-go[data-action="search-replace-all"]')
await win13.waitForSelector('.mdf-dialog')
await answer(win13, '替换')
await win13.waitForTimeout(900)
check(
  '批量替换写回磁盘',
  (readSafe(path.join(folderFixture, 'day01.md')) ?? '').includes('第一条笔记（已更新）'),
  readSafe(path.join(folderFixture, 'day01.md')) ?? 'null'
)
check(
  '替换后打开的干净标签跟着重载',
  await win13.evaluate(() => {
    const shown = [...document.querySelectorAll('#editor-host .editor-mount')].find((el) => el.style.display !== 'none')
    return shown ? shown.querySelector('.cm-content')?.innerText.includes('第一条笔记（已更新）') === true : false
  }),
  ''
)
check('状态栏报告替换结果', (await statusText13()).includes('替换 1 处'), await statusText13())
await win13.screenshot({ path: path.join(root, 'verify', 'workspace-search.png') })

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

/* ============ P1 四项：分屏与写作模式 / 图片资源管理器 / front matter 表单 / 发布导出 ============ */
const p1Dir = mkdtempSync(path.join(tmpdir(), 'mdforge-p1-'))
mkdirSync(path.join(p1Dir, 'assets'), { recursive: true })
mkdirSync(path.join(p1Dir, 'notes'), { recursive: true })
writeFileSync(path.join(p1Dir, 'assets', 'shot.png'), makePng(400, 300, true))
writeFileSync(path.join(p1Dir, 'assets', 'unused.png'), makePng(20, 10))
writeFileSync(
  path.join(p1Dir, 'index.md'),
  [
    '---',
    'title: 手记首页',
    'author: 张三',
    'tags: [笔记]',
    'custom: keep-me',
    '---',
    '',
    '# 手记',
    '',
    '正文第一段，用来观察专注模式。',
    '',
    '另一段，引用 [子页](notes/child.md)。',
    '',
    '![截图](assets/shot.png)',
    ''
  ].join('\n'),
  'utf8'
)
writeFileSync(
  path.join(p1Dir, 'notes', 'child.md'),
  '# 子页\n\n[回首页](../index.md)\n\n![截图](../assets/shot.png)\n',
  'utf8'
)
const p1Out = path.join(p1Dir, '网站')
const p1Epub = path.join(p1Dir, 'book.epub')

resetAppData()
const app15 = await _electron.launch({
  executablePath: require('electron'),
  args: [root, path.join(p1Dir, 'index.md')],
  cwd: root
})
const win15 = await app15.firstWindow()
win15.on('dialog', (d) => {
  nativeDialogs += 1
  d.accept().catch(() => {})
})
win15.on('pageerror', (e) => pageErrors.push(e.message))
win15.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
await win15.waitForSelector('.cm-content')
await win15.waitForTimeout(600)

const activeEditor15 = () =>
  win15.evaluate(() => {
    const shown = [...document.querySelectorAll('#editor-host .editor-mount')].find((el) => el.style.display !== 'none')
    if (!shown) return null
    const content = shown.querySelector('.cm-content')
    return {
      text: content?.innerText ?? '',
      editable: content?.getAttribute('contenteditable') ?? 'missing'
    }
  })
const closeMenu15 = async () => {
  await win15.keyboard.press('Escape')
  await win15.waitForTimeout(150)
}
const markOf15 = (label) =>
  win15.evaluate((name) => {
    const item = [...document.querySelectorAll('.mdf-menu-item')].find((el) => el.dataset.menuLabel === name)
    return item ? item.querySelector('.mdf-menu-mark')?.textContent ?? '' : 'missing'
  }, label)
const waitForFile = (read, timeoutMs = 20000) => until(read, (value) => value === true, timeoutMs)

/* 视图菜单：分屏预览（左源码 · 右渲染） */
await win15.click('.mdf-menubar-button[data-menu="view"]')
await win15.waitForSelector('.mdf-menu--bar')
const viewLabels15 = await menuLabels(win15)
check(
  '视图菜单含分屏/阅读/打字机/专注',
  ['分屏预览', '阅读模式', '打字机模式', '专注模式'].every((label) => viewLabels15.includes(label)),
  JSON.stringify(viewLabels15)
)
check('打字机与专注默认未勾选', (await markOf15('打字机模式')) === '' && (await markOf15('专注模式')) === '', '')
await win15.locator('.mdf-menu--bar .mdf-menu-item[data-menu-label="分屏预览"]').click()
await win15.waitForTimeout(800)
const splitState = await win15.evaluate(() => {
  const host = document.querySelector('.editor-host')
  const pane = document.querySelector('.split-preview')
  const frame = pane?.querySelector('iframe')
  const src = frame?.getAttribute('srcdoc') ?? ''
  const shown = [...document.querySelectorAll('#editor-host .editor-mount')].find((el) => el.style.display !== 'none')
  return {
    isSplit: host?.classList.contains('is-split') === true,
    paneVisible: pane !== null && pane.hidden === false,
    rendered: src.includes('正文第一段') && src.includes('<h1'),
    sourceMode: (shown?.querySelector('.cm-content')?.innerText ?? '').includes('# 手记')
  }
})
check('分屏：右栏出现渲染结果', splitState.paneVisible && splitState.rendered, JSON.stringify(splitState))
check('分屏：左栏自动切到源码视图', splitState.isSplit && splitState.sourceMode, JSON.stringify(splitState))
await closeMenu15()
await win15.screenshot({ path: path.join(root, 'verify', 'p1-split.png') })

/* 阅读模式：只读且退出分屏 */
await win15.click('.mdf-menubar-button[data-menu="view"]')
await win15.waitForSelector('.mdf-menu--bar')
await win15.locator('.mdf-menu--bar .mdf-menu-item[data-menu-label="阅读模式"]').click()
await win15.waitForTimeout(500)
const readState = await activeEditor15()
const splitGone = await win15.evaluate(() => document.querySelector('.split-preview')?.hidden === true)
check('阅读模式：编辑器只读', readState !== null && readState.editable === 'false', JSON.stringify(readState))
check('切到阅读时退出分屏', splitGone)
await win15.locator('.mdf-menu--bar .mdf-menu-item[data-menu-label="阅读模式"]').click()
await win15.waitForTimeout(400)
check('再点阅读模式回到可编辑', (await activeEditor15())?.editable !== 'false')
await closeMenu15()

/* 打字机与专注：勾选状态、类名与段落淡化 */
await win15.click('.mdf-menubar-button[data-menu="view"]')
await win15.waitForSelector('.mdf-menu--bar')
await win15.locator('.mdf-menu--bar .mdf-menu-item[data-menu-label="打字机模式"]').click()
await win15.waitForTimeout(500)
const typewriterPadding = await win15.evaluate(() => {
  const shown = [...document.querySelectorAll('#editor-host .editor-mount')].find((el) => el.style.display !== 'none')
  const content = shown?.querySelector('.cm-content')
  return content ? Number.parseFloat(getComputedStyle(content).paddingTop) : 0
})
check(
  '打字机模式：勾选与半屏留白生效',
  (await markOf15('打字机模式')) === '✓' && typewriterPadding > 200,
  `padding=${typewriterPadding}`
)
await win15.locator('.mdf-menu--bar .mdf-menu-item[data-menu-label="专注模式"]').click()
await win15.waitForTimeout(500)
check('专注模式：勾选生效', (await markOf15('专注模式')) === '✓')
await closeMenu15()

await win15.locator('.cm-line').nth(5).click()
await win15.waitForTimeout(500)
const centering = await win15.evaluate(() => {
  const shown = [...document.querySelectorAll('#editor-host .editor-mount')].find((el) => el.style.display !== 'none')
  const scroller = shown?.querySelector('.cm-scroller')
  const line = shown?.querySelectorAll('.cm-line')[5]
  if (!scroller || !line) return null
  const s = scroller.getBoundingClientRect()
  const l = line.getBoundingClientRect()
  return Math.abs(l.top + l.height / 2 - (s.top + s.height / 2))
})
check('打字机模式：光标行拨到视口中线附近', centering !== null && centering < 140, String(centering))
const focusDim = await win15.evaluate(() => {
  const shown = [...document.querySelectorAll('#editor-host .editor-mount')].find((el) => el.style.display !== 'none')
  return {
    dim: shown?.querySelectorAll('.cm-line.mdf-focus-dim').length ?? 0,
    total: shown?.querySelectorAll('.cm-line').length ?? 0
  }
})
check('专注模式：非当前段落淡化', focusDim.dim > 0 && focusDim.dim < focusDim.total, JSON.stringify(focusDim))
await win15.screenshot({ path: path.join(root, 'verify', 'p1-focus.png') })

await win15.click('.mdf-menubar-button[data-menu="view"]')
await win15.waitForSelector('.mdf-menu--bar')
await win15.locator('.mdf-menu--bar .mdf-menu-item[data-menu-label="打字机模式"]').click()
await win15.locator('.mdf-menu--bar .mdf-menu-item[data-menu-label="专注模式"]').click()
await win15.waitForTimeout(400)
const typewriterOff = await win15.evaluate(() => {
  const shown = [...document.querySelectorAll('#editor-host .editor-mount')].find((el) => el.style.display !== 'none')
  const content = shown?.querySelector('.cm-content')
  return content ? Number.parseFloat(getComputedStyle(content).paddingTop) : 0
})
check(
  '再点一次关闭打字机与专注',
  (await markOf15('打字机模式')) === '' && (await markOf15('专注模式')) === '' && typewriterOff < 100,
  `padding=${typewriterOff}`
)
await closeMenu15()

/* front matter 表单：预填、原始 YAML 双模式、写回文档 */
await win15.locator('[data-action="fm-edit"]').click()
await win15.waitForSelector('.mdf-form-dialog')
check(
  'front matter 表单预填字段',
  (await win15.inputValue('.mdf-form-dialog input[data-field="title"]')) === '手记首页' &&
    (await win15.inputValue('.mdf-form-dialog input[data-field="author"]')) === '张三' &&
    (await win15.inputValue('.mdf-form-dialog input[data-field="tags"]')) === '笔记'
)
await win15.fill('.mdf-form-dialog input[data-field="title"]', '新手记标题')
await win15.fill('.mdf-form-dialog input[data-field="tags"]', '小说, 连载')
await win15.locator('.mdf-dialog-button[data-action="fm-toggle-mode"]').click()
await win15.waitForTimeout(250)
const rawYaml = await win15.inputValue('.mdf-form-dialog textarea')
check(
  '原始 YAML 保留未知字段与改动',
  rawYaml.includes('custom: keep-me') && rawYaml.includes('title: 新手记标题') && rawYaml.includes('tags: [小说, 连载]'),
  rawYaml.replace(/\n/g, '⏎ ').slice(0, 100)
)
await win15.screenshot({ path: path.join(root, 'verify', 'p1-frontmatter.png') })
await win15.locator('.mdf-dialog-button[data-action="fm-toggle-mode"]').click()
await win15.waitForTimeout(250)
await win15.locator('.mdf-dialog-button[data-action="fm-save"]').click()
await win15.waitForTimeout(500)
const fmText = (await activeEditor15())?.text ?? ''
check(
  '表单写回 front matter',
  fmText.includes('title: 新手记标题') && fmText.includes('custom: keep-me') && fmText.includes('tags: [小说, 连载]'),
  fmText.replace(/\n/g, '⏎ ').slice(0, 120)
)
await saveDoc(win15)
await win15.waitForTimeout(700)
check('front matter 改动落盘', (readSafe(path.join(p1Dir, 'index.md')) ?? '').includes('title: 新手记标题'))

/* 打开文件夹 → 图片资源管理器：列表、尺寸、未引用、重命名、压缩 */
await app15.evaluate(({ dialog }, dir) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
}, p1Dir)
await win15.click('.mdf-menubar-button[data-menu="file"]')
await win15.waitForSelector('.mdf-menu--bar')
await win15.locator('.mdf-menu-item[data-menu-label="打开文件夹…"]').click()
await win15.waitForTimeout(600)
await win15.click('.mdf-menubar-button[data-menu="view"]')
await win15.waitForSelector('.mdf-menu--bar')
await win15.locator('.mdf-menu--bar .mdf-menu-item[data-menu-label="图片资源管理器"]').click()
await win15.waitForSelector('.asset-item', { timeout: 9000 })
const assetRows = await win15.$$eval('.asset-item', (els) =>
  els.map((el) => ({
    name: el.dataset.assetName ?? '',
    meta: el.querySelector('.asset-meta')?.textContent ?? '',
    refs: el.querySelector('.asset-refs')?.textContent ?? ''
  }))
)
check(
  '图片页列出资源与尺寸',
  assetRows.length === 2 &&
    assetRows.some((row) => row.name === 'shot.png' && row.meta.includes('400×300')) &&
    assetRows.some((row) => row.name === 'unused.png'),
  JSON.stringify(assetRows)
)
check('未引用图片有标记', assetRows.some((row) => row.name === 'unused.png' && row.refs === '未引用'), '')
await win15.screenshot({ path: path.join(root, 'verify', 'p1-assets.png') })

await win15.locator('.asset-item[data-asset-name="unused.png"] .asset-check').check()
await win15.locator('[data-action="assets-rename"]').click()
await win15.waitForSelector('.mdf-form-dialog')
await win15.fill('.mdf-form-dialog input[data-field="prefix"]', 'pic')
await win15.locator('.mdf-dialog-button[data-action="form-confirm"]').click()
await waitForFile(() => existsSync(path.join(p1Dir, 'assets', 'pic-1.png')), 12000)
check(
  '批量重命名写盘',
  existsSync(path.join(p1Dir, 'assets', 'pic-1.png')) && !existsSync(path.join(p1Dir, 'assets', 'unused.png')),
  ''
)

await win15.locator('.asset-item[data-asset-name="shot.png"] .asset-check').check()
await win15.locator('[data-action="assets-compress"]').click()
await win15.waitForSelector('.mdf-form-dialog')
await win15.selectOption('.mdf-form-dialog select[data-field="format"]', 'webp')
await win15.locator('.mdf-dialog-button[data-action="form-confirm"]').click()
await waitForFile(() => existsSync(path.join(p1Dir, 'assets', 'shot.webp')), 20000)
const compressStatus = await win15.textContent('#status')
check(
  '压缩为 WebP 并替换引用',
  existsSync(path.join(p1Dir, 'assets', 'shot.webp')) &&
    !existsSync(path.join(p1Dir, 'assets', 'shot.png')) &&
    (readSafe(path.join(p1Dir, 'index.md')) ?? '').includes('assets/shot.webp') &&
    (readSafe(path.join(p1Dir, 'notes', 'child.md')) ?? '').includes('../assets/shot.webp'),
  compressStatus
)
check('状态栏报告压缩结果', compressStatus.includes('已压缩'), compressStatus)

/* 导出静态站点：输出目录对话框桩 → 页面、导航、搜索索引、图片 */
await app15.evaluate(({ dialog }, outDir) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [outDir] })
}, p1Out)
await win15.click('.mdf-menubar-button[data-menu="file"]')
await win15.waitForSelector('.mdf-menu--bar')
await win15.locator('.mdf-menu--bar .mdf-menu-item[data-menu-label="导出"]').click()
await win15.waitForSelector('.mdf-menu--sub')
const exportLabels15 = await win15.$$eval('.mdf-menu--sub .mdf-menu-item', (els) => els.map((el) => el.dataset.menuLabel))
check(
  '导出菜单含批量/站点/EPUB',
  ['导出文件夹为 HTML…', '导出静态站点…', '导出 EPUB…'].every((label) => exportLabels15.includes(label)),
  JSON.stringify(exportLabels15)
)
await win15.locator('.mdf-menu--sub .mdf-menu-item[data-menu-label="导出静态站点…"]').click()
await waitForFile(
  () => existsSync(path.join(p1Out, 'index.html')) && existsSync(path.join(p1Out, 'search-index.json'))
)
const siteIndex = readSafe(path.join(p1Out, 'index.html')) ?? ''
const siteChild = readSafe(path.join(p1Out, 'notes', 'child.html')) ?? ''
const searchIndex = readSafe(path.join(p1Out, 'search-index.json')) ?? ''
check('静态站点：导航页含标题与搜索框', siteIndex.includes('新手记标题') && siteIndex.includes('mdf-q'), siteIndex.slice(0, 60))
check('静态站点：页内返回目录、子页相对链接正确', siteChild.includes('href="../index.html"'), siteChild.slice(0, 80))
check(
  '静态站点：搜索索引收录两篇文档',
  (JSON.parse(searchIndex || '{"docs":[]}')).docs.length === 2,
  searchIndex.slice(0, 80)
)
check(
  '静态站点：图片复制到各页面旁',
  existsSync(path.join(p1Out, 'index.assets', 'shot.webp')) &&
    existsSync(path.join(p1Out, 'notes', 'child.assets', 'shot.webp')),
  ''
)
const siteStatus = await win15.textContent('#status')
check('状态栏报告导出数量', siteStatus.includes('已导出') && siteStatus.includes('个文件'), siteStatus)

/* 导出 EPUB：单篇/整本选择 → 打包结构 */
await app15.evaluate(({ dialog }, target) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
}, p1Epub)
await win15.click('.mdf-menubar-button[data-menu="file"]')
await win15.waitForSelector('.mdf-menu--bar')
await win15.locator('.mdf-menu--bar .mdf-menu-item[data-menu-label="导出"]').click()
await win15.waitForSelector('.mdf-menu--sub')
await win15.locator('.mdf-menu--sub .mdf-menu-item[data-menu-label="导出 EPUB…"]').click()
await win15.waitForSelector('.mdf-dialog')
check('EPUB 提供单篇/整本选择', (await dialogText(win15)).includes('整个文件夹成一本书'), await dialogText(win15))
await answer(win15, '整个文件夹成一本书')
await waitForFile(() => existsSync(p1Epub))
const epubBytes = existsSync(p1Epub) ? readFileSync(p1Epub) : Buffer.alloc(0)
check(
  'EPUB 打包结构完整（两章、包描述、导航）',
  epubBytes.includes('application/epub+zip') &&
    epubBytes.includes('OEBPS/content.opf') &&
    epubBytes.includes('OEBPS/nav.xhtml') &&
    epubBytes.includes('OEBPS/chapter-2.xhtml'),
  `size=${epubBytes.length}`
)
/** 从 zip 里解出一条条目的文本（名字在局部头里，先按名字定位局部头再解压） */
const inflateEntry = (buffer, name) => {
  const nameBuf = Buffer.from(name, 'ascii')
  const index = buffer.indexOf(nameBuf)
  if (index < 30) return ''
  const localOffset = index - 30
  const compressed = buffer.readUInt32LE(localOffset + 18)
  const dataStart = localOffset + 30 + nameBuf.length + buffer.readUInt16LE(localOffset + 28)
  return zlib.inflateRawSync(buffer.subarray(dataStart, dataStart + compressed)).toString('utf8')
}
const chapterText = inflateEntry(epubBytes, 'OEBPS/chapter-1.xhtml')
check(
  'EPUB 正文内联图片、结构为 XHTML',
  chapterText.includes(';base64,') && chapterText.includes('<img') && !chapterText.includes('<img src="assets'),
  chapterText.slice(0, 80)
)
const epubStatus = await win15.textContent('#status')
check('状态栏报告 EPUB 结果', epubStatus.includes('已导出 EPUB'), epubStatus)

/* 自定义主题与模板：管理器里新建/导入导出 → 导出 HTML 用上自定义 CSS、高亮与页面模板 */
const styleRoot15 = path.join(userData, 'export-styles')
const styleHtmlStar = path.join(p1Dir, '主题导出.html')
const styleHtmlTpl = path.join(p1Dir, '模板导出.html')
const styleOutCss = path.join(p1Dir, '夜航星.css')
const importCssFile = path.join(p1Dir, '导入-样式.css')
writeFileSync(importCssFile, 'body { color: #abcdef; }\n', 'utf8')

const openOptions15 = async () => {
  await win15.keyboard.press('Escape')
  await win15.waitForTimeout(150)
  await win15.click('.mdf-menubar-button[data-menu="file"]')
  await win15.waitForSelector('.mdf-menu--bar')
  await win15.locator('.mdf-menu--bar .mdf-menu-item[data-menu-label="导出"]').click()
  await win15.waitForSelector('.mdf-menu--sub')
  await win15.locator('.mdf-menu--sub .mdf-menu-item[data-menu-label="导出选项"]').click()
  await win15.waitForTimeout(250)
}
const exportHtml15 = async (target) => {
  await app15.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
  }, target)
  await win15.click('.mdf-menubar-button[data-menu="file"]')
  await win15.waitForSelector('.mdf-menu--bar')
  await win15.locator('.mdf-menu--bar .mdf-menu-item[data-menu-label="导出"]').click()
  await win15.waitForSelector('.mdf-menu--sub')
  await win15.locator('.mdf-menu--sub .mdf-menu-item[data-menu-label="导出 HTML…"]').click()
  await until(() => existsSync(target), (ok) => ok === true, 20000)
  return readSafe(target) ?? ''
}
const styleRows15 = () =>
  win15.$$eval('.mdf-style-row', (els) =>
    els.map((el) => ({
      name: el.querySelector('.mdf-style-name')?.textContent ?? '',
      current: el.querySelector('.mdf-style-current') !== null
    }))
  )

await openOptions15()
const styleOptionLabels = await menuLabels(win15)
check(
  '选项页新增主题管理、代码高亮与页面模板',
  ['管理主题与模板…', '跟随主题', 'GitHub Dark', 'Monokai', '内置标准页'].every((label) =>
    styleOptionLabels.includes(label)
  ),
  JSON.stringify(styleOptionLabels)
)

await win15.locator('.mdf-menu-item[data-menu-label="管理主题与模板…"]').click()
await win15.waitForSelector('.mdf-style-dialog')
const builtinRows15 = await win15.$$eval('.mdf-style-row', (els) => els.map((el) => el.dataset.ref))
check(
  '管理器列出内置主题（模板在内置页签下）',
  ['default', 'serif', 'plain', 'dark', 'mdmdt'].every((ref) => builtinRows15.includes(ref)),
  JSON.stringify(builtinRows15)
)
await win15.screenshot({ path: path.join(root, 'verify', 'p1-style-manager.png') })

/* 新建自定义主题：编辑器里填 CSS，实时预览立刻反映 */
await win15.locator('.mdf-style-actions [data-action="style-create"]').click()
await win15.waitForSelector('.mdf-style-editor')
await win15.fill('.mdf-style-editor input[data-field="style-name"]', '夜航星')
await win15.fill('.mdf-style-editor textarea[data-field="style-css"]', 'body { background: #010b2e; }')
const previewCss = await until(
  () =>
    win15.evaluate(() => {
      const frame = document.querySelector('.mdf-style-preview-frame')
      return {
        css: frame?.contentDocument?.querySelector('style')?.textContent ?? '',
        text: frame?.contentDocument?.body?.innerText ?? ''
      }
    }),
  (value) => value.css.includes('#010b2e'),
  8000
)
check('主题编辑器：预览用上自定义 CSS 且渲染当前文档', previewCss.css.includes('#010b2e') && previewCss.text.includes('正文第一段'), previewCss.text.slice(0, 40))
await win15.screenshot({ path: path.join(root, 'verify', 'p1-style-editor.png') })
await win15.locator('.mdf-style-editor [data-action="style-save"]').click()
await win15.waitForSelector('.mdf-style-editor', { state: 'detached' })
const createdRows15 = await until(styleRows15, (rows) => rows.some((row) => row.name === '夜航星'), 6000)
check(
  '新建主题后出现在列表并设为当前',
  createdRows15.some((row) => row.name === '夜航星' && row.current),
  JSON.stringify(createdRows15)
)
const storedThemes15 = existsSync(path.join(styleRoot15, 'themes')) ? readdirSync(path.join(styleRoot15, 'themes')) : []
check('主题条目存在用户目录（中文名不进文件名）', storedThemes15.filter((name) => name.endsWith('.json')).length === 1, JSON.stringify(storedThemes15))

/* 导入 .css → 设为当前；再导出自定义主题为 .css */
await app15.evaluate(({ dialog }, file) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
}, importCssFile)
await win15.locator('.mdf-style-actions [data-action="style-import"]').click()
const importedRows15 = await until(styleRows15, (rows) => rows.some((row) => row.name === '导入-样式'), 8000)
check(
  '导入 css 成为新主题并设为当前',
  importedRows15.some((row) => row.name === '导入-样式' && row.current),
  JSON.stringify(importedRows15)
)
await app15.evaluate(({ dialog }, file) => {
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
}, styleOutCss)
await win15.locator('.mdf-style-row', { hasText: '导入-样式' }).locator('[data-action="style-export"]').click()
await until(() => existsSync(styleOutCss), (ok) => ok === true, 8000)
check('导出自定义主题为 css 文件', (readSafe(styleOutCss) ?? '').includes('#abcdef'), readSafe(styleOutCss) ?? '')

/* 删除要过确认框；删掉当前主题后回落内置 */
await win15.locator('.mdf-style-row', { hasText: '导入-样式' }).locator('[data-action="style-delete"]').click()
await win15.waitForSelector('.mdf-dialog')
check('删除主题有确认框', (await dialogText(win15)).includes('导入-样式'), await dialogText(win15))
await answer(win15, '删除')
const afterDelete15 = await until(styleRows15, (rows) => !rows.some((row) => row.name === '导入-样式'), 6000)
check('删除后条目从列表消失', !afterDelete15.some((row) => row.name === '导入-样式'), JSON.stringify(afterDelete15))
await win15.locator('.mdf-style-row', { hasText: '夜航星' }).locator('[data-action="style-use"]').click()
await win15.waitForTimeout(200)

/* 页面模板：缺 {{content}} 被拦下；补齐后保存并设为当前 */
await win15.locator('.mdf-style-tab[data-tab="template"]').click()
await win15.waitForTimeout(200)
const tplRows15 = await win15.$$eval('.mdf-style-row', (els) => els.map((el) => el.dataset.ref))
check('模板页列出内置标准页', tplRows15.includes('builtin'), JSON.stringify(tplRows15))
await win15.locator('.mdf-style-actions [data-action="style-create"]').click()
await win15.waitForSelector('.mdf-style-editor')
await win15.fill('.mdf-style-editor input[data-field="style-name"]', '带页眉')
await win15.fill('.mdf-style-editor textarea[data-field="style-html"]', '<html><body>没有占位符</body></html>')
await win15.locator('.mdf-style-editor [data-action="style-save"]').click()
await win15.waitForTimeout(250)
const tplError15 = await win15.evaluate(
  () => document.querySelector('.mdf-style-editor .mdf-form-error')?.textContent ?? ''
)
check('模板缺 {{content}} 保存被拦下', tplError15.includes('{{content}}'), tplError15)
const tplSource = [
  '<!doctype html>',
  '<html lang="{{lang}}">',
  '<head><meta charset="utf-8"><title>{{title}}</title>{{style}}</head>',
  '<body><div class="my-shell"><p class="shell-note">由模板包了一层</p>{{content}}</div></body>',
  '</html>'
].join('\n')
await win15.fill('.mdf-style-editor textarea[data-field="style-html"]', tplSource)
await win15.locator('.mdf-style-editor [data-action="style-save"]').click()
await win15.waitForSelector('.mdf-style-editor', { state: 'detached' })
await win15.locator('.mdf-style-dialog [data-action="style-manager-done"]').click()
await win15.waitForSelector('.mdf-style-dialog', { state: 'detached' })
const styleStatus15 = await win15.textContent('#status')
check('状态栏反映新建的模板', styleStatus15.includes('带页眉'), styleStatus15)

/* 导出 HTML：自定义主题 CSS + Monokai 高亮 + 自定义页面模板一起生效 */
await openOptions15()
await win15.locator('.mdf-menu-item[data-menu-label="Monokai"]').click()
await win15.waitForTimeout(150)
await win15.keyboard.press('Escape')
await win15.waitForTimeout(150)
const themeHtml15 = await exportHtml15(styleHtmlStar)
check(
  '导出 HTML 带自定义主题与 Monokai 高亮',
  themeHtml15.includes('#010b2e') && themeHtml15.includes('pre { background: #272822; }'),
  themeHtml15.slice(0, 60)
)
const tplHtml15 = await exportHtml15(styleHtmlTpl)
check(
  '导出 HTML 套用页面模板（页眉与占位符替换）',
  tplHtml15.includes('shell-note') &&
    tplHtml15.includes('<article class="mdf-doc">') &&
    tplHtml15.includes('<title>新手记标题</title>'),
  tplHtml15.slice(0, 80)
)

await app15.close()

/* ============ P1 第二批：布局拖拽 / 命令面板 / 快捷键 / 标签 / 过滤 / 模板 / DOCX / OPML / 剪贴板 / 语法转换 ============ */
const p1bDoc = path.join(p1Dir, '排版样例.md')
writeFileSync(
  p1bDoc,
  [
    '---',
    'title: 版面样例',
    'tags: [样式]',
    '---',
    '',
    '# 版面样例',
    '',
    '带格式的普通段落，含 **加粗** 与 `行内代码`。',
    '',
    '## 小节',
    '',
    '| 列 A | 列 B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '- [ ] 待办',
    '- 普通条目',
    '',
    '```js',
    'const answer = 42',
    '```',
    '',
    '[子页](notes/child.md)',
    '',
    '![图](assets/shot.webp)',
    '',
    'filtertoken 排版样例一行。',
    ''
  ].join('\n'),
  'utf8'
)
mkdirSync(path.join(p1Dir, '草稿'), { recursive: true })
writeFileSync(
  path.join(p1Dir, '草稿', '临时.md'),
  '---\ntags: [样式, 草稿]\n---\n\n# 临时\n\nfiltertoken 的草稿记录。\n',
  'utf8'
)
writeFileSync(path.join(p1Dir, '过滤靶.md'), '# 过滤靶\n\nfiltertoken 只有这一行。\n', 'utf8')
const p1bDocx = path.join(p1Dir, '样例.docx')
const p1bOpml = path.join(p1Dir, '样例.opml')

const app16 = await _electron.launch({ executablePath: require('electron'), args: [root, p1bDoc], cwd: root })
const win16 = await app16.firstWindow()
win16.on('dialog', (d) => {
  nativeDialogs += 1
  d.accept().catch(() => {})
})
win16.on('pageerror', (e) => pageErrors.push(e.message))
win16.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
await win16.waitForSelector('.cm-content')
await win16.waitForTimeout(600)

const activeText16 = () =>
  win16.evaluate(() => {
    const shown = [...document.querySelectorAll('#editor-host .editor-mount')].find((el) => el.style.display !== 'none')
    return shown?.querySelector('.cm-content')?.innerText ?? ''
  })
const closeMenu16 = async () => {
  for (let step = 0; step < 3; step += 1) {
    if ((await win16.locator('.mdf-menu').count()) === 0) return
    await win16.keyboard.press('Escape')
    await win16.waitForTimeout(150)
  }
}
const menuOpen16 = async (top) => {
  await closeMenu16()
  await win16.click(`.mdf-menubar-button[data-menu="${top}"]`)
  await win16.waitForSelector('.mdf-menu--bar')
}
const menuPick16 = async (label) => {
  await win16.locator(`.mdf-menu-item[data-menu-label="${label}"]`).last().click()
  await win16.waitForTimeout(220)
}
const saveDialog16 = (target) =>
  app16.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
  }, target)
const clickLine16 = async (needle) => {
  const index = await win16.evaluate((text) => {
    const shown = [...document.querySelectorAll('#editor-host .editor-mount')].find((el) => el.style.display !== 'none')
    if (!shown) return -1
    return [...shown.querySelectorAll('.cm-line')].findIndex((el) => el.innerText.includes(text))
  }, needle)
  if (index < 0) {
    console.log(`  警告：找不到包含「${needle}」的行`)
    return false
  }
  await win16.locator('.cm-line:visible').nth(index).click()
  return true
}
const session16 = () => {
  try {
    return JSON.parse(readSafe(path.join(userData, 'session.json')) ?? '{}')
  } catch {
    return {}
  }
}

/* p1-0 布局：拖侧边栏分隔条与分屏分隔条 */
const sidebarBefore16 = await win16.evaluate(() => document.querySelector('#outline').getBoundingClientRect().width)
const resizerBox16 = await win16.locator('#sidebar-resizer').boundingBox()
const paneLeft16 = await win16.evaluate(() => document.querySelector('.body').getBoundingClientRect().left)
const chrome16 = await win16.evaluate(() => {
  const el = document.querySelector('#outline')
  return el.getBoundingClientRect().width - Number.parseFloat(getComputedStyle(el).width)
})
await win16.mouse.move(resizerBox16.x + 2, resizerBox16.y + 160)
await win16.mouse.down()
await win16.mouse.move(resizerBox16.x + 92, resizerBox16.y + 160, { steps: 6 })
await win16.mouse.up()
await win16.waitForTimeout(300)
const sidebarAfter16 = await win16.evaluate(() => document.querySelector('#outline').getBoundingClientRect().width)
// 分隔条跟着指针走：结束时宽度 = 指针位置 - 主区左缘（再加上内容盒与外框的差）
const expectedSidebar16 = resizerBox16.x + 92 - paneLeft16 + chrome16
check(
  '拖动分隔条调宽侧边栏',
  Math.abs(sidebarAfter16 - expectedSidebar16) < 5,
  `${sidebarBefore16} → ${sidebarAfter16}（预期 ${expectedSidebar16}）`
)
await win16.waitForTimeout(800)
check(
  '侧边栏宽度写进会话',
  Math.abs(Number(session16().sidebarWidth ?? 0) - (sidebarAfter16 - chrome16)) < 2,
  JSON.stringify(session16().sidebarWidth)
)

await menuOpen16('view')
await menuPick16('分屏预览')
await closeMenu16()
await win16.waitForTimeout(600)
const paneBefore16 = await win16.evaluate(() => document.querySelector('.split-preview').getBoundingClientRect().width)
const splitBox16 = await win16.locator('.split-resizer').boundingBox()
await win16.mouse.move(splitBox16.x + 3, splitBox16.y + 120)
await win16.mouse.down()
await win16.mouse.move(splitBox16.x - 97, splitBox16.y + 120, { steps: 6 })
await win16.mouse.up()
await win16.waitForTimeout(300)
const paneAfter16 = await win16.evaluate(() => document.querySelector('.split-preview').getBoundingClientRect().width)
check('左拖分屏分隔条扩大预览栏', paneAfter16 > paneBefore16 + 60, `${paneBefore16} → ${paneAfter16}`)
await win16.screenshot({ path: path.join(root, 'verify', 'p1b-layout.png') })
await win16.locator('.split-resizer').dblclick()
await win16.waitForTimeout(300)
const paneReset16 = await win16.evaluate(() => document.querySelector('.split-preview').getBoundingClientRect().width)
check('双击分隔条恢复到一半', Math.abs(paneReset16 - paneBefore16) < 6, `${paneReset16} vs ${paneBefore16}`)
await menuOpen16('view')
await menuPick16('分屏预览')
await closeMenu16()
await win16.waitForTimeout(400)

/* P1-1 命令面板：呼出、模糊过滤、执行、再执行可关闭、Esc 关闭 */
await win16.keyboard.press('Control+Shift+P')
await win16.waitForSelector('.mdf-palette-backdrop')
const paletteCount16 = await win16.$$eval('.mdf-palette-item', (els) => els.length)
check('命令面板呼出并列出命令', paletteCount16 > 10, String(paletteCount16))
await win16.fill('.mdf-palette-input', '打字机')
await win16.waitForTimeout(250)
const paletteFirst16 = await win16.textContent('.mdf-palette-item.is-active .mdf-palette-label')
check('命令面板模糊过滤命中', paletteFirst16 === '打字机模式', paletteFirst16)
await win16.screenshot({ path: path.join(root, 'verify', 'p1b-palette.png') })
await win16.keyboard.press('Enter')
await win16.waitForTimeout(600)
const typePadOn16 = await win16.evaluate(() => {
  const shown = [...document.querySelectorAll('#editor-host .editor-mount')].find((el) => el.style.display !== 'none')
  const content = shown?.querySelector('.cm-content')
  return content ? Number.parseFloat(getComputedStyle(content).paddingTop) : 0
})
check('命令面板里回车执行命令', typePadOn16 > 200, String(typePadOn16))
await win16.keyboard.press('Control+Shift+P')
await win16.waitForSelector('.mdf-palette-backdrop')
await win16.fill('.mdf-palette-input', '打字机')
await win16.waitForTimeout(250)
await win16.keyboard.press('Enter')
await win16.waitForTimeout(500)
const typePadOff16 = await win16.evaluate(() => {
  const shown = [...document.querySelectorAll('#editor-host .editor-mount')].find((el) => el.style.display !== 'none')
  const content = shown?.querySelector('.cm-content')
  return content ? Number.parseFloat(getComputedStyle(content).paddingTop) : 0
})
check('命令面板再次执行可关掉开关', typePadOff16 < 100, String(typePadOff16))
await win16.keyboard.press('Control+Shift+P')
await win16.waitForSelector('.mdf-palette-backdrop')
await win16.keyboard.press('Escape')
await win16.waitForTimeout(250)
check('Esc 关闭命令面板', (await win16.locator('.mdf-palette-backdrop').count()) === 0)

/* P1-2 快捷键：帮助弹窗跟随键位表；录制、冲突拦截、绑定生效与会话持久化 */
await menuOpen16('help')
await menuPick16('快捷键参考')
await win16.waitForSelector('.mdf-dialog')
const helpLines16 = await dialogText(win16)
check(
  '快捷键参考从键位表生成',
  helpLines16.includes('命令面板') && helpLines16.includes('切换代码块') && helpLines16.includes('命令面板 Ctrl+Shift+P'),
  helpLines16.slice(0, 90)
)
await answer(win16, '知道了')
await menuOpen16('help')
await menuPick16('快捷键设置…')
await win16.waitForSelector('.mdf-keymap-dialog')
await win16.locator('.keymap-row[data-command="italic"] .keymap-key').click()
await win16.keyboard.press('Control+s')
await win16.waitForTimeout(250)
const conflict16 = await win16.textContent('.keymap-notice')
check('快捷键冲突被拦下并指明目标', conflict16.includes('保存'), conflict16)
await win16.keyboard.press('Escape')
await win16.waitForTimeout(200)
await win16.locator('.keymap-row[data-command="bold"] .keymap-key').click()
await win16.keyboard.press('Control+Shift+B')
await win16.waitForTimeout(300)
const boldKey16 = await win16.textContent('.keymap-row[data-command="bold"] .keymap-key')
check('录制新组合键即时生效', boldKey16 === 'Ctrl+Shift+B', boldKey16)
await win16.screenshot({ path: path.join(root, 'verify', 'p1b-keymap.png') })
await win16.locator('.mdf-dialog-button[data-action="keymap-close"]').click()
await win16.waitForSelector('.mdf-keymap-dialog', { state: 'detached' })
await win16.waitForTimeout(900)
check(
  '自定义绑定写进会话',
  JSON.stringify(session16().keybindings ?? {}).includes('Ctrl+Shift+B'),
  JSON.stringify(session16().keybindings)
)
await clickLine16('带格式的普通段落')
await win16.keyboard.press('End')
await win16.keyboard.press('Control+Shift+B')
await win16.waitForTimeout(300)
check('新组合键在编辑器里生效', (await activeText16()).includes('****'), '')
await win16.keyboard.press('Control+z')
await win16.waitForTimeout(250)
await win16.keyboard.press('Control+b')
await win16.waitForTimeout(250)
check('旧组合键让位（不再触发加粗）', !(await activeText16()).includes('****'), '')
await menuOpen16('help')
await menuPick16('快捷键设置…')
await win16.waitForSelector('.mdf-keymap-dialog')
await win16.locator('.mdf-dialog-button[data-action="keymap-reset-all"]').click()
await win16.waitForTimeout(250)
await win16.locator('.mdf-dialog-button[data-action="keymap-close"]').click()
await win16.waitForTimeout(900)
check('全部恢复默认后会话不再有覆盖', !JSON.stringify(session16().keybindings ?? {}).includes('Ctrl+Shift+B'), '')

/* P1-6 标签页：聚合计数、按标签筛文档、点开与标签名过滤 */
await win16.click('.side-tab[data-side-tab="tags"]')
await win16.waitForSelector('.tag-item', { timeout: 9000 })
const styleChip16 = await win16.textContent('.tag-item[data-tag="样式"]')
check('标签页聚合计数', styleChip16.includes('样式') && styleChip16.includes('2'), styleChip16)
await win16.screenshot({ path: path.join(root, 'verify', 'p1b-tags.png') })
await win16.locator('.tag-item[data-tag="样式"]').click()
await win16.waitForTimeout(300)
const tagDocs16 = await win16.$$eval('.link-item[data-tag-doc-path]', (els) => els.map((el) => el.dataset.tagDocPath))
check('按标签筛出两篇文档', tagDocs16.length === 2, JSON.stringify(tagDocs16))
await win16.locator('.link-item[data-tag-doc-path]', { hasText: '临时' }).click()
await win16.waitForTimeout(600)
check('点标签下的文档能打开', (await win16.textContent('#file-name')).includes('临时'), await win16.textContent('#file-name'))
await win16.locator('.tab', { hasText: '排版样例' }).click()
await win16.waitForTimeout(400)
await win16.fill('[data-role="tags-filter"]', '草稿')
await win16.waitForTimeout(300)
const filteredChips16 = await win16.$$eval('.tag-item', (els) => els.map((el) => el.dataset.tag))
check(
  '标签名过滤只留匹配项',
  filteredChips16.includes('草稿') && !filteredChips16.includes('小说'),
  JSON.stringify(filteredChips16)
)
await win16.fill('[data-role="tags-filter"]', '')

/* P1-4 工作区搜索过滤：include / exclude glob 收窄命中文件 */
await win16.click('.side-tab[data-side-tab="search"]')
await win16.waitForSelector('.search-panel')
const searchInputs16 = win16.locator('.search-panel .search-input')
await searchInputs16.nth(0).fill('filtertoken')
await win16.locator('[data-action="search-run"]').click()
await win16.waitForTimeout(900)
const scanNote16 = await win16.textContent('[data-note="search"]')
const scanFiles16 = await win16.$$eval('.search-file', (els) => els.map((el) => el.dataset.filePath))
check('工作区搜索命中三篇文档', scanFiles16.length === 3, JSON.stringify(scanFiles16))
await searchInputs16.nth(2).fill('!草稿/**')
await win16.locator('[data-action="search-run"]').click()
await win16.waitForTimeout(900)
const exclFiles16 = await win16.$$eval('.search-file', (els) => els.map((el) => el.dataset.filePath))
check(
  '排除 glob 生效',
  exclFiles16.length === 2 && !exclFiles16.some((file) => file.includes('草稿')),
  JSON.stringify(exclFiles16)
)
await searchInputs16.nth(2).fill('临时.md')
await win16.locator('[data-action="search-run"]').click()
await win16.waitForTimeout(900)
const onlyFiles16 = await win16.$$eval('.search-file', (els) => els.map((el) => el.dataset.filePath))
check('文件名 glob 收窄到一篇', onlyFiles16.length === 1 && onlyFiles16[0].includes('临时'), JSON.stringify(onlyFiles16))
check('摘要报告过滤后的扫描数', scanNote16.includes('扫描 5 个文件'), scanNote16)
await searchInputs16.nth(2).fill('')

/* P1-5 文档模板：弹窗列出预设、回车新建、日期占位符替换 */
await menuOpen16('file')
await menuPick16('从模板新建…')
await win16.waitForSelector('.mdf-template-dialog')
const tplNames16 = await win16.$$eval('.template-name', (els) => els.map((el) => el.textContent))
check(
  '模板弹窗列出内置预设',
  tplNames16.includes('技术博客') && tplNames16.includes('会议记录') && tplNames16.length >= 4,
  JSON.stringify(tplNames16)
)
await win16.screenshot({ path: path.join(root, 'verify', 'p1b-template.png') })
await win16.keyboard.press('Enter')
await win16.waitForTimeout(600)
const tplText16 = await activeText16()
const now16 = new Date()
const stamp16 = `${now16.getFullYear()}-${String(now16.getMonth() + 1).padStart(2, '0')}-${String(now16.getDate()).padStart(2, '0')}`
check(
  '模板新建并替换日期占位符',
  tplText16.includes('title:') && tplText16.includes('实现') && tplText16.includes(stamp16) && !tplText16.includes('{{date}}'),
  tplText16.slice(0, 60)
)
await win16.locator('.tab.is-active .tab-close').click()
await win16.waitForSelector('.mdf-dialog')
await answer(win16, '不保存关闭')
await win16.waitForTimeout(400)
// 关掉模板标签后回到「排版样例」，后续导出都基于它
await win16.locator('.tab', { hasText: '排版样例' }).click()
await win16.waitForTimeout(400)
await closeMenu16()

/* P1-3 导出：DOCX（zip 结构 + 正文 XML + 图片）与 OPML（标题树） */
await saveDialog16(p1bDocx)
await menuOpen16('file')
await menuPick16('导出')
await win16.waitForSelector('.mdf-menu--sub')
const exportLabels16 = await win16.$$eval('.mdf-menu--sub .mdf-menu-item', (els) => els.map((el) => el.dataset.menuLabel))
check(
  '导出菜单含 Word 与 OPML',
  ['导出 Word (DOCX)…', '导出 OPML 大纲…'].every((label) => exportLabels16.includes(label)),
  JSON.stringify(exportLabels16)
)
await win16.locator('.mdf-menu--sub .mdf-menu-item[data-menu-label="导出 Word (DOCX)…"]').click()
await waitForFile(() => existsSync(p1bDocx), 25000)
const docxBytes16 = existsSync(p1bDocx) ? readFileSync(p1bDocx) : Buffer.alloc(0)
check(
  'DOCX 包结构完整（样式/编号/图片部件）',
  docxBytes16.includes('word/styles.xml') &&
    docxBytes16.includes('word/numbering.xml') &&
    docxBytes16.includes('word/media/image1.webp'),
  `size=${docxBytes16.length}`
)
const docxXml16 = inflateEntry(docxBytes16, 'word/document.xml')
check(
  'DOCX 正文含标题/编号/表格/图片关系',
  docxXml16.includes('Heading1') &&
    docxXml16.includes('w:numId') &&
    docxXml16.includes('<w:tbl>') &&
    docxXml16.includes('r:embed="I'),
  docxXml16.slice(0, 80)
)
const docxRels16 = inflateEntry(docxBytes16, 'word/_rels/document.xml.rels')
check('DOCX 关系表含超链接与图片', docxRels16.includes('TargetMode="External"') && docxRels16.includes('media/image1.webp'), '')

await saveDialog16(p1bOpml)
await menuOpen16('file')
await menuPick16('导出')
await win16.waitForSelector('.mdf-menu--sub')
await win16.locator('.mdf-menu--sub .mdf-menu-item[data-menu-label="导出 OPML 大纲…"]').click()
await waitForFile(() => existsSync(p1bOpml), 15000)
const opml16 = readSafe(p1bOpml) ?? ''
check(
  'OPML 大纲含标题层级、任务标记与备注',
  opml16.includes('<opml version="2.0">') && opml16.includes('text="小节"') && opml16.includes('☐') && opml16.includes('_note='),
  opml16.replace(/\n/g, ' ').slice(0, 90)
)

/* P1-7 剪贴板：菜单复制写 HTML 格式；图片管理器复制图片写位图 */
await win16.locator('.cm-line:visible').first().click()
await win16.keyboard.press('Control+a')
await menuOpen16('edit')
await menuPick16('复制')
await win16.waitForTimeout(500)
const clip16 = await app16.evaluate(async ({ clipboard }) => {
  const items = await clipboard.read()
  const types = items.flatMap((item) => item.types)
  let html = ''
  for (const item of items) {
    const type = item.types.find((candidate) => candidate.toLowerCase() === 'text/html')
    if (!type) continue
    const value = await item.getType(type)
    if (typeof value === 'string') html = value
    else if (value instanceof Blob) html = await value.text()
  }
  return { types, html }
})
check(
  '菜单复制写入 HTML 格式（表格保留）',
  clip16.types.some((type) => type.toLowerCase() === 'text/html') && clip16.html.includes('<table'),
  JSON.stringify(clip16.types)
)
await win16.click('.side-tab[data-side-tab="assets"]')
await win16.waitForSelector('.asset-item', { timeout: 9000 })
// 导出产物里也有同名图片，取列表里的第一张即可（都指向有效的 webp 文件）
await win16
  .locator('.asset-item[data-asset-name="shot.webp"] [data-action="assets-copy"]')
  .first()
  .click()
// webp 要经画布转 PNG 再写剪贴板：轮询状态栏与剪贴板内容
const copyNote16 = await until(
  () => win16.textContent('#status'),
  (text) => text.includes('已复制图片'),
  10000
)
check('图片复制按钮回执', copyNote16.includes('已复制图片'), copyNote16)
const clipTypes16 = await until(
  () => app16.evaluate(async ({ clipboard }) => (await clipboard.read()).flatMap((item) => item.types)),
  (types) => types.some((type) => type.toLowerCase().startsWith('image/')),
  6000
)
check(
  '剪贴板里出现图片数据',
  clipTypes16.some((type) => type.toLowerCase().startsWith('image/')),
  JSON.stringify(clipTypes16)
)

/* P1-8 语法转换：以磁盘上的正文为准断言（编辑器会隐藏 # 与任务标记） */
const convFile16 = () => readSafe(p1bDoc) ?? ''
const fenceCount16 = (text) => (text.match(/```/g) ?? []).length
await clickLine16('带格式的普通段落')
await win16.keyboard.press('End')
await win16.keyboard.press('Control+Shift+K')
await win16.waitForTimeout(250)
await saveDoc(win16)
await win16.waitForTimeout(700)
check('切换代码块包裹段落', fenceCount16(convFile16()) === 4, `fences=${fenceCount16(convFile16())}`)
await win16.keyboard.press('Control+Shift+K')
await win16.waitForTimeout(250)
await saveDoc(win16)
await win16.waitForTimeout(700)
check('再按一次拆掉围栏', fenceCount16(convFile16()) === 2, `fences=${fenceCount16(convFile16())}`)
await clickLine16('待办')
await win16.keyboard.press('Control+Shift+C')
await win16.waitForTimeout(250)
await saveDoc(win16)
await win16.waitForTimeout(700)
check('切换任务勾选', convFile16().includes('- [x] 待办'), '')
await clickLine16('小节')
await win16.keyboard.press('Control+Alt+=')
await win16.waitForTimeout(250)
await saveDoc(win16)
await win16.waitForTimeout(700)
check('提升标题级别', convFile16().includes('\n# 小节'), convFile16().split('\n').filter((line) => line.includes('小节')).join('|'))
await win16.keyboard.press('Control+Alt+-')
await win16.waitForTimeout(250)
await saveDoc(win16)
await win16.waitForTimeout(700)
check('降低标题级别', convFile16().includes('\n## 小节'), '')
await clickLine16('filtertoken 排版样例一行')
await win16.keyboard.press('End')
await win16.keyboard.press('Enter')
await win16.keyboard.type('[] 收集')
await win16.waitForTimeout(400)
await saveDoc(win16)
await win16.waitForTimeout(700)
check('行首 [] + 空格转任务列表', convFile16().includes('- [ ] 收集'), '')

await app16.close()

const windowStateFile = path.join(process.env.APPDATA ?? homedir(), 'mdforge-editor', 'window-state.json')
check('关闭时记住窗口尺寸位置', existsSync(windowStateFile), windowStateFile)
const sessionStyles15 = readSafe(path.join(userData, 'session.json')) ?? ''
check(
  '自定义主题与模板的引用随会话持久化',
  sessionStyles15.includes('"theme": "custom:') && sessionStyles15.includes('"template": "custom:'),
  sessionStyles15.slice(0, 160)
)
check('全流程不使用原生对话框', nativeDialogs === 0, `count=${nativeDialogs}`)
check('渲染进程无未捕获错误', pageErrors.length === 0, pageErrors.join(' | '))
if (consoleErrors.length > 0) console.log(`控制台错误：\n  ${consoleErrors.slice(0, 6).join('\n  ')}`)

await app.close()

console.log(failures.length === 0 ? '\n端到端验证全部通过' : `\n失败项：${failures.join(', ')}`)
process.exitCode = failures.length === 0 ? 0 : 1
