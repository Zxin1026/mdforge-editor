import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  type CloseBracketConfig
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { codeFolding, foldGutter, foldKeymap, syntaxHighlighting } from '@codemirror/language'
import { search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, Prec, Transaction, type Extension } from '@codemirror/state'
import { Decoration, EditorView, keymap, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
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
  /** 批量字面替换正文片段（资源改引用用），进撤销历史，返回实际应用条数 */
  applyEdits(edits: ReadonlyArray<{ from: number; to: number; insert: string }>): number
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
  /** 打字机模式：光标行始终落在视口中线附近 */
  setTypewriter(on: boolean): void
  typewriter(): boolean
  /** 专注模式：只突出光标所在段落，其余行淡化 */
  setFocusMode(on: boolean): void
  focusMode(): boolean
  /** 阅读模式：只读，不接受编辑 */
  setReadOnly(on: boolean): void
  readOnly(): boolean
  /** 深浅色切换后重建装饰集，让 mermaid 之类的主题相关块重画 */
  refreshDecorations(): void
  dom: HTMLElement
  destroy(): void
}

/** 段落范围：以空行为界，光标所在的那一整段 */
function paragraphRange(state: EditorState): { from: number; to: number } {
  const line = state.doc.lineAt(state.selection.main.head)
  let first = line.number
  while (first > 1 && state.doc.line(first - 1).text.trim() !== '') first -= 1
  let last = line.number
  while (last < state.doc.lines && state.doc.line(last + 1).text.trim() !== '') last += 1
  return { from: state.doc.line(first).from, to: state.doc.line(last).to }
}

const FOCUS_DIM_LINE = Decoration.line({ class: 'mdf-focus-dim' })

function buildFocusDecorations(state: EditorState): DecorationSet {
  const active = paragraphRange(state)
  const ranges = []
  for (let number = 1; number <= state.doc.lines; number += 1) {
    const line = state.doc.line(number)
    if (line.from >= active.from && line.to <= active.to) continue
    ranges.push(FOCUS_DIM_LINE.range(line.from))
  }
  return Decoration.set(ranges, true)
}

/** 专注模式：光标所在段落之外的行淡化 */
const focusPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildFocusDecorations(view.state)
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet) this.decorations = buildFocusDecorations(update.state)
    }
  },
  { decorations: (plugin) => plugin.decorations }
)

/**
 * 打字机模式：每次移动光标或改字后把光标行拨到视口中线。
 * 在测量阶段直接改 scrollTop（不派发新事务），避免更新回调里嵌套 dispatch。
 */
const typewriterExtension = EditorView.updateListener.of((update) => {
  if (!(update.docChanged || update.selectionSet)) return
  const view = update.view
  if (view.state.field(compositionField, false)?.composing) return
  const pos = update.state.selection.main.head
  view.requestMeasure({
    read: (target) => target.coordsAtPos(pos),
    write: (coords, target) => {
      if (!coords) return
      const scroller = target.scrollDOM
      const rect = scroller.getBoundingClientRect()
      const delta = coords.top - (rect.top + rect.height / 2)
      if (Math.abs(delta) < 1) return
      scroller.scrollTop += delta
    }
  })
})

/**
 * 打字机需要上下都留半屏，第一行与最后一行才挪得动。
 * 走 CM6 主题（框架自己维护主题类名）：直接往 view.dom 加自定义类，
 * 下一次编辑更新时会被 CodeMirror 重写 className 抹掉。
 */
const typewriterTheme = EditorView.theme({
  '&.cm-editor .cm-content': {
    paddingTop: '38vh',
    paddingBottom: '46vh'
  }
})

/** 括号配对：默认集合（( [ { 引号）补上反引号，行内代码离不开它 */
const bracketPairing = EditorState.languageData.of(() => [
  { closeBrackets: { brackets: ['(', '[', '{', "'", '"', '`'] } satisfies CloseBracketConfig }
])

/**
 * 手打围栏守卫：closeBrackets 把反引号当引号配对，连敲三个会先补一对再补一对
 * 变成四个。光标左侧已有反引号、右侧又没有配对留下的反引号时，直接落单字——
 * 于是 ``` 就是三个，```` 就是四个，配对与收尾跳过仍交给 closeBrackets。
 */
const backtickGuard = Prec.high(
  EditorView.inputHandler.of((view, from, to, insert) => {
    if (insert !== '`' || from !== to || view.composing || view.state.readOnly) return false
    const line = view.state.doc.lineAt(from)
    if (!view.state.sliceDoc(line.from, from).endsWith('`')) return false
    if (view.state.sliceDoc(from, from + 1) === '`') return false
    view.dispatch({ changes: { from, insert: '`' }, selection: { anchor: from + 1 }, userEvent: 'input.type' })
    return true
  })
)

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
  const typewriterComp = new Compartment()
  const focusComp = new Compartment()
  const readComp = new Compartment()
  let source = false
  let typewriterOn = false
  let focusOn = false
  let readOn = false

  const extensions: Extension[] = [
    history({ newGroupDelay: 500 }),
    EditorView.lineWrapping,
    docPathField,
    compositionField,
    frontMatterCollapsed,
    compositionEvents,
    markdownLanguageExtension,
    renderMode.of(markdownDecorations),
    typewriterComp.of([]),
    focusComp.of([]),
    readComp.of([]),
    issueMarkField,
    // 顺序要紧：markdown 限定样式先覆盖标题与链接的下划线，代码块交给主题高亮
    syntaxHighlighting(markdownHighlight),
    syntaxHighlighting(themeHighlight),
    search({ top: true }),
    // 折叠来自语言定义（markdown 的 Block 与标题 section），这里只挂开关与折叠槽
    codeFolding(),
    foldGutter(),
    // 括号配对 + 补全：markdown 自带 HTML 标签补全，代码块内按 language-data 的语言补全
    backtickGuard,
    bracketPairing,
    closeBrackets(),
    autocompletion(),
    imagePaste({ notify: onNotice }),
    // 图片之后接管：带 HTML 的剪贴板先转成 Markdown，纯文本仍走默认行为
    richPaste(),
    // markdown 命令在前：Enter 只在列表/引用里续写，其余交回默认换行
    keymap.of(markdownKeymap),
    keymap.of([...defaultKeymap, ...historyKeymap, ...closeBracketsKeymap, ...foldKeymap, indentWithTab, ...searchKeymap]),
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
    applyEdits: (edits) => {
      if (edits.length === 0) return 0
      // CodeMirror 要求同一批 changes 互不重叠；按起点排序后丢掉被包住的
      const sorted = [...edits].sort((a, b) => a.from - b.from || b.to - a.to)
      const clean: Array<{ from: number; to: number; insert: string }> = []
      let last = -1
      for (const edit of sorted) {
        if (edit.from < last) continue
        clean.push(edit)
        last = edit.to
      }
      if (clean.length === 0) return 0
      view.dispatch({ changes: clean, userEvent: 'input' })
      return clean.length
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
    setTypewriter: (on) => {
      if (on === typewriterOn) return
      typewriterOn = on
      view.dispatch({
        effects: typewriterComp.reconfigure(on ? [typewriterExtension, typewriterTheme] : []),
        scrollIntoView: false
      })
      if (on) {
        // 打开时立刻把当前行拨到中线，不等下一次移动
        const pos = view.state.selection.main.head
        view.requestMeasure({
          read: (target) => target.coordsAtPos(pos),
          write: (coords, target) => {
            if (!coords) return
            const scroller = target.scrollDOM
            const rect = scroller.getBoundingClientRect()
            scroller.scrollTop += coords.top - (rect.top + rect.height / 2)
          }
        })
      }
    },
    typewriter: () => typewriterOn,
    setFocusMode: (on) => {
      if (on === focusOn) return
      focusOn = on
      view.dispatch({ effects: focusComp.reconfigure(on ? focusPlugin : []) })
    },
    focusMode: () => focusOn,
    setReadOnly: (on) => {
      if (on === readOn) return
      readOn = on
      view.dispatch({
        effects: readComp.reconfigure(
          on ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []
        ),
        scrollIntoView: false
      })
    },
    readOnly: () => readOn,
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
