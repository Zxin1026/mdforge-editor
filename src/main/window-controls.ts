import { app, clipboard, ClipboardItem, ipcMain, type BrowserWindow } from 'electron'
import { CHANNEL, normalizeZoom } from '../shared/ipc'

/**
 * 菜单里这几项只能由主进程执行：全屏、置顶、开发者工具、缩放，以及剪切板读写
 * （点菜单后焦点在菜单按钮上，浏览器原生的剪贴板命令不会作用到编辑器选区）。
 */
export function registerWindowHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(CHANNEL.clipboardRead, () => clipboard.readText())
  // Electron 44 的 clipboard 换成了 W3C 风格的 MIME 接口（readText/read 都是异步、没有 readHTML）
  ipcMain.handle(CHANNEL.clipboardReadHtml, async () => {
    try {
      for (const item of await clipboard.read()) {
        const type = item.types.find((candidate) => candidate.toLowerCase() === 'text/html')
        if (!type) continue
        const value: unknown = await item.getType(type)
        if (typeof value === 'string') return value
        if (value instanceof Blob) return await value.text()
      }
    } catch {
      return ''
    }
    return ''
  })

  ipcMain.handle(CHANNEL.clipboardWrite, (_event, text: unknown) => {
    if (typeof text !== 'string' || text === '') return false
    clipboard.writeText(text)
    return true
  })

  // 富文本复制：HTML 与纯文本一次原子写入，粘到 Word / 微信里表格与强调都还在
  ipcMain.handle(CHANNEL.clipboardWriteHtml, async (_event, html: unknown, text: unknown) => {
    if (typeof html !== 'string' || html === '') return false
    const plain = typeof text === 'string' ? text : ''
    try {
      const items: Record<string, string> = { 'text/html': html }
      if (plain !== '') items['text/plain'] = plain
      await clipboard.write([new ClipboardItem(items)])
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle(CHANNEL.clipboardWriteImage, async (_event, raw: unknown) => {
    if (!(raw instanceof Uint8Array) || raw.length === 0) return false
    try {
      const blob = new Blob([Buffer.from(raw)], { type: 'image/png' })
      await clipboard.write([new ClipboardItem({ 'image/png': blob })])
      return true
    } catch {
      return false
    }
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
