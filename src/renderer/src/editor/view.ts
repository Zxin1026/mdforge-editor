import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { syntaxHighlighting } from '@codemirror/language'
import { search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, Transaction, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import type { FileErrorInfo } from '../../../shared/ipc'
import { createSlugger } from '../../../shared/slug'
import { markdownKeymap } from './commands'
import { compositionEvents, compositionField, markdownDecorations, themeChanged } from './decorations'
import { docPathField, setDocPath } from './doc-path'
import { frontMatterCollapsed } from './frontmatter'
import { themeHighlight } from './highlight'
import { issueMarkField, marksFromIssues, setIssueMarks } from './issue-marks'
import type { Issue } from './inspect'
import { hoverLabel, linkAt, type LinkTarget } from './links'
import { markdownHighlight, markdownLanguageExtension } from './markdown'
import { imagePaste } from './paste-image'
import { richPaste } from './rich-paste'
import { collectOutline } from './outline'
import { computeStatus, type StatusInfo } from './status'
import { editorFacts, runEditorAction, type EditorAction, type EditorFacts } from './actions'

export interface MarkdownEditor {
  text(): string
  state(): EditorState
  setText(text: string): void
  setDocPath(path: string): void
  docPath(): string
  jumpTo(pos: number): void
  jumpToAnchor(anchor: string): boolean
  /** 光标位置（选区主端），导航历史记位置用 */
  cursorPos(): number
  /** 选中一段并滚动到可见：工作区搜索命中的定位口径 */
  selectRange(from: number, to?: number): void
  cursorLine(): number
  status(): StatusInfo
  /** 检查结果的内联标记（行底色 + 命中片段波浪线） */
  setIssues(issues: readonly Issue[]): void
  /** 输入法还在合成中：此时正文只是半成品拼音，自动保存必须让路 */
  composing(): boolean
  focus(): void
  /** 菜单入口：复用与快捷键相同的命令表 */
  run(action: EditorAction): boolean
  facts(): EditorFacts
  /** 源代码模式：只摘掉行内渲染装饰，正文语法高亮与查找照旧 */
  setSourceMode(on: boolean): void
  sourceMode(): boolean
  /** 深浅色切换后重建装饰集，让 mermaid 之类的主题相关块重画 */
  refreshDecorations(): void
  dom: HTMLElement
  destroy(): void
}

export function createEditor(
  mount: HTMLElement,
  onChange: (text: string) => void,
  onSync: () => void = () => {},
  onLink: (target: LinkTarget) => void = () => {},
  onNotice: (error: FileErrorInfo) => void = () => {}
): MarkdownEditor {
  let view!: EditorView

  function targetAt(clientX: number, clientY: number): LinkTarget | null {
    const pos = view.posAtCoords({ x: clientX, y: clientY })
    if (pos === null) return null
    return linkAt(view.state, pos, view.state.field(docPathField))
  }

  function jumpToAnchor(anchor: string): boolean {
    const slugger = createSlugger()
    for (const item of collectOutline(view.state)) {
      if (slugger.slug(item.text) === anchor) {
        view.dispatch({ selection: { anchor: item.pos }, scrollIntoView: true, userEvent: 'select' })
        view.focus()
        return true
      }
    }
    return false
  }

  function openLink(event: MouseEvent): boolean {
    if (!(event.ctrlKey || event.metaKey)) return false
    const target = targetAt(event.clientX, event.clientY)
    if (!target) return false
    // 锚点也交给工作区处理：那里要先记一个导航历史点再跳
    if (target.kind === 'anchor') {
      onLink(target)
      return true
    }
    if (!target.openable) return false
    onLink(target)
    return true
  }

  const hover = createHover()
  const renderMode = new Compartment()
  let source = false

  const extensions: Extension[] = [
    history({ newGroupDelay: 500 }),
    EditorView.lineWrapping,
    docPathField,
    compositionField,
    frontMatterCollapsed,
    compositionEvents,
    markdownLanguageExtension,
    renderMode.of(markdownDecorations),
    issueMarkField,
    // 顺序要紧：markdown 限定样式先覆盖标题与链接的下划线，代码块交给主题高亮
    syntaxHighlighting(markdownHighlight),
    syntaxHighlighting(themeHighlight),
    search({ top: true }),
    imagePaste({ notify: onNotice }),
    // 图片之后接管：带 HTML 的剪贴板先转成 Markdown，纯文本仍走默认行为
    richPaste(),
    // markdown 命令在前：Enter 只在列表/引用里续写，其余交回默认换行
    keymap.of(markdownKeymap),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab, ...searchKeymap]),
    EditorView.domEventHandlers({
      mousedown: (event) => openLink(event),
      mousemove: (event) => hover.move(event, targetAt),
      mouseleave: () => hover.hide(),
      keydown: () => hover.hide(),
      scroll: () => hover.hide()
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange(update.state.doc.toString())
      if (update.docChanged || update.selectionSet) onSync()
    })
  ]

  view = new EditorView({
    parent: mount,
    state: EditorState.create({ doc: '', extensions })
  })

  return {
    text: () => view.state.doc.toString(),
    state: () => view.state,
    setText: (text) => {
      if (text === view.state.doc.toString()) return
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        annotations: [Transaction.addToHistory.of(false)],
        scrollIntoView: false
      })
      onSync()
    },
    setDocPath: (path) => {
      if (view.state.field(docPathField) === path) return
      view.dispatch({ effects: setDocPath.of(path) })
    },
    docPath: () => view.state.field(docPathField),
    jumpTo: (pos) => {
      const line = view.state.doc.lineAt(pos)
      view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true, userEvent: 'select' })
      view.focus()
    },
    jumpToAnchor: (anchor) => jumpToAnchor(anchor),
    cursorPos: () => view.state.selection.main.head,
    selectRange: (from, to) => {
      const doc = view.state.doc
      const anchor = Math.max(0, Math.min(from, doc.length))
      const head = Math.max(anchor, Math.min(to ?? from, doc.length))
      view.dispatch({ selection: { anchor, head }, scrollIntoView: true, userEvent: 'select' })
      view.focus()
    },
    cursorLine: () => view.state.doc.lineAt(view.state.selection.main.head).number,
    status: () => computeStatus(view.state),
    setIssues: (issues) => {
      view.dispatch({ effects: setIssueMarks.of(marksFromIssues(issues)) })
    },
    composing: () => view.state.field(compositionField).composing,
    focus: () => view.focus(),
    run: (action) => runEditorAction(view, action),
    facts: () => editorFacts(view),
    setSourceMode: (on) => {
      if (on === source) return
      source = on
      view.dispatch({
        effects: renderMode.reconfigure(on ? [] : markdownDecorations),
        scrollIntoView: false
      })
      view.focus()
    },
    sourceMode: () => source,
    refreshDecorations: () => {
      view.dispatch({ effects: themeChanged.of(null) })
    },
    dom: view.dom,
    destroy: () => {
      hover.destroy()
      view.destroy()
    }
  }
}

/** 悬浮预览：无第三方 tooltip 依赖，用一个跟随鼠标的浮层。 */
function createHover() {
  let tip: HTMLElement | null = null
  let shown: string | null = null

  function ensure(): HTMLElement {
    if (tip) return tip
    tip = document.createElement('div')
    tip.className = 'mdf-hover'
    tip.style.display = 'none'
    document.body.appendChild(tip)
    return tip
  }

  return {
    move(event: MouseEvent, targetAt: (x: number, y: number) => LinkTarget | null): boolean {
      const target = targetAt(event.clientX, event.clientY)
      if (!target || target.kind === 'other') {
        this.hide()
        return false
      }
      const el = ensure()
      const key = `${target.kind}:${target.raw}`
      if (key !== shown) {
        el.replaceChildren()
        if (target.kind === 'image' && target.previewSrc) {
          const img = document.createElement('img')
          img.src = target.previewSrc
          img.className = 'mdf-hover-img'
          el.appendChild(img)
        }
        const label = document.createElement('div')
        label.className = 'mdf-hover-text'
        label.textContent = hoverLabel(target)
        el.appendChild(label)
        shown = key
      }
      el.style.display = 'block'
      const rect = el.getBoundingClientRect()
      const pad = 14
      let x = event.clientX + pad
      let y = event.clientY + pad
      if (x + rect.width > window.innerWidth) x = event.clientX - rect.width - pad
      if (y + rect.height > window.innerHeight) y = event.clientY - rect.height - pad
      el.style.left = `${Math.max(4, x)}px`
      el.style.top = `${Math.max(4, y)}px`
      return false
    },
    hide(): void {
      if (tip) tip.style.display = 'none'
      shown = null
    },
    destroy(): void {
      tip?.remove()
      tip = null
      shown = null
    }
  }
}
