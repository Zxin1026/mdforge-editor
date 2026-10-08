import { app, BrowserWindow, Menu, screen, shell } from 'electron'
import path from 'node:path'
import { CHANNEL } from '../shared/ipc'
import { handleAssetRequests, registerAssetScheme } from './asset-protocol'
import { attachCloseGuard } from './close-guard'
import { registerFileHandlers } from './ipc'
import { registerWindowHandlers } from './window-controls'
import { initUpdater, registerUpdateHandlers } from './updater'
import { initDraftStore } from './fs/draft-store'
import { collectFromArgv } from './fs/startup'
import { initStyleStore } from './fs/style-store'
import { stopAllWatchers } from './fs/watch'
import { fitToDisplays, readWindowState, saveWindowState, type WindowState } from './window-state'

collectFromArgv(process.argv)
registerAssetScheme()
initDraftStore(path.join(app.getPath('userData'), 'drafts'))
initStyleStore(path.join(app.getPath('userData'), 'export-styles'))

const RENDERER_ENTRY = path.join(__dirname, '../renderer/index.html')
const STATE_DIR = app.getPath('userData')

let mainWindow: BrowserWindow | null = null

/** 上一次落盘的窗口状态，避免拖动过程中反复写同一份内容 */
let lastWindowState: WindowState | undefined
let windowStateTimer: ReturnType<typeof setTimeout> | undefined

function snapshotWindow(win: BrowserWindow): WindowState {
  const bounds = win.getNormalBounds()
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, maximized: win.isMaximized() }
}

function rememberWindow(win: BrowserWindow): void {
  const state = snapshotWindow(win)
  if (lastWindowState && JSON.stringify(state) === JSON.stringify(lastWindowState)) return
  lastWindowState = state
  saveWindowState(STATE_DIR, state)
}

function trackWindowState(win: BrowserWindow): void {
  const schedule = (): void => {
    if (windowStateTimer !== undefined) clearTimeout(windowStateTimer)
    windowStateTimer = setTimeout(() => {
      windowStateTimer = undefined
      rememberWindow(win)
    }, 400)
  }
  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('maximize', schedule)
  win.on('unmaximize', schedule)
  win.on('close', () => {
    if (windowStateTimer !== undefined) clearTimeout(windowStateTimer)
    windowStateTimer = undefined
    rememberWindow(win)
  })
}

function createWindow(saved: WindowState | undefined): void {
  const restored = saved
    ? fitToDisplays(
        saved,
        screen.getAllDisplays().map((display) => display.workArea)
      )
    : undefined
  const win = new BrowserWindow({
    width: saved?.width ?? 1200,
    height: saved?.height ?? 800,
    ...(restored ? { x: restored.x, y: restored.y } : {}),
    minWidth: 640,
    minHeight: 400,
    show: false,
    title: 'MDForge',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow = win
  attachCloseGuard(win)
  trackWindowState(win)
  // 关闭可能被确认框拦下，只能在真正销毁后丢引用
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  win.on('ready-to-show', () => {
    if (saved?.maximized === true) win.maximize()
    win.show()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(RENDERER_ENTRY)
  }
}

// 单实例只在打包版启用：开发与端到端验证需要多个实例并存，
// "双击 .md 复用窗口"的体验只发生在安装版的文件关联场景
const singleInstance = app.isPackaged ? app.requestSingleInstanceLock() : true
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    collectFromArgv(argv)
    const win = mainWindow
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
    win.webContents.send(CHANNEL.startupOpen)
  })

  app.whenReady().then(async () => {
    // 应用自带菜单栏（渲染进程），去掉 Electron 默认原生菜单，否则按 Alt 会冒出第二套菜单
    Menu.setApplicationMenu(null)
    handleAssetRequests()
    registerFileHandlers(() => mainWindow)
    registerWindowHandlers(() => mainWindow)
    registerUpdateHandlers()
    createWindow(await readWindowState(STATE_DIR))
    initUpdater(() => mainWindow)
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(undefined)
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => stopAllWatchers())
}
