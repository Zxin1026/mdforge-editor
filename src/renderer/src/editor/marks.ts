import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import { assetUrl, widthFromTitle } from './assets'
import { frontMatterCollapsedOf, frontMatterOf } from './frontmatter'
import { imageTargetOf } from './image-size'
import { parseTable } from './table'

export type MarkType = 'line' | 'mark' | 'hide' | 'widget'

export type WidgetKind = 'image' | 'task' | 'math-block' | 'math-inline' | 'mermaid' | 'table' | 'front-matter'

export interface MarkRange {
  type: MarkType
  from: number
  to: number
  cls: string
  widget?: WidgetKind
  src?: string
  alt?: string
  width?: number
  checked?: boolean
  block?: boolean
  /** 公式源码 / mermaid 源码 / 表格源码 */
  content?: string
  /** front matter 行数 */
  lines?: number
  collapsed?: boolean
  /** 被预览节点自身的区间：图片调宽、front matter 折叠都要按它写回源文本 */
  nodeFrom?: number
  nodeTo?: number
}

export interface ActiveRange {
  from: number
  to: number
}

const HEADING = /^(?:ATXHeading|SetextHeading)([1-6])$/
const TASK_MARK = /^\[[ xX]\]$/

const CONTENT_CLASS: Record<string, string> = {
  StrongEmphasis: 'mdf-strong',
  Emphasis: 'mdf-em',
  Strikethrough: 'mdf-strike',
  InlineCode: 'mdf-inline-code',
  FencedCode: 'mdf-code-block',
  IndentedCode: 'mdf-code-block',
  Link: 'mdf-link',
  AutoLink: 'mdf-link',
  URL: 'mdf-url',
  HTMLBlock: 'mdf-raw-html',
  HTMLTag: 'mdf-raw-html',
  HorizontalRule: 'mdf-hr',
  TableHeader: 'mdf-table-head',
  TableCell: 'mdf-table-cell'
}

const MUTE_CLASS: Record<string, string> = {
  ListMark: 'mdf-list-mark',
  TaskMarker: 'mdf-task-mark',
  TableDelimiter: 'mdf-pipe',
  CodeMark: 'mdf-fence',
  CodeInfo: 'mdf-code-info',
  MathMark: 'mdf-math-mark'
}

const HIDE_CLASS: Record<string, string> = {
  HeaderMark: 'mdf-marker-hidden',
  EmphasisMark: 'mdf-marker-hidden',
  StrikethroughMark: 'mdf-marker-hidden',
  LinkMark: 'mdf-marker-hidden',
  QuoteMark: 'mdf-marker-hidden'
}

const TYPE_RANK: Record<MarkType, number> = { line: 0, mark: 1, hide: 2, widget: 3 }

interface NodeRange {
  from: number
  to: number
}

/** 逐行回调，用于给跨行块加行级装饰 */
function eachLine(state: EditorState, range: NodeRange, add: (line: { from: number; to: number }) => void): void {
  for (let pos = range.from; pos <= range.to; pos = state.doc.lineAt(pos).to + 1) {
    const line = state.doc.lineAt(pos)
    add({ from: line.from, to: line.to })
    if (line.to >= range.to) break
  }
}

/** 收集节点里指定类型的子节点位置 */
function childRanges(state: EditorState, range: NodeRange, name: string): NodeRange[] {
  const found: NodeRange[] = []
  syntaxTree(state).iterate({
    from: range.from,
    to: range.to,
    enter(node) {
      if (node.type.name === name) found.push({ from: node.from, to: node.to })
      return undefined
    }
  })
  return found
}

/** 围栏代码块的信息串（```lang 里的 lang），没有则空字符串 */
function codeInfo(state: EditorState, range: NodeRange): string {
  const info = childRanges(state, range, 'CodeInfo')
  return info.length === 0 ? '' : state.sliceDoc(info[0].from, info[0].to).trim().toLowerCase()
}

/**
 * 围栏代码正文：去掉首行 ```lang 与末行 ```。
 * 收尾围栏缺失时（lastBreak 与 firstBreak 重合）返回空串，交由调用方跳过预览。
 */
function fencedBody(state: EditorState, range: NodeRange): string {
  const raw = state.sliceDoc(range.from, range.to)
  const first = raw.indexOf('\n')
  const last = raw.lastIndexOf('\n')
  if (first < 0 || last <= first) return ''
  return raw.slice(first + 1, last)
}

/** 数学节点正文：取首尾 MathMark 之间；引用块里的 `>` 标记不算公式内容 */
function mathBody(state: EditorState, range: NodeRange, quoted: boolean): string | null {
  const marks = childRanges(state, range, 'MathMark')
  if (marks.length < 2) return null
  const first = marks[0]
  const last = marks[marks.length - 1]
  const text = state
    .sliceDoc(first.to, last.from)
    .split('\n')
    .map((line) => line.replace(quoted ? /^\s*>?\s?/ : /^\s+/, ''))
    .join('\n')
    .trim()
  return text === '' ? null : text
}

function altOf(state: EditorState, range: NodeRange): string {
  const start = range.from + 2
  const scan = state.doc.sliceString(start, Math.min(start + 512, state.doc.length))
  const end = scan.indexOf(']')
  return end < 0 ? '' : scan.slice(0, end)
}

/**
 * 标记符与块级预览只在光标不落在其所在行时生效。
 * 按父节点判定会让光标移到行尾时标记符突然消失，也拿不到跨节点的选区。
 */
export function collectMarks(state: EditorState, active: readonly ActiveRange[], docPath = ''): MarkRange[] {
  const out: MarkRange[] = []
  const tree = syntaxTree(state)
  const doc = state.doc

  const overlaps = (from: number, to: number): boolean => active.some((range) => range.to >= from && range.from <= to)

  if (tree.length > 0) {
    tree.iterate({
      enter(node) {
        const name = node.type.name
        const heading = HEADING.exec(name)
        const content = CONTENT_CLASS[name]
        const mute = MUTE_CLASS[name]
        const hide = HIDE_CLASS[name]
        const range = { from: node.from, to: node.to }

        if (heading) {
          const line = doc.lineAt(node.from)
          out.push({ type: 'line', from: line.from, to: line.to, cls: `mdf-heading mdf-heading-${heading[1]}` })
        } else if (name === 'Blockquote') {
          eachLine(state, range, (line) => out.push({ type: 'line', ...line, cls: 'mdf-quote-line' }))
        } else if (name === 'Image') {
          pushImage(state, range, docPath, active, out)
        } else if (name === 'Task') {
          pushTask(state, range, overlaps, out)
        } else if (name === 'BlockMath') {
          pushMathBlock(state, range, overlaps, out)
        } else if (name === 'Math') {
          pushMathInline(state, range, overlaps, out)
        } else if (name === 'FencedCode' && codeInfo(state, range) === 'mermaid') {
          pushMermaid(state, range, overlaps, out)
        } else if (name === 'FencedCode' || name === 'IndentedCode') {
          // 行级类：mdmdt 皮肤靠它给整块代码铺底、做圆角（默认皮肤无样式，不影响现观感）
          eachLine(state, range, (line) => out.push({ type: 'line', ...line, cls: 'mdf-code-line' }))
        } else if (name === 'Table') {
          pushTable(state, range, overlaps, out)
        } else if (content) {
          out.push({ type: 'mark', from: node.from, to: node.to, cls: content })
        } else if (mute) {
          out.push({ type: 'mark', from: node.from, to: node.to, cls: mute })
        } else if (hide) {
          const line = doc.lineAt(node.from)
          if (!overlaps(line.from, line.to)) {
            out.push({ type: 'hide', from: node.from, to: node.to, cls: hide })
          }
        }
      }
    })
  }

  return sortAndDedupe(withFrontMatter(state, out, overlaps))
}

function pushImage(
  state: EditorState,
  range: NodeRange,
  docPath: string,
  active: readonly ActiveRange[],
  out: MarkRange[]
): void {
  const line = state.doc.lineAt(range.from)
  const target = line.to === line.from ? null : imageTargetOf(state, range.from, range.to)
  const url = target ? assetUrl(docPath, target.url) : null
  // 只有光标真正落进链接区间（要改链接文字）时才显示源码让位；
  // 光标停在链接末尾/同行其他位置（例如刚粘贴完）预览照常渲染
  const editing = active.some((picked) => picked.from < range.to && picked.to > range.from)
  if (!url || editing) return

  // 块级 widget 必须落在行首，也就是下一行的起点
  const at = Math.min(line.to + 1, state.doc.length)
  out.push({
    type: 'widget',
    from: at,
    to: at,
    cls: 'mdf-image-preview',
    widget: 'image',
    src: url,
    alt: altOf(state, range),
    width: widthFromTitle(target?.title ?? null) ?? undefined,
    block: true,
    nodeFrom: range.from,
    nodeTo: range.to
  })
}

function pushTask(
  state: EditorState,
  range: NodeRange,
  overlaps: (from: number, to: number) => boolean,
  out: MarkRange[]
): void {
  const marker = state.sliceDoc(range.from, range.from + 3)
  const line = state.doc.lineAt(range.from)
  if (!TASK_MARK.test(marker) || overlaps(line.from, line.to)) return
  out.push({
    type: 'widget',
    from: range.from,
    to: range.from + 3,
    cls: 'mdf-task-box',
    widget: 'task',
    checked: marker[1] !== ' '
  })
}

function pushMathBlock(
  state: EditorState,
  range: NodeRange,
  overlaps: (from: number, to: number) => boolean,
  out: MarkRange[]
): void {
  eachLine(state, range, (line) => out.push({ type: 'line', ...line, cls: 'mdf-math-line' }))
  if (overlaps(range.from, range.to)) return

  const text = mathBody(state, range, childRanges(state, range, 'QuoteMark').length > 0)
  if (!text) return
  const at = Math.min(range.to + 1, state.doc.length)
  out.push({
    type: 'widget',
    from: at,
    to: at,
    cls: 'mdf-math-block',
    widget: 'math-block',
    content: text,
    block: true
  })
}

function pushMathInline(
  state: EditorState,
  range: NodeRange,
  overlaps: (from: number, to: number) => boolean,
  out: MarkRange[]
): void {
  const line = state.doc.lineAt(range.from)
  if (overlaps(line.from, line.to)) return
  const text = mathBody(state, range, false)
  if (!text) return
  out.push({
    type: 'widget',
    from: range.from,
    to: range.to,
    cls: 'mdf-math-inline',
    widget: 'math-inline',
    content: text
  })
}

function pushMermaid(
  state: EditorState,
  range: NodeRange,
  overlaps: (from: number, to: number) => boolean,
  out: MarkRange[]
): void {
  if (overlaps(range.from, range.to)) return
  const body = fencedBody(state, range)
  if (body.trim() === '') return
  const at = Math.min(range.to + 1, state.doc.length)
  out.push({ type: 'widget', from: at, to: at, cls: 'mdf-mermaid', widget: 'mermaid', content: body, block: true })
}

function pushTable(
  state: EditorState,
  range: NodeRange,
  overlaps: (from: number, to: number) => boolean,
  out: MarkRange[]
): void {
  if (overlaps(range.from, range.to)) return
  const body = state.sliceDoc(range.from, range.to)
  if (!parseTable(body)) return
  // replace 装饰整体顶掉源码：平时只看到网格；改内容点单元格就地编辑（blocks.ts / table-edit.ts）
  out.push({
    type: 'widget',
    from: range.from,
    to: range.to,
    cls: 'mdf-table-grid',
    widget: 'table',
    content: body,
    nodeFrom: range.from,
    nodeTo: range.to
  })
}

/**
 * front matter 覆盖的行由本模块统一处理：先丢掉段落解析产生的装饰（否则 YAML 里的
 * `*`、`---` 会被当成强调与分隔线），再补上弱化行与折叠开关。
 */
function withFrontMatter(
  state: EditorState,
  ranges: MarkRange[],
  overlaps: (from: number, to: number) => boolean
): MarkRange[] {
  const span = frontMatterOf(state.doc)
  if (!span) return ranges

  const kept = ranges.filter((range) => !(range.from >= span.from && range.to <= span.to))
  const collapsed = frontMatterCollapsedOf(state) && !overlaps(span.from, span.to)

  if (collapsed) {
    kept.push({
      type: 'widget',
      from: span.from,
      to: span.to,
      cls: 'mdf-fm-collapsed',
      widget: 'front-matter',
      lines: span.lines.length,
      collapsed: true,
      nodeFrom: span.from,
      nodeTo: span.to
    })
    return kept
  }

  for (const from of span.lines) {
    const line = state.doc.lineAt(from)
    kept.push({ type: 'line', from: line.from, to: line.to, cls: 'mdf-frontmatter' })
  }
  kept.push({
    type: 'widget',
    from: span.to,
    to: span.to,
    cls: 'mdf-fm-toggle',
    widget: 'front-matter',
    lines: span.lines.length,
    collapsed: false,
    nodeFrom: span.from,
    nodeTo: span.to
  })
  return kept
}

function sortAndDedupe(ranges: MarkRange[]): MarkRange[] {
  const sorted = [...ranges].sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from
    if (a.to !== b.to) return b.to - a.to
    return TYPE_RANK[a.type] - TYPE_RANK[b.type]
  })

  const result: MarkRange[] = []
  for (const range of sorted) {
    const last = result[result.length - 1]
    if (
      last &&
      last.type === range.type &&
      last.from === range.from &&
      last.to === range.to &&
      last.cls === range.cls
    ) {
      continue
    }
    result.push(range)
  }
  return result
}
