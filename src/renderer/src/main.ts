import './assets/main.css'
// KaTeX 的样式与字体在入口统一引入：模块内的 css 副作用导入只有 web 配置认得
import 'katex/dist/katex.min.css'
import type { AppTheme } from '../../shared/ipc'
import { appMenus, contextMenuEntries, handleUpdateEvent, type AppMenuContext } from './app-menu'
import { openContextMenu } from './context-menu'
import { dialogOpen } from './dialog'
import { appKeyMap, effectiveKey, keyFromEvent } from './keybindings'
import { openKeybindingDialog } from './keybinding-dialog'
import type { MenuHandle } from './menu'
import { createMenuBar } from './menubar'
import { toggleCommandPalette } from './palette'
import { createTheme } from './theme'
import { Workspace } from './workspace'

const root = document.querySelector<HTMLDivElement>('#root')

root!.innerHTML = `
  <div class="app">
    <div id="menubar" class="mdf-menubar"></div>
    <div id="tabbar" class="tabbar"></div>
    <div class="body">
      <aside id="outline" class="outline"></aside>
      <div
        id="sidebar-resizer"
        class="pane-resizer"
        data-resizer="sidebar"
        title="拖动调整侧边栏宽度（双击恢复默认）"
      ></div>
      <div id="editor-host" class="editor-host"></div>
    </div>
    <div class="status-bar">
      <div id="status" class="status"></div>
      <span id="file-name" class="name"></span>
      <button id="btn-autosave" class="chip" type="button"></button>
      <button id="file-meta" class="chip" type="button" title="点击切换编码与换行符"></button>
      <div id="status-metrics" class="status-metrics"></div>
    </div>
  </div>
`

async function boot(): Promise<void> {
  // 主题先于一切建好：首帧就定下浅色/深色，避免启动时闪一下亮色
  const session = await window.mdforge.sessionRead()
  const theme = createTheme(session?.theme ?? 'system')

  const workspace = new Workspace({
    editorHost: document.querySelector<HTMLDivElement>('#editor-host')!,
    tabbar: document.querySelector<HTMLDivElement>('#tabbar')!,
    outline: document.querySelector<HTMLElement>('#outline')!,
    sidebarResizer: document.querySelector<HTMLElement>('#sidebar-resizer')!,
    paneBody: document.querySelector<HTMLElement>('.body')!,
    nameEl: document.querySelector<HTMLSpanElement>('#file-name')!,
    metaEl: document.querySelector<HTMLButtonElement>('#file-meta')!,
    autoSaveEl: document.querySelector<HTMLButtonElement>('#btn-autosave')!,
    statusNote: document.querySelector<HTMLDivElement>('#status')!,
    statusMetrics: document.querySelector<HTMLDivElement>('#status-metrics')!,
    themeMode: () => theme.mode()
  })

  // 全屏/置顶的状态只有菜单能改，缓存在这里给勾选状态用
  const viewState = { fullScreen: false, onTop: false }

  function toggleFullScreen(): void {
    viewState.fullScreen = !viewState.fullScreen
    void window.mdforge.toggleFullScreen().then((next) => {
      viewState.fullScreen = next
      menus.refresh()
    })
  }

  function toggleAlwaysOnTop(): void {
    viewState.onTop = !viewState.onTop
    void window.mdforge.setAlwaysOnTop(viewState.onTop).then((next) => {
      viewState.onTop = next
      menus.refresh()
    })
  }

  const menuCtx: AppMenuContext = {
    newDoc: () => workspace.openNew(),
    newFromTemplate: () => void workspace.openNewFromTemplate(),
    openDoc: () => void workspace.openViaDialog(),
    openFolder: () => void workspace.openFolderViaDialog(),
    save: () => void workspace.save(),
    saveAs: () => void workspace.saveAs(),
    saveAll: () => void workspace.saveAll(),
    closeTab: () => void workspace.closeActive(),
    reveal: () => workspace.revealActive(),
    quit: () => void window.mdforge.closeWindow(),
    recents: () => workspace.recentPaths(),
    openRecent: (path) => void workspace.openPath(path),
    exportEntries: () => workspace.exportEntries(),
    runEditor: (action) => workspace.runActive(action),
    editorFacts: () => workspace.editorFacts(),
    sourceMode: () => workspace.sourceMode(),
    toggleSourceMode: () => workspace.toggleSourceMode(),
    viewMode: () => workspace.viewModeOf(),
    setViewMode: (mode) => workspace.setViewMode(mode),
    typewriter: () => workspace.typewriter(),
    toggleTypewriter: () => workspace.toggleTypewriter(),
    focusMode: () => workspace.focusMode(),
    toggleFocusMode: () => workspace.toggleFocusMode(),
    sidebar: () => workspace.sidebarVisible(),
    toggleSidebar: () => workspace.toggleSidebar(),
    inspect: () => workspace.openInspect(),
    assetsManager: () => workspace.openAssetsView(),
    workspaceSearch: () => workspace.openWorkspaceSearch(),
    navBack: () => workspace.navBack(),
    navForward: () => workspace.navForward(),
    canNavBack: () => workspace.canNavBack(),
    canNavForward: () => workspace.canNavForward(),
    backlinks: () => workspace.openBacklinks(),
    openGraph: () => workspace.openGraphView(),
    zoom: () => workspace.zoom(),
    zoomIn: () => workspace.zoomIn(),
    zoomOut: () => workspace.zoomOut(),
    zoomReset: () => workspace.zoomReset(),
    fontSize: () => workspace.fontSize(),
    setFontSize: (size) => workspace.setFontSize(size),
    contentWidth: () => workspace.contentWidth(),
    setContentWidth: (width) => workspace.setContentWidth(width),
    fullScreen: () => viewState.fullScreen,
    toggleFullScreen,
    alwaysOnTop: () => viewState.onTop,
    toggleAlwaysOnTop,
    openDevTools: () => void window.mdforge.openDevTools(),
    theme: () => theme.mode(),
    setTheme: (mode: AppTheme) => {
      theme.set(mode)
      workspace.persistSoon()
    },
    appVersion: () => window.mdforge.appVersion(),
    checkUpdates: () => window.mdforge.checkUpdates(),
    downloadUpdate: () => window.mdforge.downloadUpdate(),
    installUpdate: () => window.mdforge.installUpdate(),
    settleForRestart: () => workspace.settleForRestart(),
    commandPalette: () => toggleCommandPalette(menuCtx),
    editKeybindings: () => openKeybindingDialog()
  }

  const menus = createMenuBar(document.querySelector<HTMLDivElement>('#menubar')!, appMenus(menuCtx), {
    onEscape: () => workspace.focusActive()
  })

  // 编辑器区右键：条目按当前选区状态生成；重开前先收掉上一个
  let contextMenu: MenuHandle | null = null
  document.addEventListener('contextmenu', (event) => {
    const target = event.target as HTMLElement | null
    if (!target || target.closest('#editor-host') === null) return
    event.preventDefault()
    contextMenu?.close()
    contextMenu = openContextMenu({ x: event.clientX, y: event.clientY }, contextMenuEntries(menuCtx), () => {
      contextMenu = null
    })
  })

  // 深浅色一变，按主题渲染的块（mermaid 等）要重画
  theme.onChange(() => workspace.applyTheme())

  document.querySelector('#btn-autosave')!.addEventListener('click', () => workspace.toggleAutoSave())

  // ---- 窗口级快捷键：统一从键位表读（帮助 → 快捷键设置里可改）----
  const appCommands: Record<string, () => void> = {
    new: () => workspace.openNew(),
    open: () => void workspace.openViaDialog(),
    save: () => void workspace.save(),
    saveAs: () => void workspace.saveAs(),
    closeTab: () => void workspace.closeActive(),
    workspaceSearch: () => workspace.openWorkspaceSearch(),
    replace: () => workspace.runActive('replace'),
    sourceMode: () => workspace.toggleSourceMode(),
    palette: () => toggleCommandPalette(menuCtx),
    zoomIn: () => workspace.zoomIn(),
    zoomOut: () => workspace.zoomOut(),
    zoomReset: () => workspace.zoomReset(),
    fullScreen: () => toggleFullScreen(),
    navBack: () => workspace.navBack(),
    navForward: () => workspace.navForward()
  }

  /** 事件 → 命令：先精确匹配；Shift 常是敲 = / + 这类符号的副产品，没中就去掉 Shift 再试 */
  function appCommandFor(event: KeyboardEvent): string | null {
    const map = appKeyMap()
    const key = keyFromEvent(event)
    if (key !== null) {
      const direct = map.get(key)
      if (direct !== undefined) return direct
    }
    if (event.shiftKey) {
      const relaxed = keyFromEvent({ ...event, shiftKey: false })
      if (relaxed !== null) return map.get(relaxed) ?? null
    }
    return null
  }

  window.addEventListener('keydown', (event) => {
    if (dialogOpen()) return
    // CodeMirror 已经处理过的键不再重复触发（默认行为被拦过）
    if (event.defaultPrevented) return
    const id = appCommandFor(event)
    if (id === null) return
    const run = appCommands[id]
    if (!run) return
    event.preventDefault()
    event.stopPropagation()
    run()
  })

  // 源代码模式抢在 CodeMirror 之前处理，否则 Ctrl+/ 会被它的注释命令吃掉；
  // 绑定仍从键位表读，改绑立即生效
  window.addEventListener(
    'keydown',
    (event) => {
      if (dialogOpen()) return
      const bound = effectiveKey('sourceMode')
      if (bound === null || keyFromEvent(event) !== bound) return
      event.preventDefault()
      event.stopPropagation()
      workspace.toggleSourceMode()
    },
    true
  )

  window.addEventListener('keydown', (event) => {
    if (event.key === 'F12') {
      event.preventDefault()
      void window.mdforge.openDevTools()
    }
  })

  window.mdforge.onDropFiles((paths) => workspace.dropFiles(paths))
  window.mdforge.onExternalChange((change) => void workspace.handleExternalChange(change))
  // 第二个实例（双击 .md）把新路径交给现有窗口打开
  window.mdforge.onStartupOpen(() => void workspace.openStartupPaths())
  // 更新事件：发现新版 / 下载完成 / 下载失败 → 应用内对话框
  window.mdforge.onUpdateEvent((event) => void handleUpdateEvent(event, menuCtx))

  // 关闭确认走应用内对话框：主进程先拦住 close，这里回答放不放行
  window.mdforge.onWindowClose(() => void workspace.confirmWindowClose())

  await workspace.init()
}

void boot()
