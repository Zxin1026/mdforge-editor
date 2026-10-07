import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { CHANNEL, type ExternalChange, type FileApi, type SessionData } from '../shared/ipc'

const dropHandlers: Array<(paths: string[]) => void> = []
const changeHandlers: Array<(change: ExternalChange) => void> = []
const closeHandlers: Array<() => void> = []
const startupHandlers: Array<() => void> = []

function pathForFile(file: File): string {
  try {
    return webUtils.getPathForFile(file)
  } catch {
    return ''
  }
}

// 拖放要在 preload 处理：沙箱渲染进程拿不到 File.path，webUtils 只在 preload 可用
window.addEventListener('dragover', (event) => {
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
})

window.addEventListener('drop', (event) => {
  event.preventDefault()
  const files = Array.from(event.dataTransfer?.files ?? [])
  const paths = files.map(pathForFile).filter((p) => p.length > 0)
  if (paths.length === 0) return
  void ipcRenderer.invoke(CHANNEL.grantDropped, paths).then(() => {
    for (const handler of dropHandlers) handler(paths)
  })
})

const api: FileApi = {
  open: () => ipcRenderer.invoke(CHANNEL.open),
  openMany: () => ipcRenderer.invoke(CHANNEL.openMany),
  openFolder: () => ipcRenderer.invoke(CHANNEL.openFolder),
  listFolder: (dir) => ipcRenderer.invoke(CHANNEL.listFolder, dir),
  createFolder: (dir, name) => ipcRenderer.invoke(CHANNEL.createFolder, dir, name),
  renamePath: (target, name) => ipcRenderer.invoke(CHANNEL.renamePath, target, name),
  movePath: (target, destDir) => ipcRenderer.invoke(CHANNEL.movePath, target, destDir),
  searchWorkspace: (input) => ipcRenderer.invoke(CHANNEL.searchWorkspace, input),
  replaceWorkspace: (input) => ipcRenderer.invoke(CHANNEL.replaceWorkspace, input),
  scanLinks: (dir) => ipcRenderer.invoke(CHANNEL.scanLinks, dir),
  saveAs: (text, meta) => ipcRenderer.invoke(CHANNEL.saveAs, text, meta),
  read: (target) => ipcRenderer.invoke(CHANNEL.read, target),
  readAs: (target, encoding) => ipcRenderer.invoke(CHANNEL.readAs, target, encoding),
  write: (request) => ipcRenderer.invoke(CHANNEL.write, request),
  saveAsset: (input) => ipcRenderer.invoke(CHANNEL.saveAsset, input),
  startupPaths: () => ipcRenderer.invoke(CHANNEL.startupPaths),
  exportHtml: (input) => ipcRenderer.invoke(CHANNEL.exportHtml, input),
  exportPdf: (input) => ipcRenderer.invoke(CHANNEL.exportPdf, input),
  exportText: (input) => ipcRenderer.invoke(CHANNEL.exportText, input),
  probeResources: (input) => ipcRenderer.invoke(CHANNEL.probeResources, input),
  reveal: (target) => ipcRenderer.invoke(CHANNEL.reveal, target),
  openExternal: (url) => ipcRenderer.invoke(CHANNEL.openExternal, url),
  watch: (target) => ipcRenderer.invoke(CHANNEL.watch, target),
  unwatch: (target) => ipcRenderer.invoke(CHANNEL.unwatch, target),
  draftWrite: (draft) => ipcRenderer.invoke(CHANNEL.draftWrite, draft),
  draftList: () => ipcRenderer.invoke(CHANNEL.draftList),
  draftClear: (keys) => ipcRenderer.invoke(CHANNEL.draftClear, keys),
  sessionRead: () => ipcRenderer.invoke(CHANNEL.sessionRead) as Promise<SessionData | null>,
  sessionWrite: (data) => ipcRenderer.invoke(CHANNEL.sessionWrite, data),
  answerWindowClose: (allow) => void ipcRenderer.send(CHANNEL.windowCloseAnswer, allow),
  clipboardReadText: () => ipcRenderer.invoke(CHANNEL.clipboardRead),
  clipboardReadHtml: () => ipcRenderer.invoke(CHANNEL.clipboardReadHtml),
  clipboardWriteText: (text) => ipcRenderer.invoke(CHANNEL.clipboardWrite, text),
  toggleFullScreen: () => ipcRenderer.invoke(CHANNEL.toggleFullScreen),
  setAlwaysOnTop: (on) => ipcRenderer.invoke(CHANNEL.setAlwaysOnTop, on),
  openDevTools: () => ipcRenderer.invoke(CHANNEL.openDevTools),
  setZoom: (factor) => ipcRenderer.invoke(CHANNEL.setZoom, factor),
  closeWindow: () => ipcRenderer.invoke(CHANNEL.closeWindow),
  appVersion: () => ipcRenderer.invoke(CHANNEL.appVersion),
  onDropFiles: (cb) => {
    dropHandlers.push(cb)
  },
  onStartupOpen: (cb) => {
    startupHandlers.push(cb)
  },
  onExternalChange: (cb) => {
    changeHandlers.push(cb)
  },
  onWindowClose: (cb) => {
    closeHandlers.push(cb)
  }
}

ipcRenderer.on(CHANNEL.externalChange, (_event, change: ExternalChange) => {
  for (const handler of changeHandlers) handler(change)
})

// 第二个实例带来的新启动参数：主进程已收进 startupPaths，渲染进程重新拉取即可
ipcRenderer.on(CHANNEL.startupOpen, () => {
  for (const handler of startupHandlers) handler()
})

// 关闭确认由渲染进程发起：主进程先拦住 close，等我们回答
ipcRenderer.on(CHANNEL.windowClose, () => {
  if (closeHandlers.length === 0) return api.answerWindowClose(true)
  for (const handler of closeHandlers) handler()
})

contextBridge.exposeInMainWorld('mdforge', api)
