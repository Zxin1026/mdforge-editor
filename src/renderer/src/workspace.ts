import {
  AUTOSAVE_DELAY_MS,
  CONTENT_WIDTH_PX,
  DEFAULT_CONTENT_WIDTH,
  DEFAULT_EXPORT_OPTIONS,
  DEFAULT_FONT_SIZE,
  ENCODING_CHOICES,
  PAPER_SIZES,
  normalizeContentWidth,
  normalizeFontSize,
  normalizeZoom,
  type AppTheme,
  type AssetReport,
  type ChoosableEncoding,
  type ContentWidth,
  type DocDraft,
  type EditorFontSize,
  type Eol,
  type ExportOptions,
  type ExternalChange,
  type FileErrorInfo,
  type FileSnapshot
} from '../../shared/ipc'
import type { EditorAction, EditorFacts } from './editor/actions'
import type { LinkTarget } from './editor/links'
import { askDialog } from './dialog'
import { collectOutline } from './editor/outline'
import { clearMermaidCache } from './editor/mermaid'
import { createEditor, type MarkdownEditor } from './editor/view'
import {
  ASSET_MODES,
  ASSET_MODE_LABELS,
  ASSET_MODE_NOTES,
  MARGINS,
  MARGIN_LABELS,
  PAPER_LABELS,
  THEMES,
  THEME_LABELS
} from './export/options'
import { buildHtml, deriveTitle, renderText } from './export/html'
import type { MenuEntry, MenuHandle } from './menu'
import { openMenu } from './menu'
import { createSidePanel, type SidePanel } from './side-panel'
import { inspectDocument, type Issue } from './editor/inspect'
import { createTabBar, type TabBar, type TabItem } from './tabs'
import {
  afterSave,
  displayNameOf,
  draftKeyOf,
  emptyDoc,
  encodingLabel,
  fromSnapshot,
  isDirty,
  isUnsavedNew,
  withMeta,
  withText,
  writeRequest,
  type DocState
} from './doc'

export interface WorkspaceDeps {
  editorHost: HTMLElement
  tabbar: HTMLElement
  outline: HTMLElement
  nameEl: HTMLElement
  metaEl: HTMLElement
  autoSaveEl: HTMLElement
  statusNote: HTMLElement
  statusMetrics: HTMLElement
  /** 会话里要一起落盘的主题：真身在入口的主题控制器，工作区只借来写盘 */
  themeMode: () => AppTheme
}

interface DocTab {
  id: string
  /** 崩溃草稿的键：已保存过的文档由路径推导，重启后能对上同一份草稿 */
  key: string
  state: DocState
  host: HTMLElement
  editor: MarkdownEditor
  active: boolean
  /** 自动保存失败后停用手柄，避免每隔几秒反复撞同一面墙 */
  suspended: boolean
}

const MAX_RECENTS = 12
/** 草稿落盘窗口：比会话持久化稍长，打字途中不必频繁写 userData */
const DRAFT_DELAY_MS = 1200
/** 缩放档位：跟着视图菜单的放大/缩小逐级走，和浏览器的比例习惯一致 */
const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

type ConflictChoice = 'reload' | 'overwrite' | 'later'
type CloseChoice = 'save' | 'discard' | 'cancel'
type ExternalChoice = 'reload' | 'keep' | 'later'
type ExportKind = 'html' | 'pdf' | 'md' | 'txt'

export class Workspace {
  private tabs: DocTab[] = []
  private activeId: string | null = null
  private newSeq = 0
  private recents: string[] = []
  private lastError: FileErrorInfo | null = null
  private lastMessage = ''
  private revealTarget: string | null = null
  private persistTimer: number | undefined
  private draftTimer: number | undefined
  private autoSaveTimer: number | undefined
  private autoSave = true
  private metaMenu: MenuHandle | null = null
  private zoomLevel = 1
  private fontSizeLevel: EditorFontSize = DEFAULT_FONT_SIZE
  private contentWidthMode: ContentWidth = DEFAULT_CONTENT_WIDTH
  private exportOptions: ExportOptions = { ...DEFAULT_EXPORT_OPTIONS }
  /** 已经弹出外部修改确认框的标签，避免同一份改动叠两层框 */
  private notifying = new Set<string>()
  /** 关窗确认进行中：主进程重复询问时不再叠第二个框 */
  private quitting = false

  private readonly tabs_: TabBar
  private readonly side_: SidePanel
  /** 检查请求的序号：切换文档后旧结果不能盖掉新结果 */
  private checkSeq = 0

  constructor(private readonly deps: WorkspaceDeps) {
    this.tabs_ = createTabBar(deps.tabbar, {
      onSelect: (id) => this.activate(id),
      onClose: (id) => void this.close(id),
      onNew: () => this.openNew()
    })
    this.side_ = createSidePanel(deps.outline, {
      onPickOutline: (pos) => this.active()?.editor.jumpTo(pos),
      onPickIssue: (issue) => this.pickIssue(issue),
      onRunCheck: () => void this.runCheck(),
      onModeChange: (mode) => {
        if (mode === 'issues') void this.runCheck()
        else this.updateOutline()
      }
    })
    deps.metaEl.addEventListener('click', () => this.toggleMetaMenu())
  }

  private active(): DocTab | null {
    return this.tabs.find((tab) => tab.id === this.activeId) ?? null
  }

  private find(path: string): DocTab | null {
    const key = path.toLowerCase()
    return this.tabs.find((tab) => tab.state.path?.toLowerCase() === key) ?? null
  }

  // ---- 标签生命周期 ----

  private createTab(state: DocState): DocTab {
    const host = document.createElement('div')
    host.className = 'editor-mount'
    host.style.display = 'none'
    this.deps.editorHost.appendChild(host)

    const id = state.path ?? `new#${++this.newSeq}`
    const tab: DocTab = {
      id,
      key: draftKeyOf(state.path, id),
      state,
      host,
      editor: undefined as unknown as MarkdownEditor,
      active: false,
      suspended: false
    }

    tab.editor = createEditor(
      host,
      (text) => {
        tab.state = withText(tab.state, text)
        if (tab.active) {
          this.refreshName()
          this.renderTabs()
        }
        this.schedulePersist()
        this.scheduleDraft()
        this.scheduleAutoSave()
      },
      () => {
        if (tab.active) {
          this.updateMetrics()
          this.updateOutline()
        }
      },
      (target) => this.routeLink(target),
      (error) => this.notify(error)
    )
    tab.editor.setText(state.text)
    tab.editor.setDocPath(state.path ?? '')
    this.tabs.push(tab)
    if (state.path) void window.mdforge.watch(state.path)
    return tab
  }

  openSnapshot(snapshot: FileSnapshot): DocTab {
    const existing = this.find(snapshot.path)
    if (existing) {
      this.activate(existing.id)
      return existing
    }
    const tab = this.createTab(fromSnapshot(snapshot))
    this.pushRecent(snapshot.path)
    this.activate(tab.id)
    return tab
  }

  async openPath(path: string): Promise<void> {
    const existing = this.find(path)
    if (existing) {
      // 已经打开且没改过：跟着磁盘走，避免展示过期内容
      if (isDirty(existing.state)) this.activate(existing.id)
      else if (await this.reloadTab(existing)) this.activate(existing.id)
      return
    }
    const result = await window.mdforge.read(path)
    if (!result.ok) {
      this.notify(result.error)
      return
    }
    this.openSnapshot(result.value)
  }

  /** 第二个实例送来新的启动参数（双击 .md 复用已开窗口）：重新拉取并逐个打开 */
  async openStartupPaths(): Promise<void> {
    for (const target of await window.mdforge.startupPaths()) await this.openPath(target)
  }

  openNew(): void {
    const tab = this.createTab(emptyDoc())
    this.activate(tab.id)
    tab.editor.focus()
  }

  async close(id: string): Promise<boolean> {
    const index = this.tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return false
    const tab = this.tabs[index]

    if (isDirty(tab.state) || isUnsavedNew(tab.state)) {
      const choice = await askDialog<CloseChoice>({
        title: '关闭前保存？',
        body: `“${displayNameOf(tab.state)}” 有未保存的修改。`,
        note: '选择“不保存关闭”会连同崩溃草稿一起丢弃这些修改。',
        options: [
          { label: '保存并关闭', value: 'save', kind: 'default' },
          { label: '不保存关闭', value: 'discard', kind: 'danger' },
          { label: '取消', value: 'cancel' }
        ],
        cancelValue: 'cancel'
      })
      if (choice === 'cancel') return false
      if (choice === 'save') {
        this.activate(tab.id)
        await this.save()
        // 保存可能被冲突框打断，仍是脏的就留在界面里
        if (isDirty(tab.state) || isUnsavedNew(tab.state)) return false
      }
    }

    tab.editor.destroy()
    tab.host.remove()
    this.tabs.splice(index, 1)
    void window.mdforge.draftClear([tab.key])

    if (tab.state.path && !this.find(tab.state.path)) void window.mdforge.unwatch(tab.state.path)

    if (this.activeId === id) {
      const next = this.tabs[index] ?? this.tabs[index - 1] ?? this.tabs[0]
      this.activeId = null
      if (next) this.activate(next.id)
      else this.openNew()
    } else {
      this.refreshChrome()
    }
    return true
  }

  activate(id: string): void {
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab) return
    this.activeId = id
    for (const t of this.tabs) {
      t.active = t.id === id
      t.host.style.display = t.active ? 'block' : 'none'
    }
    tab.editor.focus()
    this.refreshChrome()
    this.schedulePersist()
    // 检查面板跟着当前文档走
    if (this.side_.mode() === 'issues') void this.runCheck()
  }

  // ---- 写盘 / 导出 ----

  async save(): Promise<void> {
    const tab = this.active()
    if (!tab) return
    this.lastError = null

    if (tab.state.path === null) {
      await this.saveAs()
      return
    }

    const result = await window.mdforge.write(writeRequest(tab.state))
    if (!result.ok && result.error.code === 'conflict') {
      await this.resolveConflict(tab, result.error)
    } else if (result.ok) {
      this.noteSaved(tab, result.value)
    } else {
      this.notify(result.error)
    }
    this.refreshChrome()
  }

  /** 冲突时三条路都要给：覆盖、重新载入、暂时都不动 */
  private async resolveConflict(tab: DocTab, error: FileErrorInfo): Promise<void> {
    const choice = await askDialog<ConflictChoice>({
      title: '文件在外部已被修改',
      body: error.path ?? error.message,
      note: '“重新载入”丢弃当前编辑内容；“用当前内容覆盖”会丢掉磁盘上别人改的那一份。',
      options: [
        { label: '重新载入磁盘版本', value: 'reload', kind: 'plain' },
        { label: '用当前内容覆盖', value: 'overwrite', kind: 'danger' },
        { label: '稍后处理', value: 'later', kind: 'default' }
      ],
      cancelValue: 'later'
    })

    if (choice === 'reload') {
      if (await this.reloadTab(tab)) this.setMessage('已重新载入磁盘上的版本')
    } else if (choice === 'overwrite') {
      const forced = await window.mdforge.write(writeRequest(tab.state, true))
      if (forced.ok) this.noteSaved(tab, forced.value)
      else this.notify(forced.error)
    } else {
      this.notify(error)
      return
    }
    this.renderStatus()
  }

  async saveAs(): Promise<void> {
    const tab = this.active()
    if (!tab) return
    const result = await window.mdforge.saveAs(tab.state.text, tab.state.meta)
    if (result.ok) this.noteSaved(tab, result.value)
    else this.notify(result.error)
    this.refreshChrome()
  }

  async openViaDialog(): Promise<void> {
    const result = await window.mdforge.openMany()
    if (!result.ok) {
      this.notify(result.error)
      return
    }
    for (const path of result.value) await this.openPath(path)
  }

  // ---- 导出 ----

  /** 菜单栏"文件 → 导出"浮层用的条目；导出动作会关掉菜单，设置页不收 */
  exportEntries(): MenuEntry[] {
    return [
      { label: '导出 HTML…', run: () => void this.runExport('html') },
      { label: '导出 PDF…', run: () => void this.runExport('pdf') },
      { label: '导出 Markdown 副本…', run: () => void this.runExport('md') },
      { label: '导出纯文本…', hint: '去标记后写 txt', run: () => void this.runExport('txt') },
      { divider: true, label: '' },
      { label: '导出选项', children: () => this.exportOptionEntries() }
    ]
  }

  /** 设置页留在原处不关（keepOpen），导出动作才关闭菜单 */
  exportOptionEntries(): MenuEntry[] {
    const o = this.exportOptions
    const note = (text: string): MenuEntry => ({ label: text, group: '说明', disabled: true })

    return [
      note('图片处理只影响 HTML 导出，PDF 一律内联'),
      ...ASSET_MODES.map<MenuEntry>((mode) => ({
        label: ASSET_MODE_LABELS[mode],
        group: '图片资源',
        checked: mode === o.assets,
        hint: ASSET_MODE_NOTES[mode],
        keepOpen: true,
        run: () => this.setExportOptions({ assets: mode })
      })),
      {
        label: '在开头插入目录',
        group: '文档结构',
        checked: o.toc,
        hint: o.toc ? '按标题层级' : '不插入',
        keepOpen: true,
        run: () => this.setExportOptions({ toc: !o.toc })
      },
      ...THEMES.map<MenuEntry>((theme) => ({
        label: THEME_LABELS[theme],
        group: '主题',
        checked: theme === o.theme,
        hint: theme === o.theme ? '当前' : undefined,
        keepOpen: true,
        run: () => this.setExportOptions({ theme })
      })),
      ...PAPER_SIZES.map<MenuEntry>((paper) => ({
        label: PAPER_LABELS[paper],
        group: '纸张',
        checked: paper === o.paper,
        keepOpen: true,
        run: () => this.setExportOptions({ paper })
      })),
      ...MARGINS.map<MenuEntry>((margin) => ({
        label: MARGIN_LABELS[margin],
        group: '页边距',
        checked: margin === o.margin,
        keepOpen: true,
        run: () => this.setExportOptions({ margin })
      }))
    ]
  }

  private setExportOptions(patch: Partial<ExportOptions>): void {
    this.exportOptions = { ...this.exportOptions, ...patch }
    this.setMessage(`导出设置：${describeExportOptions(this.exportOptions)}`)
    this.schedulePersist()
  }

  private async runExport(kind: ExportKind): Promise<void> {
    const tab = this.active()
    if (!tab) return
    this.clearNotify()
    this.renderStatus()

    const baseName = displayNameOf(tab.state).replace(/\.[^.]+$/, '') || '未命名'
    const options = this.exportOptions

    try {
      if (kind === 'md' || kind === 'txt') {
        const text = kind === 'md' ? tab.state.text : await renderText(tab.state.text)
        const result = await window.mdforge.exportText({
          text,
          docPath: tab.state.path,
          baseName,
          meta: tab.state.meta,
          extension: kind
        })
        if (result.ok) {
          this.setMessage(`已导出：${result.value}`)
          this.revealTarget = result.value
        } else {
          this.notify(result.error)
        }
      } else {
        const input = {
          html: await buildHtml(tab.state.text, deriveTitle(tab.state.text, baseName), options),
          docPath: tab.state.path,
          baseName,
          options
        }
        const result = kind === 'html' ? await window.mdforge.exportHtml(input) : await window.mdforge.exportPdf(input)
        if (result.ok) {
          this.setMessage(`已导出：${result.value.path}${assetNote(result.value.assets, kind === 'pdf')}`)
          this.revealTarget = result.value.path
        } else {
          this.notify(result.error)
        }
      }
    } catch (error) {
      this.notify({ code: 'unknown', message: `导出失败：${error instanceof Error ? error.message : String(error)}` })
    }
  }

  hasUnsaved(): boolean {
    return this.tabs.some((tab) => isDirty(tab.state) || isUnsavedNew(tab.state))
  }

  dropFiles(paths: readonly string[]): void {
    for (const path of paths) void this.openPath(path)
  }

  // ---- 菜单入口 ----

  /** 逐个保存有改动的标签；保存框被取消或冲突没解决的就留在原样 */
  async saveAll(): Promise<void> {
    const restore = this.activeId
    let saved = 0
    for (const tab of [...this.tabs]) {
      if (!isDirty(tab.state) && !isUnsavedNew(tab.state)) continue
      this.activate(tab.id)
      await this.save()
      if (!isDirty(tab.state) && !isUnsavedNew(tab.state)) saved += 1
    }
    if (restore && this.tabs.some((tab) => tab.id === restore)) this.activate(restore)
    this.setMessage(saved > 0 ? `已保存 ${saved} 个文档` : '没有需要保存的改动')
  }

  async closeActive(): Promise<void> {
    const tab = this.active()
    if (tab) await this.close(tab.id)
  }

  revealActive(): void {
    const tab = this.active()
    if (!tab) return
    if (tab.state.path === null) {
      this.setMessage('未命名文档还没有文件路径，先保存一次才能在文件夹里显示')
      return
    }
    void window.mdforge.reveal(tab.state.path)
    this.setMessage(`已在文件夹中显示：${tab.state.path}`)
  }

  recentPaths(): string[] {
    return [...this.recents]
  }

  runActive(action: EditorAction): void {
    const tab = this.active()
    if (!tab) return
    // 先把焦点还给编辑器：从菜单点进来的动作要和按快捷键时落在同一处
    tab.editor.focus()
    tab.editor.run(action)
  }

  editorFacts(): EditorFacts {
    return this.active()?.editor.facts() ?? { canUndo: false, canRedo: false, hasSelection: false }
  }

  focusActive(): void {
    this.active()?.editor.focus()
  }

  sourceMode(): boolean {
    return this.active()?.editor.sourceMode() ?? false
  }

  toggleSourceMode(): void {
    const tab = this.active()
    if (tab) tab.editor.setSourceMode(!tab.editor.sourceMode())
  }

  /** 深浅色切换后重画按主题渲染的块（mermaid 等），并丢掉旧配色的缓存 */
  applyTheme(): void {
    clearMermaidCache()
    for (const tab of this.tabs) tab.editor.refreshDecorations()
  }

  zoom(): number {
    return this.zoomLevel
  }

  setZoom(value: number): void {
    const next = normalizeZoom(value)
    if (next === undefined || next === this.zoomLevel) return
    this.zoomLevel = next
    void window.mdforge.setZoom(next)
    this.schedulePersist()
  }

  zoomIn(): void {
    this.setZoom(ZOOM_STEPS.find((step) => step > this.zoomLevel + 1e-6) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1])
  }

  zoomOut(): void {
    const lower = [...ZOOM_STEPS].reverse().find((step) => step < this.zoomLevel - 1e-6)
    this.setZoom(lower ?? ZOOM_STEPS[0])
  }

  zoomReset(): void {
    this.setZoom(1)
  }

  fontSize(): EditorFontSize {
    return this.fontSizeLevel
  }

  setFontSize(size: EditorFontSize): void {
    const next = normalizeFontSize(size)
    if (next === undefined || next === this.fontSizeLevel) return
    this.fontSizeLevel = next
    this.applyViewPrefs()
    this.schedulePersist()
  }

  contentWidth(): ContentWidth {
    return this.contentWidthMode
  }

  setContentWidth(width: ContentWidth): void {
    const next = normalizeContentWidth(width)
    if (next === undefined || next === this.contentWidthMode) return
    this.contentWidthMode = next
    this.applyViewPrefs()
    this.schedulePersist()
  }

  /** 字号与栏宽都落在 CSS 变量上，所有标签页共用一份 */
  private applyViewPrefs(): void {
    const style = document.documentElement.style
    style.setProperty('--mdf-editor-font-size', `${this.fontSizeLevel}px`)
    const px = CONTENT_WIDTH_PX[this.contentWidthMode]
    style.setProperty('--mdf-content-max', px === null ? 'none' : `${px}px`)
  }

  /** 界面外的状态（主题）变了：把会话再写一遍 */
  persistSoon(): void {
    this.schedulePersist()
  }

  // ---- 编码 / 换行符 ----

  private toggleMetaMenu(): void {
    if (this.metaMenu) {
      this.metaMenu.close()
      this.metaMenu = null
      return
    }
    const tab = this.active()
    if (!tab) return
    this.metaMenu = openMenu(this.deps.metaEl, this.metaMenuEntries(tab), () => {
      this.metaMenu = null
    })
  }

  private metaMenuEntries(tab: DocTab): MenuEntry[] {
    const meta = tab.state.meta
    const saved = tab.state.path !== null
    const page = (group: string, run: (encoding: ChoosableEncoding) => void): MenuEntry[] =>
      ENCODING_CHOICES.map((encoding) => ({
        label: encodingLabel(encoding),
        group,
        checked: encoding === meta.encoding,
        hint: encoding === meta.encoding ? '当前' : undefined,
        run: () => run(encoding)
      }))

    return [
      {
        label: '以其他编码重新载入',
        group: '编码',
        hint: saved ? '▸' : '需已保存',
        disabled: !saved,
        children: page('以其他编码重新载入', (encoding) => void this.reloadWithEncoding(tab, encoding))
      },
      {
        label: '以其他编码另存为',
        group: '编码',
        hint: '▸',
        children: page('以其他编码另存为', (encoding) => void this.saveAsWithEncoding(tab, encoding))
      },
      {
        label: 'Windows (CRLF)',
        group: '换行符',
        checked: meta.eol === 'crlf',
        hint: meta.eolMixed ? '将统一' : undefined,
        run: () => this.setEol(tab, 'crlf')
      },
      {
        label: 'Unix (LF)',
        group: '换行符',
        checked: meta.eol === 'lf',
        hint: meta.eolMixed ? '将统一' : undefined,
        run: () => this.setEol(tab, 'lf')
      }
    ]
  }

  private setEol(tab: DocTab, eol: Eol): void {
    if (tab.state.meta.eol === eol && !tab.state.meta.eolMixed) return
    const wasMixed = tab.state.meta.eolMixed
    tab.state = withMeta(tab.state, { ...tab.state.meta, eol, eolMixed: false })
    this.setMessage(`写回换行符改为 ${eol.toUpperCase()}${wasMixed ? '（原本混合，保存时统一）' : ''}，下次保存生效`)
    this.refreshChrome()
    this.schedulePersist()
    this.scheduleAutoSave()
  }

  /** 编码自动检测错判时的纠正入口：按点选的编码重新解码磁盘上的原始字节 */
  private async reloadWithEncoding(tab: DocTab, encoding: ChoosableEncoding): Promise<void> {
    if (tab.state.path === null) return
    if (isDirty(tab.state)) {
      const go = await askDialog<boolean>({
        title: '重新载入会丢弃当前修改',
        body: `“${displayNameOf(tab.state)}” 还有未保存的修改。`,
        options: [
          { label: '仍然重新载入', value: true, kind: 'danger' },
          { label: '取消', value: false, kind: 'default' }
        ],
        cancelValue: false
      })
      if (!go) return
    }
    const result = await window.mdforge.readAs(tab.state.path, encoding)
    if (!result.ok) {
      this.notify(result.error)
      return
    }
    this.applySnapshot(tab, result.value)
    // 强制解码可能出现解不开的字节：这是"选错编码"的信号，要说给用户听
    if (result.value.text.includes('\uFFFD')) {
      this.notify({
        code: 'encoding-unsupported',
        message: `按 ${encodingLabel(encoding)} 解码出现无法识别的字符`,
        hint: '多半不是这个编码，可再换一个试试',
        path: result.value.path
      })
      return
    }
    this.setMessage(`已按 ${encodingLabel(encoding)} 重新载入`)
  }

  /** 转码另存：正文不变，只换写回编码，走系统保存框挑位置 */
  private async saveAsWithEncoding(tab: DocTab, encoding: ChoosableEncoding): Promise<void> {
    const meta = { ...tab.state.meta, encoding, bom: encoding === 'utf-8-bom', eolMixed: false }
    const result = await window.mdforge.saveAs(tab.state.text, meta)
    if (!result.ok) {
      this.notify(result.error)
      this.refreshChrome()
      return
    }
    this.noteSaved(tab, result.value, `已按 ${encodingLabel(encoding)} 另存为`)
    this.refreshChrome()
  }

  // ---- 外部修改 ----

  async handleExternalChange(change: ExternalChange): Promise<void> {
    const tab = this.find(change.path)
    if (!tab) return

    if (change.kind === 'deleted') {
      this.notify({
        code: 'not-found',
        message: `文件已被外部删除或移动：${change.path}`,
        hint: '编辑内容还在内存里，可用“另存为”保住',
        path: change.path
      })
      tab.suspended = true
      return
    }

    if (!isDirty(tab.state)) {
      // 没改动就跟着磁盘走，和 Typora 一样不打扰
      if (await this.reloadTab(tab)) this.setMessage('文件已在外部修改，已自动重新载入')
      return
    }

    if (this.notifying.has(tab.id)) return
    this.notifying.add(tab.id)
    const choice = await askDialog<ExternalChoice>({
      title: '文件在外部被修改',
      body: `“${displayNameOf(tab.state)}” 被其他程序改过，而你在这里还有未保存的改动。`,
      note: '“重新载入”丢弃当前编辑内容；“保留我的版本”会立刻把当前内容覆盖到磁盘。',
      options: [
        { label: '重新载入磁盘版本', value: 'reload' },
        { label: '保留我的版本', value: 'keep', kind: 'danger' },
        { label: '稍后处理', value: 'later', kind: 'default' }
      ],
      cancelValue: 'later'
    })
    this.notifying.delete(tab.id)

    if (choice === 'reload') {
      if (await this.reloadTab(tab)) this.setMessage('已重新载入磁盘上的版本')
    } else if (choice === 'keep') {
      const forced = await window.mdforge.write(writeRequest(tab.state, true))
      if (forced.ok) this.noteSaved(tab, forced.value, '已用当前内容覆盖外部版本')
      else this.notify(forced.error)
    } else {
      this.setMessage('文件在外部已被修改，尚未处理：保存时会再确认一次')
    }
    this.refreshChrome()
  }

  private async reloadTab(tab: DocTab, encoding?: ChoosableEncoding): Promise<boolean> {
    if (tab.state.path === null) return false
    const result = encoding
      ? await window.mdforge.readAs(tab.state.path, encoding)
      : await window.mdforge.read(tab.state.path)
    if (!result.ok) {
      this.notify(result.error)
      return false
    }
    this.applySnapshot(tab, result.value)
    return true
  }

  private applySnapshot(tab: DocTab, snapshot: FileSnapshot): void {
    tab.editor.setText(snapshot.text)
    tab.state = fromSnapshot(snapshot)
    tab.suspended = false
    void window.mdforge.draftClear([tab.key])
    this.refreshChrome()
  }

  // ---- 自动保存 / 崩溃草稿 ----

  toggleAutoSave(): void {
    this.autoSave = !this.autoSave
    this.renderAutoSaveButton()
    this.setMessage(this.autoSave ? '自动保存已开启' : '自动保存已关闭，未保存内容只靠崩溃草稿')
    if (this.autoSave) this.scheduleAutoSave()
    this.schedulePersist()
  }

  autoSaveEnabled(): boolean {
    return this.autoSave
  }

  private scheduleAutoSave(): void {
    if (!this.autoSave) return
    if (this.autoSaveTimer !== undefined) window.clearTimeout(this.autoSaveTimer)
    this.autoSaveTimer = window.setTimeout(() => void this.autoSaveTick(), AUTOSAVE_DELAY_MS)
  }

  private async autoSaveTick(): Promise<void> {
    this.autoSaveTimer = undefined
    if (!this.autoSave) return

    let again = false
    for (const tab of this.tabs) {
      // 未命名文档没有路径可写，交给崩溃草稿兜底
      if (tab.state.path === null || tab.suspended || !isDirty(tab.state)) continue
      if (tab.editor.composing()) {
        again = true
        continue
      }
      const result = await window.mdforge.write(writeRequest(tab.state))
      if (result.ok) {
        this.noteSaved(tab, result.value, `已自动保存：${displayNameOf(tab.state)}`, false)
      } else {
        tab.suspended = true
        if (result.error.code === 'conflict') await this.resolveConflict(tab, result.error)
        else this.notify(result.error)
      }
    }
    // 输入法合成中的文档稍后再试一轮
    if (again) this.scheduleAutoSave()
    this.refreshChrome()
  }

  private scheduleDraft(): void {
    if (this.draftTimer !== undefined) window.clearTimeout(this.draftTimer)
    this.draftTimer = window.setTimeout(() => void this.flushDrafts(), DRAFT_DELAY_MS)
  }

  private async flushDrafts(): Promise<void> {
    this.draftTimer = undefined
    const clean: string[] = []
    for (const tab of this.tabs) {
      if (!isDirty(tab.state) && !isUnsavedNew(tab.state)) {
        clean.push(tab.key)
        continue
      }
      const draft: DocDraft = {
        key: tab.key,
        path: tab.state.path,
        name: displayNameOf(tab.state),
        text: tab.state.text,
        meta: tab.state.meta,
        updatedAt: Date.now()
      }
      await window.mdforge.draftWrite(draft)
    }
    if (clean.length > 0) await window.mdforge.draftClear(clean)
  }

  /** 重启后处理上次异常退出留下的草稿 */
  private async restoreDrafts(): Promise<void> {
    const drafts = await window.mdforge.draftList()
    if (drafts.length === 0) return

    // 内容与磁盘一致的草稿多半是"保存后还没来得及清理"，直接丢掉
    const staleSame: string[] = []
    const pending: DocDraft[] = []
    for (const draft of drafts) {
      const tab = draft.path ? this.find(draft.path) : null
      if (tab && tab.state.baseline === draft.text) staleSame.push(draft.key)
      else pending.push(draft)
    }
    if (staleSame.length > 0) void window.mdforge.draftClear(staleSame)
    if (pending.length === 0) return

    const restore = await askDialog<boolean>({
      title: '上次有内容没保存下来',
      body: `发现 ${pending.length} 份崩溃草稿，是否恢复？`,
      lines: pending.map(
        (draft) => `${draft.name}${draft.path === null ? '（未命名）' : ''} · ${formatTime(draft.updatedAt)}`
      ),
      options: [
        { label: '恢复这些草稿', value: true, kind: 'default' },
        { label: '全部丢弃', value: false, kind: 'danger' }
      ],
      cancelValue: false
    })

    if (!restore) {
      await window.mdforge.draftClear(pending.map((draft) => draft.key))
      return
    }

    for (const draft of pending) this.applyDraft(draft)
    // 未命名草稿恢复后标签换了键，旧文件不再有人认领
    const live = new Set(this.tabs.map((tab) => tab.key))
    const orphaned = pending.map((draft) => draft.key).filter((key) => !live.has(key))
    if (orphaned.length > 0) await window.mdforge.draftClear(orphaned)
    await this.flushDrafts()
    this.setMessage(`已恢复 ${pending.length} 份未保存内容，请尽快保存`)
  }

  private applyDraft(draft: DocDraft): void {
    const existing = draft.path ? this.find(draft.path) : null
    if (existing) {
      existing.editor.setText(draft.text)
      existing.state = withMeta(existing.state, draft.meta)
      existing.suspended = false
      this.activate(existing.id)
      return
    }
    const tab = this.createTab(withMeta({ ...emptyDoc(), path: draft.path, text: draft.text }, draft.meta))
    if (draft.path) this.pushRecent(draft.path)
    this.activate(tab.id)
    tab.editor.focus()
  }

  // ---- 关闭确认 ----

  /** 主进程拦住 close 后问过来的：用应用内确认框决定要不要放行 */
  async confirmWindowClose(): Promise<void> {
    // 主进程没等到回答会隔 20 秒再问一次，已经问过就不再叠第二个框
    if (this.quitting) return
    this.quitting = true
    try {
      await this.askWindowClose()
    } finally {
      this.quitting = false
    }
  }

  private async askWindowClose(): Promise<void> {
    if (!this.hasUnsaved()) {
      window.mdforge.answerWindowClose(true)
      return
    }
    const dirty = this.tabs.filter((tab) => isDirty(tab.state) || isUnsavedNew(tab.state))
    const choice = await askDialog<CloseChoice>({
      title: '关闭窗口前保存？',
      body:
        dirty.length === 1
          ? `“${displayNameOf(dirty[0].state)}” 有未保存的修改。`
          : `有 ${dirty.length} 个文档还没保存。`,
      note: '未命名文档需要先选保存位置，自动化环境下可能被取消。',
      options: [
        { label: '全部保存并关闭', value: 'save', kind: 'default' },
        { label: '放弃修改并关闭', value: 'discard', kind: 'danger' },
        { label: '取消', value: 'cancel' }
      ],
      cancelValue: 'cancel'
    })

    if (choice === 'cancel') {
      window.mdforge.answerWindowClose(false)
      return
    }
    if (choice === 'discard') {
      // 用户明确放弃，草稿也就没有保留的意义了
      await window.mdforge.draftClear(dirty.map((tab) => tab.key))
      window.mdforge.answerWindowClose(true)
      return
    }

    for (const tab of [...dirty]) {
      this.activate(tab.id)
      await this.save()
    }
    if (this.hasUnsaved()) {
      // 还有冲突没解决，留在界面里让用户处理
      window.mdforge.answerWindowClose(false)
      return
    }
    window.mdforge.answerWindowClose(true)
  }

  // ---- 内部 ----

  private noteSaved(tab: DocTab, snapshot: FileSnapshot, message?: string, reveal = true): void {
    const previousPath = tab.state.path
    const previousKey = tab.key
    tab.state = afterSave(snapshot, tab.state)
    tab.suspended = false
    if (previousPath === null) {
      this.pushRecent(snapshot.path)
      // 第一次落盘才谈得上"外部修改"：此时才补上监视，并把草稿键换成路径推导的键
      void window.mdforge.watch(snapshot.path)
      tab.key = draftKeyOf(snapshot.path, tab.id)
    }
    tab.editor.setDocPath(snapshot.path)
    this.lastError = null
    this.lastMessage = message ?? `已保存：${snapshot.path}`
    this.revealTarget = reveal ? snapshot.path : null
    void window.mdforge.draftClear([previousKey, tab.key])
    this.schedulePersist()
  }

  private pushRecent(path: string): void {
    const key = path.toLowerCase()
    this.recents = [path, ...this.recents.filter((p) => p.toLowerCase() !== key)].slice(0, MAX_RECENTS)
  }

  private routeLink(target: LinkTarget): void {
    if (target.kind === 'external' && target.url) void window.mdforge.openExternal(target.url)
    else if (target.kind === 'relative-md' && target.localPath) void this.openPath(target.localPath)
  }

  private notify(error: FileErrorInfo): void {
    this.lastError = error
    this.lastMessage = ''
    this.revealTarget = null
    this.renderStatus()
  }

  /** 报一条好消息：必须先抹掉上一次的错误，否则状态栏会一直挂着旧报错 */
  private setMessage(text: string): void {
    this.lastError = null
    this.revealTarget = null
    this.lastMessage = text
    this.renderStatus()
  }

  private clearNotify(): void {
    this.lastError = null
    this.lastMessage = ''
    this.revealTarget = null
  }

  private renderTabs(): void {
    const items: TabItem[] = this.tabs.map((tab) => ({
      id: tab.id,
      name: displayNameOf(tab.state),
      dirty: isDirty(tab.state) || isUnsavedNew(tab.state),
      active: tab.id === this.activeId
    }))
    this.tabs_.render(items)
  }

  private refreshName(): void {
    const tab = this.active()
    if (!tab) return
    const name = displayNameOf(tab.state)
    const dirty = isDirty(tab.state)
    this.deps.nameEl.textContent = `${name}${dirty ? ' •' : ''}`
    const meta = tab.state.meta
    this.deps.metaEl.textContent = `${encodingLabel(meta.encoding)} · ${meta.eol.toUpperCase()}${
      meta.eolMixed ? ' (混合)' : ''
    }`
    this.deps.metaEl.dataset.encoding = meta.encoding
    this.deps.metaEl.dataset.eol = meta.eol
    document.title = `${dirty ? '*' : ''}${name} - MDForge`
  }

  private renderAutoSaveButton(): void {
    this.deps.autoSaveEl.textContent = `自动保存：${this.autoSave ? '开' : '关'}`
    this.deps.autoSaveEl.dataset.on = this.autoSave ? '1' : '0'
    this.deps.autoSaveEl.setAttribute('aria-pressed', this.autoSave ? 'true' : 'false')
    this.deps.autoSaveEl.title = this.autoSave
      ? `停止编辑 ${AUTOSAVE_DELAY_MS / 1000} 秒后写回磁盘（未命名文档除外）`
      : '自动保存已关闭，未保存内容只写崩溃草稿'
  }

  private updateMetrics(): void {
    const tab = this.active()
    if (tab) this.deps.statusMetrics.textContent = formatMetrics(tab.editor.status())
  }

  private updateOutline(): void {
    const tab = this.active()
    if (!tab) return
    this.side_.renderOutline(collectOutline(tab.editor.state()), tab.editor.cursorLine())
    this.side_.markStale()
  }

  // ---- 文档检查 ----

  private async runCheck(): Promise<void> {
    const tab = this.active()
    if (!tab) return
    const seq = ++this.checkSeq
    this.side_.showRunning()

    const docPath = tab.state.path ?? ''
    const source = {
      probe: async (refs: string[]) => {
        if (docPath === '') return { states: refs.map(() => 'unknown' as const), assets: [] }
        const result = await window.mdforge.probeResources({ docPath, refs })
        if (!result.ok) {
          this.notify(result.error)
          return { states: refs.map(() => 'unknown' as const), assets: [] }
        }
        return { states: result.value.states, assets: result.value.assets }
      }
    }

    try {
      const report = await inspectDocument(tab.editor.state(), docPath, source)
      if (seq !== this.checkSeq) return
      this.side_.showReport(report)
    } catch (error) {
      if (seq !== this.checkSeq) return
      this.notify({
        code: 'unknown',
        message: `文档检查失败：${error instanceof Error ? error.message : String(error)}`
      })
      this.side_.showReport({ issues: [], external: 0, checked: 0, note: '检查没有完成' })
    }
  }

  private pickIssue(issue: Issue): void {
    const tab = this.active()
    if (!tab) return
    if (issue.kind === 'unused-asset' && issue.path) {
      void window.mdforge.reveal(issue.path)
      this.setMessage(`已在文件夹中显示：${issue.path}`)
      return
    }
    tab.editor.jumpTo(issue.pos)
  }

  renderStatus(): void {
    const note = this.deps.statusNote
    note.textContent = ''
    if (this.lastError) {
      note.textContent = `${this.lastError.message}${this.lastError.hint ? ` ｜ ${this.lastError.hint}` : ''}`
      note.classList.add('is-error')
      return
    }
    note.classList.remove('is-error')
    if (this.lastMessage === '') return
    const span = document.createElement('span')
    span.textContent = this.lastMessage
    note.appendChild(span)
    if (this.revealTarget) {
      const target = this.revealTarget
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'status-action'
      button.textContent = '在文件夹中显示'
      button.addEventListener('click', () => void window.mdforge.reveal(target))
      note.appendChild(button)
    }
  }

  private refreshChrome(): void {
    this.renderTabs()
    this.refreshName()
    this.renderAutoSaveButton()
    this.updateMetrics()
    this.updateOutline()
    this.renderStatus()
  }

  private schedulePersist(): void {
    if (this.persistTimer !== undefined) window.clearTimeout(this.persistTimer)
    this.persistTimer = window.setTimeout(() => void this.persist(), 500)
  }

  private async persist(): Promise<void> {
    this.persistTimer = undefined
    const openDocs = this.tabs.map((tab) => tab.state.path).filter((p): p is string => p !== null)
    const active = this.active()?.state.path ?? null
    await window.mdforge.sessionWrite({
      openDocs,
      active,
      recents: this.recents,
      autoSave: this.autoSave,
      export: this.exportOptions,
      theme: this.deps.themeMode(),
      zoom: this.zoomLevel,
      fontSize: this.fontSizeLevel,
      contentWidth: this.contentWidthMode
    })
  }

  async init(): Promise<void> {
    const [startup, session] = await Promise.all([window.mdforge.startupPaths(), window.mdforge.sessionRead()])
    this.recents = session?.recents ?? []
    this.autoSave = session?.autoSave ?? true
    this.exportOptions = { ...DEFAULT_EXPORT_OPTIONS, ...session?.export }
    this.zoomLevel = normalizeZoom(session?.zoom) ?? 1
    if (this.zoomLevel !== 1) void window.mdforge.setZoom(this.zoomLevel)
    this.fontSizeLevel = normalizeFontSize(session?.fontSize) ?? DEFAULT_FONT_SIZE
    this.contentWidthMode = normalizeContentWidth(session?.contentWidth) ?? DEFAULT_CONTENT_WIDTH
    this.applyViewPrefs()
    this.renderAutoSaveButton()

    const paths = startup.length > 0 ? startup : (session?.openDocs ?? [])
    for (const path of paths) {
      const result = await window.mdforge.read(path)
      if (result.ok) this.openSnapshot(result.value)
    }

    if (this.tabs.length === 0) {
      this.openNew()
    } else {
      const wanted = session?.active
      const target = wanted ? this.find(wanted) : null
      this.activate(target?.id ?? this.tabs[this.tabs.length - 1].id)
    }

    await this.restoreDrafts()
    if (this.autoSave) this.scheduleAutoSave()
  }
}

function formatTime(millis: number): string {
  const date = new Date(millis)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatMetrics(info: ReturnType<MarkdownEditor['status']>): string {
  const parts = [`字数 ${info.words}`, `字符 ${info.chars}`, `行 ${info.line}，列 ${info.col}`]
  if (info.selChars > 0) parts.push(`选中 ${info.selChars} 字符 · ${info.selLines} 行`)
  if (info.cursors > 1) parts.push(`${info.cursors} 个光标`)
  return parts.join('　｜　')
}

/** 导出结果里只说用户会关心的两件事：图带没带走、有没有引用落空 */
function assetNote(report: AssetReport, pdf: boolean): string {
  const parts: string[] = []
  if (pdf) {
    if (report.inlined > 0) parts.push(`内联 ${report.inlined} 张图片`)
  } else {
    if (report.copied > 0) parts.push(`复制 ${report.copied} 张图片`)
    if (report.inlined > 0) parts.push(`内联 ${report.inlined} 张图片`)
  }
  if (report.missing.length > 0) parts.push(`${report.missing.length} 处图片引用找不到文件`)
  return parts.length === 0 ? '' : `（${parts.join('，')}）`
}

function describeExportOptions(options: ExportOptions): string {
  const parts = [
    `图片 ${ASSET_MODE_LABELS[options.assets]}`,
    `主题 ${THEME_LABELS[options.theme]}`,
    `纸张 ${PAPER_LABELS[options.paper]}`,
    `边距 ${MARGIN_LABELS[options.margin]}`
  ]
  if (options.toc) parts.unshift('带目录')
  return parts.join(' · ')
}
