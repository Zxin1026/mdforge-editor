/**
 * 应用菜单的条目定义。
 * 只列真能执行的项；右侧提示只写实际绑定了的快捷键，不做装饰。
 */

import {
  CONTENT_WIDTHS,
  CONTENT_WIDTH_PX,
  FONT_SIZES,
  type AppTheme,
  type ContentWidth,
  type EditorFontSize,
  type UpdateCheckOutcome,
  type UpdateEvent,
  type ViewMode
} from '../../shared/ipc'
import { askDialog } from './dialog'
import type { EditorAction, EditorFacts } from './editor/actions'
import type { MenuEntry } from './menu'
import type { MenuBarMenu } from './menubar'

export interface AppMenuContext {
  newDoc(): void
  openDoc(): void
  openFolder(): void
  save(): void
  saveAs(): void
  saveAll(): void
  closeTab(): void
  reveal(): void
  quit(): void
  recents(): string[]
  openRecent(path: string): void
  exportEntries(): MenuEntry[]
  runEditor(action: EditorAction): void
  editorFacts(): EditorFacts
  sourceMode(): boolean
  toggleSourceMode(): void
  viewMode(): ViewMode
  setViewMode(mode: ViewMode): void
  typewriter(): boolean
  toggleTypewriter(): void
  focusMode(): boolean
  toggleFocusMode(): void
  sidebar(): boolean
  toggleSidebar(): void
  inspect(): void
  assetsManager(): void
  workspaceSearch(): void
  navBack(): void
  navForward(): void
  canNavBack(): boolean
  canNavForward(): boolean
  /** 导航 → 反向链接：切到链接页 */
  backlinks(): void
  openGraph(): void
  zoom(): number
  zoomIn(): void
  zoomOut(): void
  zoomReset(): void
  fontSize(): EditorFontSize
  setFontSize(size: EditorFontSize): void
  contentWidth(): ContentWidth
  setContentWidth(width: ContentWidth): void
  fullScreen(): boolean
  toggleFullScreen(): void
  alwaysOnTop(): boolean
  toggleAlwaysOnTop(): void
  openDevTools(): void
  theme(): AppTheme
  setTheme(mode: AppTheme): void
  appVersion(): Promise<string>
  checkUpdates(): Promise<UpdateCheckOutcome>
  downloadUpdate(): Promise<boolean>
  installUpdate(): void
  /** 重启更新前：有未保存内容时先走保存确认；返回是否放行 */
  settleForRestart(): Promise<boolean>
}

const FONT_SIZE_LABELS: Record<EditorFontSize, string> = {
  13: '小 (13 px)',
  14: '标准 (14 px)',
  15: '大 (15 px)',
  16: '特大 (16 px)'
}

const WIDTH_LABELS: Record<ContentWidth, string> = {
  narrow: `窄 (${CONTENT_WIDTH_PX.narrow} px)`,
  medium: `中 (${CONTENT_WIDTH_PX.medium} px)`,
  wide: `宽 (${CONTENT_WIDTH_PX.wide} px)`,
  full: '铺满'
}

const SHORTCUT_LINES = [
  '文件：Ctrl+N 新建 · Ctrl+O 打开 · Ctrl+S 保存 · Ctrl+Shift+S 另存为 · Ctrl+W 关闭标签页',
  '编辑：Ctrl+Z 撤销 · Ctrl+Y 重做 · Ctrl+X 剪切 · Ctrl+C 复制 · Ctrl+V 粘贴 · Ctrl+A 全选',
  '查找：Ctrl+F 当前文档 · Ctrl+H 替换 · Ctrl+Shift+F 工作区搜索 · F3 下一个 · Shift+F3 上一个',
  '导航：Alt+← 后退 · Alt+→ 前进',
  '格式：Ctrl+B 加粗 · Ctrl+I 斜体 · Ctrl+Shift+X 删除线 · Ctrl+` 行内代码',
  '段落：Ctrl+1…6 标题 · Ctrl+0 正文 · Ctrl+Shift+Q 引用 · Ctrl+Shift+L / O / T 列表 · Ctrl+Alt+T 表格',
  '视图：Ctrl+/ 源代码模式 · Ctrl+= 放大 · Ctrl+- 缩小 · Ctrl+Shift+0 实际大小 · F11 全屏 · F12 开发者工具',
  '链接：Ctrl+点击 打开链接或跳转锚点 · 列表与引用里 Enter 自动续写'
]

async function showShortcuts(): Promise<void> {
  await askDialog<boolean>({
    title: '快捷键参考',
    lines: SHORTCUT_LINES,
    options: [{ label: '知道了', value: true, kind: 'default' }],
    cancelValue: true
  })
}

async function showAbout(ctx: AppMenuContext): Promise<void> {
  const version = await ctx.appVersion()
  await askDialog<boolean>({
    title: '关于 MDForge',
    body: 'MDForge —— 所见即所得的 Markdown 编辑器',
    note: `版本 ${version}`,
    options: [{ label: '好的', value: true, kind: 'default' }],
    cancelValue: true
  })
}

/** 帮助菜单的"检查更新"：available / downloaded 的弹窗由更新事件推送，不在这里重复 */
async function checkForUpdates(ctx: AppMenuContext): Promise<void> {
  const outcome = await ctx.checkUpdates()
  if (outcome.status === 'available' || outcome.status === 'downloaded') return
  if (outcome.status === 'downloading') {
    await askDialog<boolean>({
      title: '检查更新',
      body: `新版本 v${outcome.version} 正在后台下载`,
      note: '下载完成后会提醒你重启安装',
      options: [{ label: '知道了', value: true, kind: 'default' }],
      cancelValue: true
    })
    return
  }
  if (outcome.status === 'latest') {
    await askDialog<boolean>({
      title: '检查更新',
      body: '当前已是最新版本',
      note: `版本 ${outcome.version}`,
      options: [{ label: '好的', value: true, kind: 'default' }],
      cancelValue: true
    })
    return
  }
  if (outcome.status === 'unavailable') {
    await askDialog<boolean>({
      title: '检查更新',
      body: '当前运行方式不支持自动更新',
      note: '开发模式与便携版请到 GitHub 发布页手动下载新版本',
      options: [{ label: '好的', value: true, kind: 'default' }],
      cancelValue: true
    })
    return
  }
  await askDialog<boolean>({
    title: '检查更新',
    body: '检查失败，可能是网络无法访问 GitHub',
    note: '稍后再试；自动检查也会在下次启动时继续',
    options: [{ label: '好的', value: true, kind: 'default' }],
    cancelValue: true
  })
}

/** 主进程推来的更新事件：下载询问 / 重启提醒 / 下载失败，全用应用内对话框 */
export async function handleUpdateEvent(event: UpdateEvent, ctx: AppMenuContext): Promise<void> {
  if (event.kind === 'available') {
    const choice = await askDialog<'download' | 'later'>({
      title: '发现新版本',
      body: `MDForge ${event.version} 已发布，是否现在下载？`,
      note: '下载在后台进行，完成后会提醒你重启安装',
      options: [
        { label: '下载更新', value: 'download', kind: 'default' },
        { label: '稍后', value: 'later' }
      ],
      cancelValue: 'later'
    })
    if (choice !== 'download') return
    if (!(await ctx.downloadUpdate())) return
    await askDialog<boolean>({
      title: '正在下载更新',
      body: `v${event.version} 已在后台下载`,
      note: '下载期间可以继续编辑，完成后会再提醒',
      options: [{ label: '知道了', value: true, kind: 'default' }],
      cancelValue: true
    })
    return
  }
  if (event.kind === 'downloaded') {
    const choice = await askDialog<'restart' | 'later'>({
      title: '更新已就绪',
      body: `v${event.version} 已下载完成，重启后生效`,
      note: '选“退出时自动安装”后，下次正常退出 MDForge 会自动完成安装',
      options: [
        { label: '立即重启安装', value: 'restart', kind: 'default' },
        { label: '退出时自动安装', value: 'later' }
      ],
      cancelValue: 'later'
    })
    if (choice !== 'restart') return
    // 有未保存内容先走保存确认；取消就留在当前版本，下次再提醒
    if (!(await ctx.settleForRestart())) return
    ctx.installUpdate()
    return
  }
  await askDialog<boolean>({
    title: '更新下载失败',
    body: '可能是网络波动或无法访问 GitHub',
    note: '稍后可在“帮助 → 检查更新”里重试',
    options: [{ label: '知道了', value: true, kind: 'default' }],
    cancelValue: true
  })
}

function splitPath(target: string): { name: string; dir: string } {
  const parts = target.split(/[\\/]/)
  return { name: parts[parts.length - 1] || target, dir: parts[parts.length - 2] ?? '' }
}

function fileMenu(ctx: AppMenuContext): MenuBarMenu {
  return {
    key: 'file',
    label: '文件',
    mnemonic: 'f',
    build: () => {
      const recents = ctx.recents()
      return [
        { label: '新建', hint: 'Ctrl+N', run: () => ctx.newDoc() },
        { label: '打开…', hint: 'Ctrl+O', run: () => ctx.openDoc() },
        { label: '打开文件夹…', run: () => ctx.openFolder() },
        {
          label: '最近打开',
          children:
            recents.length === 0
              ? [{ label: '暂无最近打开', disabled: true }]
              : recents.map((path) => {
                  const { name, dir } = splitPath(path)
                  return { label: name, hint: dir, run: () => ctx.openRecent(path) }
                })
        },
        { divider: true, label: '' },
        { label: '保存', hint: 'Ctrl+S', run: () => ctx.save() },
        { label: '另存为…', hint: 'Ctrl+Shift+S', run: () => ctx.saveAs() },
        { label: '全部保存', run: () => ctx.saveAll() },
        { divider: true, label: '' },
        { label: '导出', children: () => ctx.exportEntries() },
        { divider: true, label: '' },
        { label: '在文件夹中显示', run: () => ctx.reveal() },
        { divider: true, label: '' },
        { label: '关闭标签页', hint: 'Ctrl+W', run: () => ctx.closeTab() },
        { label: '退出', hint: 'Alt+F4', run: () => ctx.quit() }
      ]
    }
  }
}

function editMenu(ctx: AppMenuContext): MenuBarMenu {
  return {
    key: 'edit',
    label: '编辑',
    mnemonic: 'e',
    build: () => {
      const facts = ctx.editorFacts()
      return [
        { label: '撤销', hint: 'Ctrl+Z', disabled: !facts.canUndo, run: () => ctx.runEditor('undo') },
        { label: '重做', hint: 'Ctrl+Y', disabled: !facts.canRedo, run: () => ctx.runEditor('redo') },
        { divider: true, label: '' },
        { label: '剪切', hint: 'Ctrl+X', disabled: !facts.hasSelection, run: () => ctx.runEditor('cut') },
        { label: '复制', hint: 'Ctrl+C', disabled: !facts.hasSelection, run: () => ctx.runEditor('copy') },
        { label: '粘贴', hint: 'Ctrl+V', run: () => ctx.runEditor('paste') },
        { label: '全选', hint: 'Ctrl+A', run: () => ctx.runEditor('selectAll') },
        { divider: true, label: '' },
        { label: '查找', hint: 'Ctrl+F', run: () => ctx.runEditor('find') },
        { label: '替换', hint: 'Ctrl+H', run: () => ctx.runEditor('replace') },
        { label: '在工作区中查找…', hint: 'Ctrl+Shift+F', run: () => ctx.workspaceSearch() },
        { label: '查找下一个', hint: 'F3', run: () => ctx.runEditor('findNext') },
        { label: '查找上一个', hint: 'Shift+F3', run: () => ctx.runEditor('findPrevious') },
        { label: '全部替换', run: () => ctx.runEditor('replaceAll') }
      ]
    }
  }
}

function paragraphMenu(ctx: AppMenuContext): MenuBarMenu {
  return {
    key: 'paragraph',
    label: '段落',
    mnemonic: 'p',
    build: () => [
      {
        label: '标题',
        children: [
          { label: '一级标题', hint: 'Ctrl+1', run: () => ctx.runEditor('heading1') },
          { label: '二级标题', hint: 'Ctrl+2', run: () => ctx.runEditor('heading2') },
          { label: '三级标题', hint: 'Ctrl+3', run: () => ctx.runEditor('heading3') },
          { label: '四级标题', hint: 'Ctrl+4', run: () => ctx.runEditor('heading4') },
          { label: '五级标题', hint: 'Ctrl+5', run: () => ctx.runEditor('heading5') },
          { label: '六级标题', hint: 'Ctrl+6', run: () => ctx.runEditor('heading6') },
          { divider: true, label: '' },
          { label: '正文', hint: 'Ctrl+0', run: () => ctx.runEditor('body') }
        ]
      },
      { divider: true, label: '' },
      { label: '引用', hint: 'Ctrl+Shift+Q', run: () => ctx.runEditor('quote') },
      { divider: true, label: '' },
      { label: '无序列表', hint: 'Ctrl+Shift+L', run: () => ctx.runEditor('bulletList') },
      { label: '有序列表', hint: 'Ctrl+Shift+O', run: () => ctx.runEditor('orderedList') },
      { label: '任务列表', hint: 'Ctrl+Shift+T', run: () => ctx.runEditor('taskList') },
      { divider: true, label: '' },
      { label: '表格', hint: 'Ctrl+Alt+T', run: () => ctx.runEditor('table') },
      { divider: true, label: '' },
      { label: '上移一行', hint: 'Alt+↑', run: () => ctx.runEditor('moveLineUp') },
      { label: '下移一行', hint: 'Alt+↓', run: () => ctx.runEditor('moveLineDown') }
    ]
  }
}

function formatMenu(ctx: AppMenuContext): MenuBarMenu {
  return {
    key: 'format',
    label: '格式',
    mnemonic: 'o',
    build: () => [
      { label: '加粗', hint: 'Ctrl+B', run: () => ctx.runEditor('bold') },
      { label: '斜体', hint: 'Ctrl+I', run: () => ctx.runEditor('italic') },
      { label: '删除线', hint: 'Ctrl+Shift+X', run: () => ctx.runEditor('strike') },
      { label: '行内代码', hint: 'Ctrl+`', run: () => ctx.runEditor('inlineCode') },
      { divider: true, label: '' },
      { label: '文档信息（Front Matter）…', run: () => ctx.runEditor('frontMatter') }
    ]
  }
}

function viewMenu(ctx: AppMenuContext): MenuBarMenu {
  return {
    key: 'view',
    label: '视图',
    mnemonic: 'v',
    build: () => {
      const zoom = ctx.zoom()
      const percent = Math.round(zoom * 100)
      return [
        {
          label: '源代码模式',
          hint: 'Ctrl+/',
          checked: ctx.sourceMode(),
          run: () => ctx.toggleSourceMode()
        },
        {
          label: '分屏预览',
          hint: '左栏源码 · 右栏渲染',
          checked: ctx.viewMode() === 'split',
          keepOpen: true,
          run: () => ctx.setViewMode(ctx.viewMode() === 'split' ? 'edit' : 'split')
        },
        {
          label: '阅读模式',
          hint: '只读，不动内容',
          checked: ctx.viewMode() === 'read',
          keepOpen: true,
          run: () => ctx.setViewMode(ctx.viewMode() === 'read' ? 'edit' : 'read')
        },
        {
          label: '打字机模式',
          hint: '光标行始终居中',
          checked: ctx.typewriter(),
          keepOpen: true,
          run: () => ctx.toggleTypewriter()
        },
        {
          label: '专注模式',
          hint: '只突出当前段落',
          checked: ctx.focusMode(),
          keepOpen: true,
          run: () => ctx.toggleFocusMode()
        },
        { label: '侧边栏', checked: ctx.sidebar(), keepOpen: true, run: () => ctx.toggleSidebar() },
        { label: '图片资源管理器', run: () => ctx.assetsManager() },
        { label: '文档检查', run: () => ctx.inspect() },
        { divider: true, label: '' },
        {
          label: '实际大小',
          hint: zoom === 1 ? undefined : `${percent}%`,
          checked: zoom === 1,
          keepOpen: true,
          run: () => ctx.zoomReset()
        },
        { label: '放大', hint: 'Ctrl+=', keepOpen: true, run: () => ctx.zoomIn() },
        { label: '缩小', hint: 'Ctrl+-', keepOpen: true, run: () => ctx.zoomOut() },
        { divider: true, label: '' },
        {
          label: '字体大小',
          // 惰性求值：keepOpen 重绘时重新算 checked，勾选才能跟着走
          children: () =>
            FONT_SIZES.map((size) => ({
              label: FONT_SIZE_LABELS[size],
              checked: ctx.fontSize() === size,
              keepOpen: true,
              run: () => ctx.setFontSize(size)
            }))
        },
        {
          label: '编辑区宽度',
          children: () =>
            CONTENT_WIDTHS.map((width) => ({
              label: WIDTH_LABELS[width],
              checked: ctx.contentWidth() === width,
              keepOpen: true,
              run: () => ctx.setContentWidth(width)
            }))
        },
        { divider: true, label: '' },
        { label: '全屏', hint: 'F11', checked: ctx.fullScreen(), keepOpen: true, run: () => ctx.toggleFullScreen() },
        {
          label: '保持窗口在最前端',
          checked: ctx.alwaysOnTop(),
          keepOpen: true,
          run: () => ctx.toggleAlwaysOnTop()
        },
        { divider: true, label: '' },
        { label: '开发者工具', hint: 'F12', run: () => ctx.openDevTools() }
      ]
    }
  }
}

function navMenu(ctx: AppMenuContext): MenuBarMenu {
  return {
    key: 'nav',
    label: '导航',
    mnemonic: 'n',
    build: () => [
      { label: '后退', hint: 'Alt+←', disabled: !ctx.canNavBack(), run: () => ctx.navBack() },
      { label: '前进', hint: 'Alt+→', disabled: !ctx.canNavForward(), run: () => ctx.navForward() },
      { divider: true, label: '' },
      { label: '反向链接', hint: '谁链接到当前文档', run: () => ctx.backlinks() },
      { label: '文档关系图…', run: () => ctx.openGraph() }
    ]
  }
}

function themeMenu(ctx: AppMenuContext): MenuBarMenu {
  return {
    key: 'theme',
    label: '主题',
    mnemonic: 't',
    build: () => [
      { label: '浅色', checked: ctx.theme() === 'light', keepOpen: true, run: () => ctx.setTheme('light') },
      { label: '深色', checked: ctx.theme() === 'dark', keepOpen: true, run: () => ctx.setTheme('dark') },
      { divider: true, label: '' },
      {
        label: '护眼',
        hint: '暖色纸感 · sepia',
        checked: ctx.theme() === 'sepia',
        keepOpen: true,
        run: () => ctx.setTheme('sepia')
      },
      {
        label: '高对比度',
        hint: '黑底高反差',
        checked: ctx.theme() === 'high-contrast',
        keepOpen: true,
        run: () => ctx.setTheme('high-contrast')
      },
      { divider: true, label: '' },
      {
        label: '跟随系统',
        hint: '随系统深浅色切换',
        checked: ctx.theme() === 'system',
        keepOpen: true,
        run: () => ctx.setTheme('system')
      }
    ]
  }
}

function helpMenu(ctx: AppMenuContext): MenuBarMenu {
  return {
    key: 'help',
    label: '帮助',
    mnemonic: 'h',
    build: () => [
      { label: '快捷键参考', run: () => void showShortcuts() },
      { divider: true, label: '' },
      { label: '检查更新', run: () => void checkForUpdates(ctx) },
      { label: '关于 MDForge', run: () => void showAbout(ctx) }
    ]
  }
}

export function appMenus(ctx: AppMenuContext): MenuBarMenu[] {
  return [
    fileMenu(ctx),
    editMenu(ctx),
    paragraphMenu(ctx),
    formatMenu(ctx),
    viewMenu(ctx),
    navMenu(ctx),
    themeMenu(ctx),
    helpMenu(ctx)
  ]
}

/** 编辑器区右键菜单：只列与当前选区/剪贴板/格式相关的动作，快捷键提示与菜单栏同一份 */
export function contextMenuEntries(ctx: AppMenuContext): MenuEntry[] {
  const facts = ctx.editorFacts()
  return [
    { label: '撤销', hint: 'Ctrl+Z', disabled: !facts.canUndo, run: () => ctx.runEditor('undo') },
    { label: '重做', hint: 'Ctrl+Y', disabled: !facts.canRedo, run: () => ctx.runEditor('redo') },
    { divider: true, label: '' },
    { label: '剪切', hint: 'Ctrl+X', disabled: !facts.hasSelection, run: () => ctx.runEditor('cut') },
    { label: '复制', hint: 'Ctrl+C', disabled: !facts.hasSelection, run: () => ctx.runEditor('copy') },
    { label: '粘贴', hint: 'Ctrl+V', run: () => ctx.runEditor('paste') },
    { label: '全选', hint: 'Ctrl+A', run: () => ctx.runEditor('selectAll') },
    { divider: true, label: '' },
    { label: '加粗', hint: 'Ctrl+B', run: () => ctx.runEditor('bold') },
    { label: '斜体', hint: 'Ctrl+I', run: () => ctx.runEditor('italic') },
    { label: '删除线', hint: 'Ctrl+Shift+X', run: () => ctx.runEditor('strike') },
    { label: '行内代码', hint: 'Ctrl+`', run: () => ctx.runEditor('inlineCode') },
    { divider: true, label: '' },
    { label: '插入表格', hint: 'Ctrl+Alt+T', run: () => ctx.runEditor('table') },
    { divider: true, label: '' },
    { label: '查找', hint: 'Ctrl+F', run: () => ctx.runEditor('find') },
    { label: '替换', hint: 'Ctrl+H', run: () => ctx.runEditor('replace') },
    { label: '在工作区中查找…', hint: 'Ctrl+Shift+F', run: () => ctx.workspaceSearch() }
  ]
}
