import type { BrowserWindow } from 'electron'
import { CHANNEL } from '../shared/ipc'

/**
 * 关窗前交给渲染进程弹自定义确认框，而不是用 beforeunload / 系统对话框。
 * 主进程这里只负责"拦住关闭 + 等回答"。
 */

const REASK_MS = 20_000

let target: BrowserWindow | null = null
let allowNextClose = false
let asking = false
let timer: ReturnType<typeof setTimeout> | undefined

function sendAsk(win: BrowserWindow): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) {
    // 窗口都没了，不必再问
    asking = false
    allowNextClose = true
    return
  }
  win.webContents.send(CHANNEL.windowClose)
  // 没回答就再问一次。宁可一直等着，也不能超时强行关窗丢掉未保存的改动；
  // 渲染进程还开着确认框时会忽略重复的询问
  timer = setTimeout(() => {
    if (asking && target) sendAsk(target)
  }, REASK_MS)
}

export function attachCloseGuard(win: BrowserWindow): void {
  target = win
  asking = false
  allowNextClose = false

  win.on('close', (event) => {
    if (allowNextClose) {
      allowNextClose = false
      return
    }
    // 还没加载完 = 用户没来得及改任何东西，不必拦
    if (win.isDestroyed() || win.webContents.isDestroyed() || win.webContents.isLoading()) return
    event.preventDefault()
    asking = true
    sendAsk(win)
  })

  win.on('closed', () => {
    if (target === win) target = null
    if (timer) clearTimeout(timer)
    timer = undefined
    asking = false
  })

  // 渲染进程崩溃时不能继续等它的回答
  win.webContents.on('render-process-gone', () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    asking = false
    allowNextClose = true
  })
}

export function answerWindowClose(allow: boolean): void {
  const win = target
  if (timer) clearTimeout(timer)
  timer = undefined
  if (!asking || !win || win.isDestroyed()) return
  asking = false
  if (!allow) return
  allowNextClose = true
  win.close()
}
