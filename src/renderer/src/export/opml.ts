/**
 * OPML 导出：按标题层级搭大纲树，段落/列表/代码/表格作为叶子；
 * 长度超一行时把全文放进 _note，方便导入大纲工具后展开细读。
 */

import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  depth?: number
  checked?: boolean | null
  ordered?: boolean
  url?: string
  alt?: string | null
}

interface Outline {
  text: string
  note: string
  children: Outline[]
}

const LEAF_MAX = 120

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r?\n/g, '&#10;')
}

function inlineText(node: MdNode): string {
  if (node.type === 'text') return node.value ?? ''
  if (node.type === 'inlineCode' || node.type === 'code') return node.value ?? ''
  if (node.type === 'image') return (node.alt ?? '').trim()
  if (node.type === 'break') return ' '
  if (node.type === 'html') return ''
  return (node.children ?? []).map(inlineText).join('')
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function summaryOf(text: string): string {
  const one = oneLine(text)
  return one.length > LEAF_MAX ? `${one.slice(0, LEAF_MAX)}…` : one
}

function leaf(text: string, note = ''): Outline {
  return { text, note, children: [] }
}

/** 普通块 → 叶子；长度超限时正文放 _note */
function blockLeaf(node: MdNode): Outline | null {
  if (node.type === 'paragraph') {
    const text = oneLine(inlineText(node))
    if (text === '') return null
    return leftLeaf(text, text)
  }
  if (node.type === 'code') {
    const value = (node.value ?? '').replace(/\n+$/, '')
    const first = value.split('\n')[0] ?? ''
    return leaf(summaryOf(first) === '' ? '（代码块）' : summaryOf(first), value)
  }
  if (node.type === 'blockquote') {
    const text = oneLine((node.children ?? []).map(inlineText).join(' '))
    if (text === '') return null
    return leftLeaf(text, text)
  }
  if (node.type === 'table') {
    const rows = (node.children ?? []).map((row) =>
      (row.children ?? []).map((cell) => oneLine(inlineText(cell))).join(' | ')
    )
    const note = rows.map((row) => row.replace(/\s*\|\s*/g, '\t')).join('\n')
    return leaf(summaryOf(rows[0] ?? '表格'), note)
  }
  if (node.type === 'thematicBreak') return null
  return null
}

function leftLeaf(text: string, full: string): Outline {
  const summary = summaryOf(text)
  return leaf(summary, summary === text ? '' : full)
}

/** 列表：每个条目一个 outline，嵌套列表成子级；任务项带 ☐ / ☑ 前缀 */
function listOutlines(node: MdNode): Outline[] {
  const out: Outline[] = []
  for (const item of node.children ?? []) {
    if (item.type !== 'listItem') continue
    const own: string[] = []
    const children: Outline[] = []
    for (const child of item.children ?? []) {
      if (child.type === 'paragraph') own.push(oneLine(inlineText(child)))
      else if (child.type === 'list') children.push(...listOutlines(child))
      else {
        const extra = blockLeaf(child)
        if (extra !== null) children.push(extra)
      }
    }
    const prefix = item.checked === null || item.checked === undefined ? '' : item.checked ? '☑ ' : '☐ '
    const text = `${prefix}${oneLine(own.join(' '))}`
    out.push({ text: summaryOf(text) === '' ? '（空条目）' : summaryOf(text), note: '', children })
  }
  return out
}

function blockInto(node: MdNode, stack: Outline[], roots: Outline[]): void {
  if (node.type === 'heading') {
    const depth = Math.max(1, node.depth ?? 1)
    while (stack.length >= depth) stack.pop()
    const item = leaf(oneLine(inlineText(node)), '')
    const parent = stack[stack.length - 1]
    if (parent === undefined) roots.push(item)
    else parent.children.push(item)
    stack.push(item)
    return
  }
  if (node.type === 'list') {
    const items = listOutlines(node)
    const parent = stack[stack.length - 1]
    if (parent === undefined) roots.push(...items)
    else parent.children.push(...items)
    return
  }
  const item = blockLeaf(node)
  if (item === null) return
  const parent = stack[stack.length - 1]
  if (parent === undefined) roots.push(item)
  else parent.children.push(item)
}

function outlineXml(outline: Outline): string {
  const note = outline.note === '' ? '' : ` _note="${escapeAttr(outline.note)}"`
  const text = escapeAttr(outline.text === '' ? '（无标题）' : outline.text)
  if (outline.children.length === 0) return `<outline text="${text}"${note}/>`
  const inner = outline.children.map(outlineXml).join('\n')
  return `<outline text="${text}"${note}>\n${inner}\n</outline>`
}

export function buildOpml(markdownText: string, title: string): string {
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml'])
    .parse(markdownText) as unknown as MdNode

  const roots: Outline[] = []
  const stack: Outline[] = []
  for (const node of tree.children ?? []) blockInto(node, stack, roots)

  const body =
    roots.length === 0
      ? '<outline text="（空文档）"/>'
      : roots.map(outlineXml).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
<head>
<title>${escapeAttr(title)}</title>
</head>
<body>
<outline text="${escapeAttr(title === '' ? '未命名' : title)}">
${body}
</outline>
</body>
</opml>
`
}
