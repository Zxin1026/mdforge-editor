export type MdEncoding = 'utf-8' | 'utf-8-bom' | 'gbk' | 'gb18030' | 'big5' | 'unknown'

/** 可供用户点选的编码（'unknown' 只是检测失败的占位） */
export type ChoosableEncoding = Exclude<MdEncoding, 'unknown'>

export type Eol = 'crlf' | 'lf'

/** 界面主题：浅色 / 深色 / 护眼 / 高对比度 / 跟随系统（跟随系统由渲染进程读 prefers-color-scheme） */
export type AppTheme = 'light' | 'dark' | 'sepia' | 'high-contrast' | 'system'

const APP_THEMES: AppTheme[] = ['light', 'dark', 'sepia', 'high-contrast', 'system']

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

/** 视图模式：编辑 / 左源码右渲染分屏 / 纯阅读（只读） */
export type ViewMode = 'edit' | 'split' | 'read'

export const VIEW_MODES: ViewMode[] = ['edit', 'split', 'read']

export function normalizeViewMode(raw: unknown): ViewMode | undefined {
  return VIEW_MODES.includes(raw as ViewMode) ? (raw as ViewMode) : undefined
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

/** 内置导出主题；dark 与应用深色界面同一套配色，mdmdt 移植自同名 Typora 主题 */
export const BUILTIN_EXPORT_THEMES = ['default', 'serif', 'plain', 'dark', 'mdmdt'] as const

export type BuiltinExportTheme = (typeof BUILTIN_EXPORT_THEMES)[number]

/** 自定义主题与页面模板的引用前缀：custom:<id> 指向 userData 里的条目 */
export const CUSTOM_REF = 'custom:'

export type ExportTheme = BuiltinExportTheme | `custom:${string}`

/** 代码高亮主题：auto 沿用排版主题自带的配色，其余来自内置的 highlight.js 主题集 */
export const HIGHLIGHT_THEMES = [
  'github',
  'atom-one-light',
  'solarized-light',
  'github-dark',
  'atom-one-dark',
  'monokai',
  'dracula',
  'nord',
  'solarized-dark',
  'vs2015'
] as const

export type HighlightTheme = 'auto' | (typeof HIGHLIGHT_THEMES)[number]

/** 页面模板：内置标准页，或 custom:<id> 指向自定义模板 */
export type PageTemplate = 'builtin' | `custom:${string}`

export type PaperSize = 'A4' | 'Letter' | 'Legal' | 'A5'

export type PageMargin = 'narrow' | 'standard' | 'wide'

export interface ExportOptions {
  assets: AssetExportMode
  theme: ExportTheme
  highlight: HighlightTheme
  template: PageTemplate
  toc: boolean
  paper: PaperSize
  margin: PageMargin
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  assets: 'copy',
  theme: 'default',
  highlight: 'auto',
  template: 'builtin',
  toc: false,
  paper: 'A4',
  margin: 'standard'
}

/** 页边距（毫米）：@page 用毫米，printToPDF 用英寸，两边共用这一张表 */
export const MARGIN_MM: Record<PageMargin, number> = { narrow: 12, standard: 20, wide: 30 }

export const PAPER_SIZES: PaperSize[] = ['A4', 'Letter', 'Legal', 'A5']

const ASSET_MODES: AssetExportMode[] = ['copy', 'inline', 'keep']
const PAGE_MARGINS: PageMargin[] = ['narrow', 'standard', 'wide']
const HIGHLIGHT_CHOICES: HighlightTheme[] = ['auto', ...HIGHLIGHT_THEMES]

/** custom:<id> 的 id 会进会话、文件名与 DOM dataset，只收小写字母数字与连字符 */
const CUSTOM_ID = /^custom:[a-z0-9][a-z0-9-]{0,39}$/

export function customRefOf(id: string): `custom:${string}` {
  return `${CUSTOM_REF}${id}`
}

/** 引用里取出自定义 id；内置引用（default、builtin 等）返回 null */
export function customIdOf(ref: string): string | null {
  return ref.startsWith(CUSTOM_REF) && CUSTOM_ID.test(ref) ? ref.slice(CUSTOM_REF.length) : null
}

function pick<T extends string>(list: readonly T[], value: unknown, fallback: T): T {
  return (list as readonly string[]).includes(value as string) ? (value as T) : fallback
}

function pickTheme(value: unknown): ExportTheme {
  const builtin = pick(BUILTIN_EXPORT_THEMES, value, DEFAULT_EXPORT_OPTIONS.theme)
  if (builtin === value) return builtin
  if (typeof value === 'string' && CUSTOM_ID.test(value)) return value as ExportTheme
  return DEFAULT_EXPORT_OPTIONS.theme
}

function pickTemplate(value: unknown): PageTemplate {
  if (typeof value === 'string' && CUSTOM_ID.test(value)) return value as PageTemplate
  return DEFAULT_EXPORT_OPTIONS.template
}

/** 选项来自会话文件或渲染进程，逐字段回落默认值 */
export function normalizeExportOptions(raw: unknown): ExportOptions {
  const input = (raw ?? {}) as Partial<ExportOptions>
  return {
    assets: pick(ASSET_MODES, input.assets, DEFAULT_EXPORT_OPTIONS.assets),
    theme: pickTheme(input.theme),
    highlight: pick(HIGHLIGHT_CHOICES, input.highlight, DEFAULT_EXPORT_OPTIONS.highlight),
    template: pickTemplate(input.template),
    toc: input.toc === true,
    paper: pick(PAPER_SIZES, input.paper, DEFAULT_EXPORT_OPTIONS.paper),
    margin: pick(PAGE_MARGINS, input.margin, DEFAULT_EXPORT_OPTIONS.margin)
  }
}

/** 自定义样式资产：主题的 CSS 与页面模板的 HTML，都存在 userData 下的 json 文件里 */
export type CustomStyleKind = 'theme' | 'template'

export interface CustomTheme {
  id: string
  name: string
  css: string
}

export interface CustomTemplate {
  id: string
  name: string
  html: string
}

export interface CustomStyleLibrary {
  themes: CustomTheme[]
  templates: CustomTemplate[]
}

/** 保存主题/模板：id 为 null 时新建 */
export interface CustomStyleInput {
  kind: CustomStyleKind
  id: string | null
  name: string
  /** theme 存 CSS，template 存 HTML */
  content: string
}

export interface CustomStyleSaved {
  id: string
  library: CustomStyleLibrary
}

export interface CustomStyleImport {
  id: string
  name: string
  kind: CustomStyleKind
  library: CustomStyleLibrary
}

/** 名称与内容的体量上限：导入的外部文件同样受这两条约束 */
export const STYLE_NAME_MAX = 40
export const STYLE_CONTENT_MAX = 512 * 1024

/** 页面模板必填的占位符：正文要有个落点，主进程导入时也按它校验 */
export const TEMPLATE_CONTENT_PLACEHOLDER = '{{content}}'

/** 模板占位符校验：主进程导入与渲染进程保存共用同一条规则 */
export function templatePlaceholderProblem(html: string): string | null {
  return html.includes(TEMPLATE_CONTENT_PLACEHOLDER)
    ? null
    : `模板里要有 ${TEMPLATE_CONTENT_PLACEHOLDER} 占位符，否则正文没地方放`
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

/** 批量导出/静态站点：一个页面 */
export interface BatchFileInput {
  /** 输出目录内的相对路径（posix，含 .html），结构照搬源文件夹 */
  relative: string
  html: string
  /** 图片解析基准文档；未保存的页面传 null */
  docPath: string | null
}

export interface BatchExportInput {
  outDir: string
  files: BatchFileInput[]
  /** index.html、search-index.json 这类附加文件，原样写出 */
  extras: Array<{ relative: string; content: string }>
  options: ExportOptions
}

export interface BatchExportResult {
  outDir: string
  written: number
  /** 写失败的页面：相对路径 + 原因 */
  failed: Array<{ relative: string; detail: string }>
  assets: AssetReport
}

/** EPUB：每篇文档一章，图片统一内联进章节文件 */
export interface EpubChapterInput {
  title: string
  html: string
  docPath: string | null
}

export interface EpubExportInput {
  title: string
  author?: string
  chapters: EpubChapterInput[]
  /** 书籍样式表内容 */
  css: string
}

export interface EpubExportResult {
  path: string
  chapters: number
  /** 内联进书里的图片张数 */
  images: number
}

/** 文档检查：渲染进程不碰磁盘，引用是否存在由主进程按授权模型判定 */
export type ResourceState = 'ok' | 'missing' | 'directory' | 'outside' | 'unknown'

/** 跨文档锚点：'unknown' 表示文件读不出来，无法判定（不算问题） */
export type AnchorState = 'ok' | 'missing' | 'unknown'

export interface ResourceAnchorInput {
  /** 目标文档绝对路径 */
  path: string
  /** 不带 # 的锚点 id */
  anchor: string
}

export interface ResourceProbeInput {
  docPath: string
  /** 渲染进程解析出的绝对路径，顺序即返回顺序 */
  refs: string[]
  /** 跨文档锚点：与 refs 同批探测目标文档里的标题是否存在 */
  anchors?: ResourceAnchorInput[]
}

export interface AssetInfo {
  /** 相对文档目录的 posix 路径，可直接与 Markdown 里的引用比对 */
  relative: string
  absolute: string
  size: number
}

export interface ResourceProbeResult {
  states: ResourceState[]
  /** 文档同级与 assets/ 目录下的实际资源文件，用于找未引用资源 */
  assets: AssetInfo[]
  /** 与 anchors 一一对应 */
  anchorStates: AnchorState[]
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

/** 图片资源管理器：扫描根下的一张图片，尺寸与引用由主进程一次算好 */
export interface ManagedAsset {
  path: string
  /** 相对扫描根的 POSIX 路径，可直接与 Markdown 引用比对 */
  relative: string
  name: string
  size: number
  width: number | null
  height: number | null
  /** 引用它的文档：相对根的 POSIX 路径 + 行号（1 起），同一处只留一条 */
  refs: Array<{ doc: string; line: number }>
}

export interface AssetListResult {
  root: string
  assets: ManagedAsset[]
  /** 扫描过的 Markdown 文档数 */
  docs: number
  /** 图片过多，列表被截断 */
  truncated: boolean
}

export interface AssetRenameInput {
  root: string
  /** from 为图片绝对路径，to 为同目录下的新文件名 */
  renames: Array<{ from: string; to: string }>
  /** 有未保存修改的文档：磁盘上的引用不动，交给渲染进程改内存缓冲 */
  skip: string[]
}

export interface AssetRenameFile {
  from: string
  /** 成功时是新路径，失败时保持原路径 */
  path: string
  kind: 'ok' | 'error'
  /** error 时的原因 */
  detail?: string
}

export interface AssetRenameResult {
  files: AssetRenameFile[]
  /** 磁盘上被改写过引用的文档路径 */
  touched: string[]
  refs: number
}

export interface AssetReplaceInput {
  root: string
  path: string
  bytes: Uint8Array
  /** 压缩转格式时的新文件名；缺省原地覆盖 */
  newName?: string
  skip: string[]
}

export interface AssetReplaceResult {
  path: string
  size: number
  touched: string[]
  refs: number
}

/** 文件树的一条：已授权文件夹里的文件或子目录 */
export interface FolderEntry {
  name: string
  path: string
  kind: 'file' | 'dir'
  /** 首行预览（跳过 front matter、剥掉行首标记），列表里当副标题；目录为空串 */
  preview: string
}

/** 工作区搜索的一处命中：行号与列号都是 1 起，列号相对 trim 后的行文本 */
export interface WorkspaceMatch {
  line: number
  col: number
  /** 命中片段长度，列表里高亮用 */
  length: number
  /** 命中行的文本（去掉行首空白，过长会截断） */
  text: string
}

export interface WorkspaceFileHit {
  path: string
  name: string
  /** 搜索时磁盘内容的 sha1：批量替换用它挡住搜索之后的外部改动 */
  hash: string
  matches: WorkspaceMatch[]
  /** 命中太多被截断 */
  truncated: boolean
  /** 文件名本身也命中查询 */
  nameMatch: boolean
}

export interface WorkspaceSearchInput {
  dir: string
  query: string
  caseSensitive: boolean
  regex: boolean
}

export interface WorkspaceSearchResult {
  files: WorkspaceFileHit[]
  /** 已收录的命中处数（截断时小于实际值） */
  totalMatches: number
  /** 扫描过的可打开文件数 */
  scanned: number
  truncated: boolean
}

export interface WorkspaceReplaceInput {
  dir: string
  query: string
  caseSensitive: boolean
  regex: boolean
  replacement: string
  /** 搜索结果的子集；hash 是搜索时的磁盘哈希，对不上就跳过（防覆盖外部改动） */
  targets: Array<{ path: string; hash: string }>
}

export interface WorkspaceReplaceFile {
  path: string
  name: string
  replaced: number
  kind: 'ok' | 'skipped' | 'error'
  /** skipped / error 的原因 */
  detail?: string
}

export interface WorkspaceReplaceResult {
  files: WorkspaceReplaceFile[]
  replacedFiles: number
  replacedMatches: number
}

/** 链接索引：文件夹里每个文档的出链（只收指向文件夹内部文档的链接） */
export interface DocRef {
  path: string
  name: string
}

export interface DocLink {
  from: string
  to: string
  line: number
  /** 链接所在行的文本，反向链接列表里显示 */
  text: string
}

export interface LinkIndexResult {
  files: DocRef[]
  links: DocLink[]
}

/** 重启后恢复的会话：打开的标签顺序、当前标签、最近打开列表 */
export interface SessionData {
  openDocs: string[]
  active: string | null
  recents: string[]
  /** 上次打开的文件夹（文件列表面板），缺省视为没有 */
  folder?: string | null
  /** 文件树里收藏的文件/文件夹路径，缺省视为空 */
  favorites?: string[]
  /** 侧边栏是否显示，缺省视为显示 */
  sidebar?: boolean
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
  /** 视图模式，缺省视为编辑 */
  viewMode?: ViewMode
  /** 打字机模式，缺省视为关闭 */
  typewriter?: boolean
  /** 专注模式，缺省视为关闭 */
  focusMode?: boolean
}

export const ENCODING_CHOICES: ChoosableEncoding[] = ['utf-8', 'utf-8-bom', 'gbk', 'gb18030', 'big5']

export const AUTOSAVE_DELAY_MS = 3000

/** 手动检查更新的结果：version 是当前版本或发现的新版本号 */
export type UpdateCheckStatus = 'latest' | 'available' | 'downloading' | 'downloaded' | 'unavailable' | 'error'

export interface UpdateCheckOutcome {
  status: UpdateCheckStatus
  version: string
}

/** 主进程推送的更新事件：下载询问、重启提醒、下载失败提示都由它驱动 */
export interface UpdateEvent {
  kind: 'available' | 'downloaded' | 'failed'
  /** available / downloaded 为新版本号，failed 为当前版本号 */
  version: string
}

export interface FileApi {
  open(): Promise<FileResult<FileSnapshot | null>>
  openMany(): Promise<FileResult<string[]>>
  /** 打开文件夹：系统目录框选完后登记为可读根，返回选中的目录（取消为 null） */
  openFolder(): Promise<FileResult<string | null>>
  /** 列出已授权文件夹里的可打开文件与子目录（直接子级，文件带首行预览） */
  listFolder(dir: string): Promise<FileResult<FolderEntry[]>>
  /** 在已授权文件夹里新建子目录，返回新目录绝对路径 */
  createFolder(dir: string, name: string): Promise<FileResult<string>>
  /** 在已授权文件夹里新建 Markdown 文件（名称没有扩展名时自动补 .md），返回新文件绝对路径 */
  createFile(dir: string, name: string): Promise<FileResult<string>>
  /** 重命名文件或文件夹（不改位置），返回新路径 */
  renamePath(target: string, name: string): Promise<FileResult<string>>
  /** 把文件或文件夹移动到另一个目录下，返回新路径 */
  movePath(target: string, destDir: string): Promise<FileResult<string>>
  /** 删除文件或文件夹：移入系统回收站（可恢复），返回被删除的路径 */
  trashPath(target: string): Promise<FileResult<string>>
  /** 工作区全文搜索：文件名 + 内容，支持正则 */
  searchWorkspace(input: WorkspaceSearchInput): Promise<FileResult<WorkspaceSearchResult>>
  /** 批量替换：按搜索给的哈希逐个核对后写回，保留各自编码 */
  replaceWorkspace(input: WorkspaceReplaceInput): Promise<FileResult<WorkspaceReplaceResult>>
  /** 扫描文件夹内文档之间的链接（反向链接与关系图的数据来源） */
  scanLinks(dir: string): Promise<FileResult<LinkIndexResult>>
  saveAs(text: string, meta: FileMeta): Promise<FileResult<FileSnapshot>>
  read(path: string): Promise<FileResult<FileSnapshot>>
  /** 按用户指定的编码重新解码磁盘上的原始字节：检测结果错判时的纠正入口 */
  readAs(path: string, encoding: MdEncoding): Promise<FileResult<FileSnapshot>>
  write(request: WriteRequest): Promise<FileResult<FileSnapshot>>
  /** 粘贴图片落盘：写入 <docPath 所在目录>/assets/，返回可直接插入的相对链接 */
  saveAsset(input: AssetWriteInput): Promise<FileResult<AssetWriteResult>>
  /** 图片资源管理器：扫描根下的图片、尺寸与引用关系 */
  listAssets(root: string): Promise<FileResult<AssetListResult>>
  /** 批量重命名图片并改写文档里的引用 */
  renameAssets(input: AssetRenameInput): Promise<FileResult<AssetRenameResult>>
  /** 覆盖图片字节（压缩/转格式），可改名并改写引用 */
  replaceAsset(input: AssetReplaceInput): Promise<FileResult<AssetReplaceResult>>
  /** 压缩用：读取图片原始字节（canvas 走同源 blob，跨源协议图会污染画布） */
  readAsset(path: string): Promise<FileResult<Uint8Array>>
  startupPaths(): Promise<string[]>
  exportHtml(input: ExportInput): Promise<FileResult<ExportOutcome>>
  exportPdf(input: ExportInput): Promise<FileResult<ExportOutcome>>
  exportText(input: TextExportInput): Promise<FileResult<string>>
  /** 批量导出/静态站点：选一个输出目录（取消为 null） */
  chooseExportFolder(): Promise<FileResult<string | null>>
  /** 整个文件夹批量导出：按相对结构写页面与附加文件，图片按选项处理 */
  exportBatch(input: BatchExportInput): Promise<FileResult<BatchExportResult>>
  /** 导出 EPUB：多个章节打包成一本电子书 */
  exportEpub(input: EpubExportInput): Promise<FileResult<EpubExportResult>>
  /** 自定义导出主题与页面模板：列出 userData 里的全部条目 */
  styleList(): Promise<CustomStyleLibrary>
  /** 新建或覆盖保存一条主题/模板 */
  styleSave(input: CustomStyleInput): Promise<FileResult<CustomStyleSaved>>
  styleDelete(kind: CustomStyleKind, id: string): Promise<FileResult<CustomStyleLibrary>>
  /** 从 .json（{name, css|html}）或 .css/.html 文件导入；取消为 null */
  styleImport(kind: CustomStyleKind): Promise<FileResult<CustomStyleImport | null>>
  /** 导出为原始 .css/.html 文件，返回写出路径；取消为 null */
  styleExport(kind: CustomStyleKind, id: string): Promise<FileResult<string | null>>
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
  /** 菜单粘贴优先用的 HTML 形式：和编辑器里的 Ctrl+V 一样对齐 Typora 的富文本粘贴 */
  clipboardReadHtml(): Promise<string>
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
  /** 自动更新：手动检查 / 开始下载 / 重启安装；弹窗由 onUpdateEvent 推送驱动 */
  checkUpdates(): Promise<UpdateCheckOutcome>
  downloadUpdate(): Promise<boolean>
  installUpdate(): void
  onUpdateEvent(cb: (event: UpdateEvent) => void): void
  /** 注册拖放回调：preload 从操作系统拖放事件里提取绝对路径后调用 */
  onDropFiles(cb: (paths: string[]) => void): void
  /** 主进程收到第二个实例的启动参数（双击 .md 复用已开窗口），渲染进程重新拉取 startupPaths */
  onStartupOpen(cb: () => void): void
  onExternalChange(cb: (change: ExternalChange) => void): void
}

export const CHANNEL = {
  open: 'mdforge:fs:open',
  openMany: 'mdforge:fs:open-many',
  openFolder: 'mdforge:fs:open-folder',
  listFolder: 'mdforge:fs:list-folder',
  createFolder: 'mdforge:fs:create-folder',
  createFile: 'mdforge:fs:create-file',
  renamePath: 'mdforge:fs:rename',
  movePath: 'mdforge:fs:move',
  trashPath: 'mdforge:fs:trash',
  searchWorkspace: 'mdforge:fs:search',
  replaceWorkspace: 'mdforge:fs:replace',
  scanLinks: 'mdforge:fs:scan-links',
  saveAs: 'mdforge:fs:save-as',
  read: 'mdforge:fs:read',
  readAs: 'mdforge:fs:read-as',
  write: 'mdforge:fs:write',
  saveAsset: 'mdforge:fs:save-asset',
  listAssets: 'mdforge:asset:list',
  renameAssets: 'mdforge:asset:rename',
  replaceAsset: 'mdforge:asset:replace',
  readAsset: 'mdforge:asset:read',
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
  chooseExportFolder: 'mdforge:export:choose-folder',
  exportBatch: 'mdforge:export:batch',
  exportEpub: 'mdforge:export:epub',
  styleList: 'mdforge:style:list',
  styleSave: 'mdforge:style:save',
  styleDelete: 'mdforge:style:delete',
  styleImport: 'mdforge:style:import',
  styleExport: 'mdforge:style:export',
  probeResources: 'mdforge:fs:probe',
  reveal: 'mdforge:reveal',
  openExternal: 'mdforge:open-external',
  sessionRead: 'mdforge:session:read',
  sessionWrite: 'mdforge:session:write',
  windowClose: 'mdforge:window:close',
  windowCloseAnswer: 'mdforge:window:close-answer',
  clipboardRead: 'mdforge:clipboard:read',
  clipboardReadHtml: 'mdforge:clipboard:read-html',
  clipboardWrite: 'mdforge:clipboard:write',
  toggleFullScreen: 'mdforge:window:full-screen',
  setAlwaysOnTop: 'mdforge:window:always-on-top',
  openDevTools: 'mdforge:window:dev-tools',
  setZoom: 'mdforge:window:zoom',
  closeWindow: 'mdforge:window:close-request',
  appVersion: 'mdforge:app:version',
  checkUpdates: 'mdforge:update:check',
  downloadUpdate: 'mdforge:update:download',
  installUpdate: 'mdforge:update:install',
  updateEvent: 'mdforge:update:event',
  startupOpen: 'mdforge:startup:open'
} as const
