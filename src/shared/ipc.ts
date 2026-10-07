export type MdEncoding = 'utf-8' | 'utf-8-bom' | 'gbk' | 'gb18030' | 'big5' | 'unknown'

/** 可供用户点选的编码（'unknown' 只是检测失败的占位） */
export type ChoosableEncoding = Exclude<MdEncoding, 'unknown'>

export type Eol = 'crlf' | 'lf'

/** 界面主题：浅色 / 深色 / 跟随系统（跟随系统由渲染进程读 prefers-color-scheme） */
export type AppTheme = 'light' | 'dark' | 'system'

const APP_THEMES: AppTheme[] = ['light', 'dark', 'system']

/** 旧版本把 mdmdt 皮肤单列成两个主题；现在它已是深浅色的默认外观，读到旧值按深浅迁移 */
const LEGACY_THEMES: Record<string, AppTheme> = { 'mdmdt-light': 'light', 'mdmdt-dark': 'dark' }

export function normalizeTheme(raw: unknown): AppTheme | undefined {
  if (APP_THEMES.includes(raw as AppTheme)) return raw as AppTheme
  return typeof raw === 'string' ? LEGACY_THEMES[raw] : undefined
}

/** 界面缩放：只接受 0.5–3 之间的数，写进会话后重启也能续上 */
export function normalizeZoom(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
  const clamped = Math.min(3, Math.max(0.5, raw))
  return Math.round(clamped * 100) / 100
}

/** 编辑器字号（px）：只认预设档位，菜单是唯一写入方 */
export const FONT_SIZES = [13, 14, 15, 16] as const

export type EditorFontSize = (typeof FONT_SIZES)[number]

export const DEFAULT_FONT_SIZE: EditorFontSize = 14

export function normalizeFontSize(raw: unknown): EditorFontSize | undefined {
  return FONT_SIZES.includes(raw as EditorFontSize) ? (raw as EditorFontSize) : undefined
}

/** 编辑区宽度：窄 / 中 / 宽三档居中栏宽，铺满即不加限制（默认） */
export type ContentWidth = 'narrow' | 'medium' | 'wide' | 'full'

export const CONTENT_WIDTHS: ContentWidth[] = ['narrow', 'medium', 'wide', 'full']

export const DEFAULT_CONTENT_WIDTH: ContentWidth = 'full'

/** null 表示不设 max-width，编辑器铺满窗口 */
export const CONTENT_WIDTH_PX: Record<ContentWidth, number | null> = {
  narrow: 760,
  medium: 900,
  wide: 1100,
  full: null
}

export function normalizeContentWidth(raw: unknown): ContentWidth | undefined {
  return CONTENT_WIDTHS.includes(raw as ContentWidth) ? (raw as ContentWidth) : undefined
}

export interface FileMeta {
  encoding: MdEncoding
  eol: Eol
  /** 文件内同时存在 CRLF 与 LF，写回时统一为 eol 指定的换行符 */
  eolMixed: boolean
  bom: boolean
}

export interface FileSnapshot {
  path: string
  /** 编辑器使用的文本：已解码、已去 BOM、换行统一为 LF */
  text: string
  meta: FileMeta
  /** 原始字节的 sha1，用于外部修改检测与字节保真写回 */
  hash: string
  size: number
  mtimeMs: number
}

export interface WriteRequest {
  path: string
  text: string
  meta: FileMeta
  baseHash: string
  force?: boolean
}

/** 崩溃草稿：与文档一一对应，键在重启后要能对上，所以由文件路径推导 */
export interface DocDraft {
  key: string
  path: string | null
  name: string
  text: string
  meta: FileMeta
  updatedAt: number
}

/** 外部修改监测事件 */
export interface ExternalChange {
  path: string
  kind: 'modified' | 'deleted'
  /** 磁盘当前字节哈希；删除时为 null */
  hash: string | null
  mtimeMs: number
}

export type FileErrorCode =
  | 'not-granted'
  | 'not-found'
  | 'permission'
  | 'encoding-unsupported'
  | 'encoding-lossy'
  | 'conflict'
  | 'invalid-path'
  | 'unknown'

export interface FileErrorInfo {
  code: FileErrorCode
  message: string
  path?: string
  hint?: string
}

export type FileResult<T> = { ok: true; value: T } | { ok: false; error: FileErrorInfo }

/** 图片资源处理：复制到导出文件旁、base64 内联，或原样保留相对路径 */
export type AssetExportMode = 'copy' | 'inline' | 'keep'

/** 导出 HTML 的排版主题；dark 与应用深色界面同一套配色，mdmdt 移植自同名 Typora 主题 */
export type ExportTheme = 'default' | 'serif' | 'plain' | 'dark' | 'mdmdt'

export type PaperSize = 'A4' | 'Letter' | 'Legal' | 'A5'

export type PageMargin = 'narrow' | 'standard' | 'wide'

export interface ExportOptions {
  assets: AssetExportMode
  theme: ExportTheme
  toc: boolean
  paper: PaperSize
  margin: PageMargin
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  assets: 'copy',
  theme: 'default',
  toc: false,
  paper: 'A4',
  margin: 'standard'
}

/** 页边距（毫米）：@page 用毫米，printToPDF 用英寸，两边共用这一张表 */
export const MARGIN_MM: Record<PageMargin, number> = { narrow: 12, standard: 20, wide: 30 }

export const PAPER_SIZES: PaperSize[] = ['A4', 'Letter', 'Legal', 'A5']

const ASSET_MODES: AssetExportMode[] = ['copy', 'inline', 'keep']
const EXPORT_THEMES: ExportTheme[] = ['default', 'serif', 'plain', 'dark', 'mdmdt']
const PAGE_MARGINS: PageMargin[] = ['narrow', 'standard', 'wide']

function pick<T extends string>(list: T[], value: unknown, fallback: T): T {
  return list.includes(value as T) ? (value as T) : fallback
}

/** 选项来自会话文件或渲染进程，逐字段回落默认值 */
export function normalizeExportOptions(raw: unknown): ExportOptions {
  const input = (raw ?? {}) as Partial<ExportOptions>
  return {
    assets: pick(ASSET_MODES, input.assets, DEFAULT_EXPORT_OPTIONS.assets),
    theme: pick(EXPORT_THEMES, input.theme, DEFAULT_EXPORT_OPTIONS.theme),
    toc: input.toc === true,
    paper: pick(PAPER_SIZES, input.paper, DEFAULT_EXPORT_OPTIONS.paper),
    margin: pick(PAGE_MARGINS, input.margin, DEFAULT_EXPORT_OPTIONS.margin)
  }
}

export interface ExportInput {
  html: string
  docPath: string | null
  baseName: string
  options: ExportOptions
}

/** 导出时对文内图片的处理结果，回给状态栏说明情况 */
export interface AssetReport {
  copied: number
  inlined: number
  /** 引用了但磁盘上不存在的地址 */
  missing: string[]
  /** 原样写出的地址：远程、过大、未保存文档的相对引用等 */
  skipped: string[]
}

export interface ExportOutcome {
  path: string
  assets: AssetReport
}

/** 导出纯文本 / Markdown 源文件副本：编码沿用文档自身设置 */
export interface TextExportInput {
  text: string
  docPath: string | null
  baseName: string
  meta: FileMeta
  extension: 'md' | 'txt'
}

/** 文档检查：渲染进程不碰磁盘，引用是否存在由主进程按授权模型判定 */
export type ResourceState = 'ok' | 'missing' | 'directory' | 'outside' | 'unknown'

export interface ResourceProbeInput {
  docPath: string
  /** 渲染进程解析出的绝对路径，顺序即返回顺序 */
  refs: string[]
}

export interface AssetInfo {
  /** 相对文档目录的 posix 路径，可直接与 Markdown 里的引用比对 */
  relative: string
  absolute: string
  size: number
}

export interface ResourceProbeResult {
  states: ResourceState[]
  /** 文档 assets/ 目录下的实际文件，用于找未引用资源 */
  assets: AssetInfo[]
}

export interface AssetWriteInput {
  /** 当前编辑文档的绝对路径：图片只写到它同级的 assets/ 目录 */
  docPath: string
  /** 剪贴板 File 给出的建议文件名，可能含路径或非法字符，主进程负责清洗 */
  name: string
  bytes: Uint8Array
}

export interface AssetWriteResult {
  absolute: string
  /** 相对文档目录的 POSIX 风格路径，可直接写进 Markdown 链接，如 assets/screenshot-2.png */
  relative: string
  name: string
}

/** 重启后恢复的会话：打开的标签顺序、当前标签、最近打开列表 */
export interface SessionData {
  openDocs: string[]
  active: string | null
  recents: string[]
  /** 自动保存开关，缺省视为开启 */
  autoSave?: boolean
  /** 上次用的导出选项，缺省回落到 DEFAULT_EXPORT_OPTIONS */
  export?: ExportOptions
  /** 界面主题，缺省视为跟随系统 */
  theme?: AppTheme
  /** 界面缩放倍率，缺省视为 1 */
  zoom?: number
  /** 编辑器字号（px），缺省视为 14 */
  fontSize?: EditorFontSize
  /** 编辑区宽度，缺省视为铺满 */
  contentWidth?: ContentWidth
}

export const ENCODING_CHOICES: ChoosableEncoding[] = ['utf-8', 'utf-8-bom', 'gbk', 'gb18030', 'big5']

export const AUTOSAVE_DELAY_MS = 3000

export interface FileApi {
  open(): Promise<FileResult<FileSnapshot | null>>
  openMany(): Promise<FileResult<string[]>>
  saveAs(text: string, meta: FileMeta): Promise<FileResult<FileSnapshot>>
  read(path: string): Promise<FileResult<FileSnapshot>>
  /** 按用户指定的编码重新解码磁盘上的原始字节：检测结果错判时的纠正入口 */
  readAs(path: string, encoding: MdEncoding): Promise<FileResult<FileSnapshot>>
  write(request: WriteRequest): Promise<FileResult<FileSnapshot>>
  /** 粘贴图片落盘：写入 <docPath 所在目录>/assets/，返回可直接插入的相对链接 */
  saveAsset(input: AssetWriteInput): Promise<FileResult<AssetWriteResult>>
  startupPaths(): Promise<string[]>
  exportHtml(input: ExportInput): Promise<FileResult<ExportOutcome>>
  exportPdf(input: ExportInput): Promise<FileResult<ExportOutcome>>
  exportText(input: TextExportInput): Promise<FileResult<string>>
  /** 文档检查用：批量判断引用路径是否存在，并列出 assets/ 下的实际文件 */
  probeResources(input: ResourceProbeInput): Promise<FileResult<ResourceProbeResult>>
  reveal(path: string): Promise<boolean>
  openExternal(url: string): Promise<boolean>
  sessionRead(): Promise<SessionData | null>
  sessionWrite(data: SessionData): Promise<void>
  watch(target: string): Promise<boolean>
  unwatch(target: string): Promise<boolean>
  draftWrite(draft: DocDraft): Promise<boolean>
  draftList(): Promise<DocDraft[]>
  draftClear(keys: string[]): Promise<boolean>
  /** 主进程请求关闭窗口：渲染进程弹自定义确认框后回答是否放行 */
  onWindowClose(cb: () => void): void
  answerWindowClose(allow: boolean): void
  /** 菜单里的剪切/复制/粘贴走主进程剪贴板，菜单按钮拿到焦点后浏览器原生命令不可用 */
  clipboardReadText(): Promise<string>
  clipboardWriteText(text: string): Promise<boolean>
  /** 视图菜单：全屏 / 置顶 / 开发者工具 / 缩放，都作用于主窗口 */
  toggleFullScreen(): Promise<boolean>
  setAlwaysOnTop(on: boolean): Promise<boolean>
  openDevTools(): Promise<boolean>
  setZoom(factor: number): Promise<number>
  /** 菜单"退出"：走和标题栏关闭按钮相同的关窗确认 */
  closeWindow(): Promise<boolean>
  /** 应用信息：帮助菜单的"关于"用 */
  appVersion(): Promise<string>
  /** 注册拖放回调：preload 从操作系统拖放事件里提取绝对路径后调用 */
  onDropFiles(cb: (paths: string[]) => void): void
  /** 主进程收到第二个实例的启动参数（双击 .md 复用已开窗口），渲染进程重新拉取 startupPaths */
  onStartupOpen(cb: () => void): void
  onExternalChange(cb: (change: ExternalChange) => void): void
}

export const CHANNEL = {
  open: 'mdforge:fs:open',
  openMany: 'mdforge:fs:open-many',
  saveAs: 'mdforge:fs:save-as',
  read: 'mdforge:fs:read',
  readAs: 'mdforge:fs:read-as',
  write: 'mdforge:fs:write',
  saveAsset: 'mdforge:fs:save-asset',
  startupPaths: 'mdforge:fs:startup-paths',
  grantDropped: 'mdforge:fs:grant-dropped',
  watch: 'mdforge:fs:watch',
  unwatch: 'mdforge:fs:unwatch',
  externalChange: 'mdforge:fs:external-change',
  draftWrite: 'mdforge:draft:write',
  draftList: 'mdforge:draft:list',
  draftClear: 'mdforge:draft:clear',
  exportHtml: 'mdforge:export:html',
  exportPdf: 'mdforge:export:pdf',
  exportText: 'mdforge:export:text',
  probeResources: 'mdforge:fs:probe',
  reveal: 'mdforge:reveal',
  openExternal: 'mdforge:open-external',
  sessionRead: 'mdforge:session:read',
  sessionWrite: 'mdforge:session:write',
  windowClose: 'mdforge:window:close',
  windowCloseAnswer: 'mdforge:window:close-answer',
  clipboardRead: 'mdforge:clipboard:read',
  clipboardWrite: 'mdforge:clipboard:write',
  toggleFullScreen: 'mdforge:window:full-screen',
  setAlwaysOnTop: 'mdforge:window:always-on-top',
  openDevTools: 'mdforge:window:dev-tools',
  setZoom: 'mdforge:window:zoom',
  closeWindow: 'mdforge:window:close-request',
  appVersion: 'mdforge:app:version',
  startupOpen: 'mdforge:startup:open'
} as const
