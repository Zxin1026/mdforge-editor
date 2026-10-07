/**
 * 表格网格里的单元格行内渲染：去掉 `**`、`` ` ``、`[…](…)` 这些标记，只留下样式本身，
 * 让网格和正文的所见即所得观感一致。点单元格编辑时仍然编辑原始源码（table-edit.ts 按源码重写）。
 */
import { GFM, parser } from '@lezer/markdown'

export interface CellInlinePart {
  text: string
  strong?: true
  em?: true
  strike?: true
  code?: true
  link?: true
}

/** 标记与结构性节点：不产出文本，只负责定位 */
const SKIP = new Set([
  'LinkMark',
  'EmphasisMark',
  'StrikethroughMark',
  'CodeMark',
  'CodeInfo',
  'HeaderMark',
  'QuoteMark',
  'ListMark',
  'TaskMarker',
  'TableDelimiter',
  'MathMark'
])

interface CellNode {
  readonly name: string
  readonly from: number
  readonly to: number
  readonly firstChild: CellNode | null
  readonly nextSibling: CellNode | null
}

const cellParser = parser.configure([GFM])

type Style = Omit<CellInlinePart, 'text'>

function push(out: CellInlinePart[], text: string, style: Style): void {
  if (text === '') return
  const last = out[out.length - 1]
  if (last && sameStyle(last, style)) {
    last.text += text
    return
  }
  out.push({ text, ...style })
}

function sameStyle(part: CellInlinePart, style: Style): boolean {
  return (
    part.strong === style.strong &&
    part.em === style.em &&
    part.strike === style.strike &&
    part.code === style.code &&
    part.link === style.link
  )
}

function visitChildren(parent: CellNode, text: string, style: Style, inLink: boolean, out: CellInlinePart[]): void {
  // lezer 的树里纯文本不是节点，而是子节点之间的"空隙"——逐段补出来
  let cursor = parent.from
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (child.from > cursor) push(out, text.slice(cursor, child.from), style)
    visit(child, text, style, inLink, out)
    cursor = child.to
  }
  if (parent.to > cursor) push(out, text.slice(cursor, parent.to), style)
}

function visit(node: CellNode, text: string, style: Style, inLink: boolean, out: CellInlinePart[]): void {
  const name = node.name
  if (SKIP.has(name)) return

  // 链接目标不显示（和正文里"链接只展示文字"的观感一致）；自动链接/裸 URL 本身就是可见文字
  if (name === 'URL') {
    if (inLink) return
    push(out, text.slice(node.from, node.to), style)
    return
  }

  if (name === 'Link') {
    visitChildren(node, text, { ...style, link: true }, true, out)
    return
  }

  if (name === 'Image') {
    // 网格里不放大图，退化成 alt 文字
    visitChildren(node, text, style, true, out)
    return
  }

  if (name === 'StrongEmphasis') {
    visitChildren(node, text, { ...style, strong: true }, inLink, out)
    return
  }
  if (name === 'Emphasis') {
    visitChildren(node, text, { ...style, em: true }, inLink, out)
    return
  }
  if (name === 'Strikethrough') {
    visitChildren(node, text, { ...style, strike: true }, inLink, out)
    return
  }
  if (name === 'InlineCode') {
    visitChildren(node, text, { ...style, code: true }, inLink, out)
    return
  }

  visitChildren(node, text, style, inLink, out)
}

/** 把单元格源码解析成"文本 + 样式"序列；坏输入只会退化成纯文本，不抛错 */
export function parseCellInline(text: string): CellInlinePart[] {
  if (text === '') return []
  const out: CellInlinePart[] = []
  const tree = cellParser.parse(text)
  visitChildren(tree.topNode as unknown as CellNode, text, {}, false, out)
  return out
}

const STYLE_CLASS: [keyof Style, string][] = [
  ['strong', 'mdf-strong'],
  ['em', 'mdf-em'],
  ['strike', 'mdf-strike'],
  ['code', 'mdf-inline-code'],
  ['link', 'mdf-link']
]

/** 用 DOM 节点装出来（全程 textContent，天然免疫 HTML 注入） */
export function renderCellInline(parent: HTMLElement, text: string): void {
  for (const part of parseCellInline(text)) {
    const classes = STYLE_CLASS.filter(([key]) => part[key]).map(([, cls]) => cls)
    if (classes.length === 0) {
      parent.appendChild(document.createTextNode(part.text))
      continue
    }
    const span = document.createElement('span')
    span.className = classes.join(' ')
    span.textContent = part.text
    parent.appendChild(span)
  }
}
