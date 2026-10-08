/**
 * 自动更新：electron-updater 从 GitHub Releases 读取 latest.yml 判断新版本。
 * 交互弹窗都在渲染进程（应用内对话框），主进程只负责检查、下载、推送事件。
 * 升级包由 NSIS 安装器静默替换：重启安装用 quitAndInstall，退出时安装由
 * autoInstallOnAppQuit 在正常退出流程末尾完成。
 */

import { app, ipcMain, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { CHANNEL, type UpdateCheckOutcome, type UpdateEvent } from '../shared/ipc'

const FIRST_CHECK_DELAY_MS = 10_000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

let getWindow: (() => BrowserWindow | null) | null = null
/** 弹过下载询问的版本：用户选"稍后"之后，自动检查不再重复打扰 */
const prompted = new Set<string>()
let downloading = false
/** 正在下载的版本号，仅用于状态文案 */
let pendingVersion: string | null = null
/** 下载完成、等待重启安装的版本 */
let readyVersion: string | null = null

/** 自动更新只在安装版可用：开发模式没有 app-update.yml，便携版无法替换自身 */
function enabled(): boolean {
  return app.isPackaged && process.env['PORTABLE_EXECUTABLE_FILE'] === undefined
}

function emit(event: UpdateEvent): void {
  const win = getWindow?.()
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(CHANNEL.updateEvent, event)
}

async function check(manual: boolean): Promise<UpdateCheckOutcome> {
  const current = app.getVersion()
  try {
    const result = await autoUpdater.checkForUpdates()
    const next = result?.updateInfo.version
    if (next === undefined) return { status: 'latest', version: current }
    pendingVersion = next
    if (manual || !prompted.has(next)) {
      prompted.add(next)
      emit({ kind: 'available', version: next })
    }
    return { status: 'available', version: next }
  } catch {
    // 网络不通（GitHub 访问受限等）静默失败：自动检查不打扰，下次启动再试
    return { status: 'error', version: current }
  }
}

/** 启动后挂载：首查延迟 10 秒，之后每 4 小时一次；开发模式与便携版直接跳过 */
export function initUpdater(window: () => BrowserWindow | null): void {
  getWindow = window
  if (!enabled()) return
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', (info) => {
    downloading = false
    readyVersion = info.version
    emit({ kind: 'downloaded', version: info.version })
  })
  // 交互式下载的失败由 downloadUpdate() 的 Promise 汇报，事件本身只需吞掉
  autoUpdater.on('error', () => {})
  const run = (): void => void check(false)
  setTimeout(run, FIRST_CHECK_DELAY_MS)
  setInterval(run, CHECK_INTERVAL_MS)
}

/** 帮助菜单的"检查更新"：结果回给渲染进程弹反馈框 */
export async function manualCheck(): Promise<UpdateCheckOutcome> {
  const current = app.getVersion()
  if (!enabled()) return { status: 'unavailable', version: current }
  if (readyVersion !== null) {
    // 已有下载好的版本：再提醒一次重启
    emit({ kind: 'downloaded', version: readyVersion })
    return { status: 'downloaded', version: readyVersion }
  }
  if (downloading) return { status: 'downloading', version: pendingVersion ?? current }
  return check(true)
}

/** 开始后台下载；已在下载或已就绪时返回 false */
export function downloadUpdate(): boolean {
  if (!enabled() || downloading || readyVersion !== null) return false
  downloading = true
  void autoUpdater.downloadUpdate().catch(() => {
    downloading = false
    emit({ kind: 'failed', version: app.getVersion() })
  })
  return true
}

/** 静默安装并重启到新版本；调用前渲染进程已确认没有未保存内容 */
export function installUpdate(): void {
  if (!enabled() || readyVersion === null) return
  autoUpdater.quitAndInstall(true, true)
}

export function registerUpdateHandlers(): void {
  ipcMain.handle(CHANNEL.checkUpdates, () => manualCheck())
  ipcMain.handle(CHANNEL.downloadUpdate, () => downloadUpdate())
  ipcMain.on(CHANNEL.installUpdate, () => installUpdate())
}
