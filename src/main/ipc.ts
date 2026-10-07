import { dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import path from 'node:path'
import {
  CHANNEL,
  ENCODING_CHOICES,
  normalizeExportOptions,
  type AssetWriteInput,
  type DocDraft,
  type ExportInput,
  type FileErrorInfo,
  type FileMeta,
  type FileResult,
  type FileSnapshot,
  type ResourceProbeInput,
  type SessionData,
  type TextExportInput,
  type WriteRequest
} from '../shared/ipc'
import { exportHtml, exportPdf, exportText } from './export'
import { answerWindowClose } from './close-guard'
import { FileOpError } from './fs/error'
import { startupPaths } from './fs/startup'
import { saveAsset } from './fs/asset-store'
import { probeResources } from './fs/resource-check'
import { draftClear, draftList, draftWrite } from './fs/draft-store'
import { readSession, writeSession } from './fs/session'
import { onExternalChange, unwatchFile, watchFile } from './fs/watch'
import { grantPath, isGranted, isUnderGrantedRoot, readFile, readFileWithEncoding, writeFile } from './fs/file-store'

const MARKDOWN_FILTERS = [
  { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] },
  { name: '所有文件', extensions: ['*'] }
]

const MD_EXT = new Set(['.md', '.markdown', '.mdown', '.mkd', '.txt'])

/** 单份崩溃草稿的上限，够容纳整本手册还多，超出就只靠自动保存兜底 */
const MAX_DRAFT_CHARS = 4_000_000

let lastDir: string | null = null

function errorInfo(error: unknown): FileErrorInfo {
  if (error instanceof FileOpError) {
    return { code: error.code, message: error.message, path: error.path, hint: error.hint }
  }
  return {
    code: 'unknown',
    message: error instanceof Error ? error.message : String(error)
  }
}

async function guarded<T>(action: () => Promise<T>): Promise<FileResult<T>> {
  try {
    return { ok: true, value: await action() }
  } catch (error) {
    return { ok: false, error: errorInfo(error) }
  }
}

function noteDir(target: string): void {
  lastDir = path.dirname(target)
}

/** 渲染进程传来的参数一律当外部输入校验，通过后才允许碰磁盘 */
function parseAssetInput(raw: unknown): AssetWriteInput {
  if (raw === null || typeof raw !== 'object') {
    throw new FileOpError('invalid-path', '图片保存参数不合法')
  }
  const input = raw as Partial<AssetWriteInput>
  if (typeof input.docPath !== 'string' || typeof input.name !== 'string') {
    throw new FileOpError('invalid-path', '图片保存参数不完整')
  }
  if (!(input.bytes instanceof Uint8Array)) {
    throw new FileOpError('invalid-path', '图片数据格式不正确')
  }
  return { docPath: input.docPath, name: input.name, bytes: Buffer.from(input.bytes) }
}

/** 写回参数由渲染进程给出，先验形状再落盘 */
function parseMeta(raw: unknown): FileMeta | null {
  const meta = raw as Partial<FileMeta> | null | undefined
  if (!meta || typeof meta !== 'object') return null
  if (typeof meta.encoding !== 'string' || typeof meta.eol !== 'string') return null
  if (typeof meta.bom !== 'boolean' || typeof meta.eolMixed !== 'boolean') return null
  return meta as FileMeta
}

/** 导出正文与文件名来自渲染进程，选项逐字段回落默认值 */
function parseExportInput(raw: unknown): ExportInput {
  if (raw === null || typeof raw !== 'object') throw new FileOpError('invalid-path', '导出参数不合法')
  const input = raw as Partial<ExportInput>
  if (typeof input.html !== 'string' || typeof input.baseName !== 'string') {
    throw new FileOpError('invalid-path', '导出参数不完整')
  }
  if (input.docPath !== null && input.docPath !== undefined && typeof input.docPath !== 'string') {
    throw new FileOpError('invalid-path', '文档路径不合法')
  }
  return {
    html: input.html,
    docPath: typeof input.docPath === 'string' ? input.docPath : null,
    baseName: input.baseName,
    options: normalizeExportOptions(input.options)
  }
}

function parseTextExport(raw: unknown): TextExportInput {
  if (raw === null || typeof raw !== 'object') throw new FileOpError('invalid-path', '导出参数不合法')
  const input = raw as Partial<TextExportInput>
  if (typeof input.text !== 'string' || typeof input.baseName !== 'string') {
    throw new FileOpError('invalid-path', '导出参数不完整')
  }
  if (input.extension !== 'md' && input.extension !== 'txt') {
    throw new FileOpError('invalid-path', '不支持的导出格式')
  }
  const meta = parseMeta(input.meta)
  if (meta === null) throw new FileOpError('invalid-path', '导出编码参数不合法')
  return {
    text: input.text,
    docPath: typeof input.docPath === 'string' ? input.docPath : null,
    baseName: input.baseName,
    meta,
    extension: input.extension
  }
}

function parseProbeInput(raw: unknown): ResourceProbeInput {
  if (raw === null || typeof raw !== 'object') throw new FileOpError('invalid-path', '检查参数不合法')
  const input = raw as Partial<ResourceProbeInput>
  if (typeof input.docPath !== 'string') throw new FileOpError('invalid-path', '检查参数不完整')
  const refs = Array.isArray(input.refs) ? input.refs.filter((ref): ref is string => typeof ref === 'string') : []
  return { docPath: input.docPath, refs }
}

/** 草稿文本由渲染进程给出，落盘前限制体量并校验形状 */
function parseDraft(raw: unknown): DocDraft | null {
  if (raw === null || typeof raw !== 'object') return null
  const draft = raw as Partial<DocDraft>
  if (typeof draft.key !== 'string' || draft.key.length === 0) return null
  if (typeof draft.text !== 'string' || draft.text.length > MAX_DRAFT_CHARS) return null
  if (typeof draft.name !== 'string') return null
  if (draft.path !== null && typeof draft.path !== 'string') return null
  const meta = parseMeta(draft.meta)
  if (meta === null) return null
  return {
    key: draft.key,
    path: typeof draft.path === 'string' ? draft.path : null,
    name: draft.name,
    text: draft.text,
    meta,
    updatedAt: Number(draft.updatedAt) || Date.now()
  }
}

export function registerFileHandlers(getWindow: () => BrowserWindow | null): void {
  onExternalChange((change) => getWindow()?.webContents.send(CHANNEL.externalChange, change))

  ipcMain.handle(CHANNEL.open, () =>
    guarded(async () => {
      const choice = await dialog.showOpenDialog({
        title: '打开 Markdown 文件',
        properties: ['openFile', 'multiSelections'],
        filters: MARKDOWN_FILTERS,
        defaultPath: lastDir ?? undefined
      })
      if (choice.canceled || choice.filePaths.length === 0) return null

      const target = choice.filePaths[0]
      noteDir(target)
      grantPath(target)
      return readFile(target)
    })
  )

  ipcMain.handle(CHANNEL.openMany, () =>
    guarded(async () => {
      const choice = await dialog.showOpenDialog({
        title: '打开 Markdown 文件',
        properties: ['openFile', 'multiSelections'],
        filters: MARKDOWN_FILTERS,
        defaultPath: lastDir ?? undefined
      })
      if (choice.canceled) return []
      for (const file of choice.filePaths) grantPath(file)
      if (choice.filePaths.length > 0) noteDir(choice.filePaths[choice.filePaths.length - 1])
      return choice.filePaths
    })
  )

  ipcMain.handle(CHANNEL.grantDropped, (_event, files: unknown) => {
    if (!Array.isArray(files)) return false
    for (const file of files) if (typeof file === 'string' && file) grantPath(file)
    return true
  })

  ipcMain.handle(CHANNEL.read, (_event, target: string) =>
    guarded(async () => {
      // 文内相对链接指向的 md：与已打开文档同目录（或在已授权文件夹内）时自动放行
      if (
        target &&
        !isGranted(target) &&
        MD_EXT.has(path.extname(target).toLowerCase()) &&
        isUnderGrantedRoot(target)
      ) {
        grantPath(target)
      }
      noteDir(target)
      return readFile(target)
    })
  )

  ipcMain.handle(CHANNEL.readAs, (_event, target: string, raw: unknown) =>
    guarded(async () => {
      // 编码来自菜单点击，仍然按白名单校验后才允许碰磁盘
      const choice = ENCODING_CHOICES.find((item) => item === raw)
      if (!choice) throw new FileOpError('encoding-unsupported', '未知的编码选项')
      noteDir(target)
      return readFileWithEncoding(target, choice)
    })
  )

  ipcMain.handle(CHANNEL.saveAs, (_event, text: string, meta: FileMeta) =>
    guarded(async () => {
      const parent = getWindow()
      const options = {
        title: '另存为',
        filters: MARKDOWN_FILTERS,
        defaultPath: path.join(lastDir ?? process.cwd(), '未命名.md')
      }
      const choice = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
      if (choice.canceled || !choice.filePath) {
        throw new FileOpError('invalid-path', '未选择保存位置')
      }

      noteDir(choice.filePath)
      grantPath(choice.filePath)
      const request: WriteRequest = {
        path: choice.filePath,
        text,
        meta,
        baseHash: '',
        force: true
      }
      return writeFile(request)
    })
  )

  ipcMain.handle(CHANNEL.write, (_event, request: WriteRequest) =>
    guarded(async () => {
      const snapshot: FileSnapshot = await writeFile(request)
      noteDir(snapshot.path)
      return snapshot
    })
  )

  ipcMain.handle(CHANNEL.saveAsset, (_event, raw: unknown) => guarded(() => saveAsset(parseAssetInput(raw))))

  ipcMain.handle(CHANNEL.startupPaths, () => startupPaths())

  ipcMain.handle(CHANNEL.watch, (_event, target: unknown) => {
    if (typeof target !== 'string' || !target) return false
    // 只对用户已经打开过的文件加监听，渲染进程不能指定任意路径
    const absolute = path.resolve(target)
    if (!isGranted(absolute)) return false
    watchFile(absolute)
    return true
  })

  ipcMain.handle(CHANNEL.unwatch, (_event, target: unknown) => {
    if (typeof target !== 'string' || !target) return false
    unwatchFile(path.resolve(target))
    return true
  })

  ipcMain.handle(CHANNEL.draftWrite, async (_event, raw: unknown) => {
    const draft = parseDraft(raw)
    if (!draft) return false
    try {
      await draftWrite(draft)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle(CHANNEL.draftList, () => draftList().catch(() => []))

  ipcMain.handle(CHANNEL.draftClear, async (_event, keys: unknown) => {
    if (!Array.isArray(keys)) return false
    try {
      // 必须等真的删完再回话：用户点"放弃修改并关闭"后进程马上就要退出
      await draftClear(keys.filter((key): key is string => typeof key === 'string'))
      return true
    } catch {
      return false
    }
  })

  ipcMain.on(CHANNEL.windowCloseAnswer, (_event, allow: unknown) => answerWindowClose(allow === true))

  ipcMain.handle(CHANNEL.exportHtml, (_event, raw: unknown) =>
    guarded(() => exportHtml(parseExportInput(raw), getWindow()))
  )
  ipcMain.handle(CHANNEL.exportPdf, (_event, raw: unknown) =>
    guarded(() => exportPdf(parseExportInput(raw), getWindow()))
  )
  ipcMain.handle(CHANNEL.exportText, (_event, raw: unknown) =>
    guarded(() => exportText(parseTextExport(raw), getWindow()))
  )
  ipcMain.handle(CHANNEL.probeResources, (_event, raw: unknown) => guarded(() => probeResources(parseProbeInput(raw))))

  ipcMain.handle(CHANNEL.reveal, (_event, target: string) => {
    if (!target || !isUnderGrantedRoot(target)) return false
    shell.showItemInFolder(target)
    return true
  })

  ipcMain.handle(CHANNEL.openExternal, (_event, url: string) => {
    // 只放行常见安全协议，避免 file:、javascript: 之类被注入
    if (typeof url !== 'string' || !/^(https?:|mailto:|tel:)/i.test(url)) return false
    void shell.openExternal(url)
    return true
  })

  ipcMain.handle(CHANNEL.sessionRead, async () => {
    try {
      const session = await readSession()
      if (!session) return null
      // 会话里的文件是用户此前真实打开过的，恢复时重新授权（仅限 Markdown 家族）
      for (const p of session.openDocs) {
        if (p && MD_EXT.has(path.extname(p).toLowerCase())) grantPath(p)
      }
      return session
    } catch {
      return null
    }
  })

  ipcMain.handle(CHANNEL.sessionWrite, async (_event, data: SessionData) => {
    try {
      await writeSession(data)
    } catch {
      /* 会话写盘失败不应打断编辑 */
    }
  })
}
