import { app, clipboard, ipcMain, type BrowserWindow } from 'electron'
import { CHANNEL, normalizeZoom } from '../shared/ipc'

/**
 * 菜单里这几项只能由主进程执行：全屏、置顶、开发者工具、缩放，以及剪切板读写
 * （点菜单后焦点在菜单按钮上，浏览器原生的剪贴板命令不会作用到编辑器选区）。
 */
export function registerWindowHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(CHANNEL.clipboardRead, () => clipboard.readText())

  ipcMain.handle(CHANNEL.clipboardWrite, (_event, text: unknown) => {
    if (typeof text !== 'string' || text === '') return false
    clipboard.writeText(text)
    return true
  })

  ipcMain.handle(CHANNEL.toggleFullScreen, () => {
    const win = getWindow()
    if (!win) return false
    const next = !win.isFullScreen()
    win.setFullScreen(next)
    return next
  })

  ipcMain.handle(CHANNEL.setAlwaysOnTop, (_event, on: unknown) => {
    const win = getWindow()
    if (!win) return false
    win.setAlwaysOnTop(on === true)
    return win.isAlwaysOnTop()
  })

  ipcMain.handle(CHANNEL.openDevTools, () => {
    const win = getWindow()
    if (!win) return false
    if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools()
    else win.webContents.openDevTools({ mode: 'bottom' })
    return true
  })

  // 整窗缩放：走 Chromium 的缩放倍率，CodeMirror 的坐标换算不用我们操心
  ipcMain.handle(CHANNEL.setZoom, (_event, raw: unknown) => {
    const win = getWindow()
    const factor = normalizeZoom(raw)
    if (!win || factor === undefined) return 1
    win.webContents.setZoomFactor(factor)
    return factor
  })

  ipcMain.handle(CHANNEL.closeWindow, () => {
    const win = getWindow()
    if (!win) return false
    // 与点标题栏的关闭按钮同一条路径：close-guard 会先问渲染进程
    win.close()
    return true
  })

  ipcMain.handle(CHANNEL.appVersion, () => app.getVersion())
}
