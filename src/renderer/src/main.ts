import './assets/main.css'
// KaTeX 的样式与字体在入口统一引入：模块内的 css 副作用导入只有 web 配置认得
import 'katex/dist/katex.min.css'
import type { AppTheme } from '../../shared/ipc'
import { appMenus, contextMenuEntries, type AppMenuContext } from './app-menu'
import { openContextMenu } from './context-menu'
import { dialogOpen } from './dialog'
import type { MenuHandle } from './menu'
import { createMenuBar } from './menubar'
import { createTheme } from './theme'
import { Workspace } from './workspace'

const root = document.querySelector<HTMLDivElement>('#root')

root!.innerHTML = `
  <div class="app">
    <div id="menubar" class="mdf-menubar"></div>
    <div id="tabbar" class="tabbar"></div>
    <div class="body">
      <aside id="outline" class="outline"></aside>
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
    sidebar: () => workspace.sidebarVisible(),
    toggleSidebar: () => workspace.toggleSidebar(),
    inspect: () => workspace.openInspect(),
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
    appVersion: () => window.mdforge.appVersion()
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

  window.addEventListener('keydown', (event) => {
    const ctrl = event.ctrlKey || event.metaKey
    if (!ctrl) return
    // 确认框打开时把按键留给框本身
    if (dialogOpen()) return
    const key = event.key.toLowerCase()
    if (key === 's' && event.shiftKey) {
      event.preventDefault()
      void workspace.saveAs()
    } else if (key === 's') {
      event.preventDefault()
      void workspace.save()
    } else if (key === 'o') {
      event.preventDefault()
      void workspace.openViaDialog()
    } else if (key === 'n') {
      event.preventDefault()
      workspace.openNew()
    } else if (key === 'w') {
      event.preventDefault()
      void workspace.closeActive()
    } else if (key === 'f' && event.shiftKey) {
      // Ctrl+Shift+F：在工作区里搜索（Ctrl+F 留给当前文档的查找面板）
      event.preventDefault()
      workspace.openWorkspaceSearch()
    } else if (key === 'h' && !event.shiftKey) {
      event.preventDefault()
      workspace.runActive('replace')
    }
  })

  // 导航历史：Alt+← / Alt+→，与浏览器的习惯一致
  window.addEventListener('keydown', (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (dialogOpen()) return
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      workspace.navBack()
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      workspace.navForward()
    }
  })

  // 缩放：用 code 而不是 key，Ctrl+Shift+= 这类带 Shift 的写法在任何键盘布局下都指同一个物理键
  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || dialogOpen()) return
    if (event.code === 'Equal' || event.code === 'NumpadAdd') {
      event.preventDefault()
      workspace.zoomIn()
    } else if (event.code === 'Minus' || event.code === 'NumpadSubtract') {
      event.preventDefault()
      workspace.zoomOut()
    } else if ((event.code === 'Digit0' && event.shiftKey) || event.code === 'Numpad0') {
      event.preventDefault()
      workspace.zoomReset()
    }
  })

  // 源代码模式抢在 CodeMirror 之前处理，否则 Ctrl+/ 会被它的注释命令吃掉
  window.addEventListener(
    'keydown',
    (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return
      if (event.code !== 'Slash' && event.code !== 'NumpadDivide') return
      if (dialogOpen()) return
      event.preventDefault()
      event.stopPropagation()
      workspace.toggleSourceMode()
    },
    true
  )

  window.addEventListener('keydown', (event) => {
    if (event.key === 'F11') {
      event.preventDefault()
      toggleFullScreen()
    } else if (event.key === 'F12') {
      event.preventDefault()
      void window.mdforge.openDevTools()
    }
  })

  window.mdforge.onDropFiles((paths) => workspace.dropFiles(paths))
  window.mdforge.onExternalChange((change) => void workspace.handleExternalChange(change))
  // 第二个实例（双击 .md）把新路径交给现有窗口打开
  window.mdforge.onStartupOpen(() => void workspace.openStartupPaths())

  // 关闭确认走应用内对话框：主进程先拦住 close，这里回答放不放行
  window.mdforge.onWindowClose(() => void workspace.confirmWindowClose())

  await workspace.init()
}

void boot()
