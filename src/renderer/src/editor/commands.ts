import { syntaxTree } from '@codemirror/language'
import type { EditorState, Line, TransactionSpec } from '@codemirror/state'
import type { EditorView, KeyBinding } from '@codemirror/view'
import { compositionField } from './decorations'

type Command = (view: EditorView) => boolean

export type ListKind = 'bullet' | 'ordered' | 'task'
type HeadingLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6

const CODE_NODES = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock'])

export interface ParsedMarkers {
  indent: string
  quote: string
  listKind: '' | 'bullet' | 'ordered'
  bulletChar: string
  delim: string
  number: number
  task: boolean
  listRaw: string
  content: string
  markerLen: number
}

/**
 * 把一行拆成 缩进 / 引用标记 / 列表标记 / 正文。
 * 引用可嵌套（>>），列表标记支持 - + * 与 1. 1)，任务列表在两者后再带 [ ]。
 */
export function parseMarkers(text: string): ParsedMarkers {
  const indent = /^[ \t]*/.exec(text)![0]
  let rest = text.slice(indent.length)

  let quote = ''
  let m: RegExpExecArray | null
  while ((m = /^>\s?/.exec(rest)) !== null) {
    quote += m[0]
    rest = rest.slice(m[0].length)
  }

  let listKind: '' | 'bullet' | 'ordered' = ''
  let bulletChar = ''
  let delim = ''
  let number = 0
  let task = false
  let listRaw = ''

  if ((m = /^([-+*])[ \t]+(\[[ xX]\][ \t]+)?/.exec(rest)) !== null) {
    listKind = 'bullet'
    bulletChar = m[1]
    task = m[2] !== undefined
    listRaw = m[0]
    rest = rest.slice(m[0].length)
  } else if ((m = /^(\d{1,9})([.)])[ \t]+(\[[ xX]\][ \t]+)?/.exec(rest)) !== null) {
    listKind = 'ordered'
    number = parseInt(m[1], 10)
    delim = m[2]
    task = m[3] !== undefined
    listRaw = m[0]
    rest = rest.slice(m[0].length)
  }

  return {
    indent,
    quote,
    listKind,
    bulletChar,
    delim,
    number,
    task,
    listRaw,
    content: rest,
    markerLen: indent.length + quote.length + listRaw.length
  }
}

function listMarkerFor(kind: ListKind, index: number, parsed: ParsedMarkers): string {
  if (kind === 'ordered') return `${index + 1}${parsed.delim || '.'} `
  const bullet = parsed.listKind === 'bullet' ? parsed.bulletChar : '-'
  return kind === 'task' ? `${bullet} [ ] ` : `${bullet} `
}

function linesTouched(state: EditorState): Line[] {
  const seen = new Set<number>()
  const out: Line[] = []
  for (const range of state.selection.ranges) {
    let line = state.doc.lineAt(range.from)
    const end = state.doc.lineAt(range.to)
    for (;;) {
      if (!seen.has(line.number)) {
        seen.add(line.number)
        out.push(line)
      }
      if (line.number >= end.number) break
      line = state.doc.line(line.number + 1)
    }
  }
  return out
}

function insideCode(state: EditorState, pos: number): boolean {
  let node = syntaxTree(state).resolveInner(Math.min(pos, state.doc.length), -1)
  while (node) {
    if (CODE_NODES.has(node.type.name)) return true
    node = node.parent!
  }
  return false
}

/** 强调类标记：已有则去掉，没有则包裹。空选区时插入标记并把光标留在中间。 */
export function toggleWrapPlan(state: EditorState, before: string, after: string): TransactionSpec | null {
  const sel = state.selection.main
  const { from, to } = sel
  const doc = state.doc

  const pre = doc.sliceString(from - before.length, from)
  const post = doc.sliceString(to, to + after.length)
  if (pre === before && post === after) {
    return {
      changes: [
        { from: from - before.length, to: from },
        { from: to, to: to + after.length }
      ],
      selection: { anchor: from - before.length, head: to - before.length }
    }
  }

  const text = doc.sliceString(from, to)
  if (text.length >= before.length + after.length && text.startsWith(before) && text.endsWith(after)) {
    const inner = text.slice(before.length, text.length - after.length)
    return { changes: { from, to, insert: inner }, selection: { anchor: from, head: from + inner.length } }
  }

  const insert = before + text + after
  const innerStart = from + before.length
  return { changes: { from, to, insert }, selection: { anchor: innerStart, head: innerStart + text.length } }
}

/** 设置标题级别；0 为正文。当前级别与目标一致时降级为正文。 */
export function headingPlan(state: EditorState, level: HeadingLevel): TransactionSpec {
  const changes = linesTouched(state).map((line) => {
    const bare = line.text.replace(/^[ \t]*/, '').replace(/^#{1,6}[ \t]+/, '')
    const hashes = /^[ \t]*(#{1,6})[ \t]/.exec(line.text)
    const wasLevel = hashes ? hashes[1].length : 0
    const target: HeadingLevel = level !== 0 && wasLevel === level ? 0 : level
    const insert = target === 0 ? bare : `${'#'.repeat(target)} ${bare}`
    return { from: line.from, to: line.to, insert }
  })
  return { changes }
}

/** 在无序/有序/任务列表之间切换，或取消列表。 */
export function listPlan(state: EditorState, kind: ListKind): TransactionSpec {
  const lines = linesTouched(state)
  const parsed = lines.map((line) => parseMarkers(line.text))

  const matches = (p: ParsedMarkers): boolean => {
    if (kind === 'bullet') return p.listKind === 'bullet' && !p.task
    if (kind === 'ordered') return p.listKind === 'ordered' && !p.task
    return p.task
  }
  const allOn = parsed.every(matches)

  const changes = lines.map((line, i) => {
    const p = parsed[i]
    const insert = allOn
      ? `${p.indent}${p.quote}${p.content}`
      : `${p.indent}${p.quote}${listMarkerFor(kind, i, p)}${p.content}`
    return { from: line.from, to: line.to, insert }
  })
  return { changes }
}

/** 引用块切换，保留原有缩进与列表标记。 */
export function quotePlan(state: EditorState): TransactionSpec {
  const lines = linesTouched(state)
  const parsed = lines.map((line) => parseMarkers(line.text))
  const allOn = parsed.every((p) => p.quote !== '')

  const changes = lines.map((line, i) => {
    const p = parsed[i]
    const insert = allOn ? `${p.indent}${p.listRaw}${p.content}` : `${p.indent}> ${p.listRaw}${p.content}`
    return { from: line.from, to: line.to, insert }
  })
  return { changes }
}

const TABLE_HEADER = '| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n'
const TABLE_ROW = '|  |  |  |\n'

/** 插入一个 3 列起步的表格骨架，光标落在首个数据单元格。 */
export function tablePlan(state: EditorState): TransactionSpec {
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  const empty = line.text.trim() === ''

  const at = empty ? line.from : line.to
  const lead = empty ? '' : '\n\n'
  const block = `${TABLE_HEADER}${TABLE_ROW}`
  const insert = `${lead}${block}`
  const cellStart = at + lead.length + TABLE_HEADER.length + 2

  if (empty) {
    return {
      changes: { from: line.from, to: line.to, insert: block },
      selection: { anchor: line.from + TABLE_HEADER.length + 2 }
    }
  }
  return { changes: { from: at, insert }, selection: { anchor: cellStart } }
}

/**
 * 回车续写列表/引用：空条目回车退出列表，非空条目按同样前缀（有序自动 +1，任务重置为未勾选）另起一行。
 * 返回 null 表示交回默认换行行为。
 */
export function enterPlan(state: EditorState): TransactionSpec | null {
  const { head, anchor } = state.selection.main
  if (head !== anchor) return null
  const line = state.doc.lineAt(head)
  if (insideCode(state, head)) return null

  const p = parseMarkers(line.text)
  const hasMarker = p.listKind !== '' || p.quote !== ''
  if (!hasMarker) return null

  if (p.content.trim() === '') {
    if (head - line.from < p.markerLen) return null
    return { changes: { from: line.from, to: line.from + p.markerLen }, selection: { anchor: line.from } }
  }

  const cursorInLine = head - line.from
  if (cursorInLine <= p.markerLen) return null

  let prefix = `${p.indent}${p.quote}`
  if (p.listKind === 'ordered') prefix += `${p.number + 1}${p.delim} `
  else if (p.listKind === 'bullet') prefix += `${p.bulletChar} `
  if (p.task) prefix += '[ ] '

  return { changes: { from: head, insert: `\n${prefix}` }, selection: { anchor: head + 1 + prefix.length } }
}

function run(view: EditorView, plan: TransactionSpec | null): boolean {
  if (!plan) return false
  view.dispatch({ ...plan, userEvent: 'input' })
  return true
}

export const boldCmd: Command = (view) => run(view, toggleWrapPlan(view.state, '**', '**'))
export const italicCmd: Command = (view) => run(view, toggleWrapPlan(view.state, '*', '*'))
export const strikeCmd: Command = (view) => run(view, toggleWrapPlan(view.state, '~~', '~~'))
export const inlineCodeCmd: Command = (view) => run(view, toggleWrapPlan(view.state, '`', '`'))

export function headingCmd(level: HeadingLevel): Command {
  return (view) => run(view, headingPlan(view.state, level))
}

export function listCmd(kind: ListKind): Command {
  return (view) => run(view, listPlan(view.state, kind))
}

export const quoteCmd: Command = (view) => run(view, quotePlan(view.state))
export const tableCmd: Command = (view) => run(view, tablePlan(view.state))

/** IME 合成期间的回车用于确认候选词，不能触发列表续写。 */
const enterCmd: Command = (view) => {
  if (view.state.field(compositionField).composing) return false
  return run(view, enterPlan(view.state))
}

export const markdownKeymap: KeyBinding[] = [
  { key: 'Mod-b', run: boldCmd, preventDefault: true },
  { key: 'Mod-i', run: italicCmd, preventDefault: true },
  { key: 'Mod-Shift-x', run: strikeCmd, preventDefault: true },
  { key: 'Mod-`', run: inlineCodeCmd, preventDefault: true },
  { key: 'Mod-1', run: headingCmd(1), preventDefault: true },
  { key: 'Mod-2', run: headingCmd(2), preventDefault: true },
  { key: 'Mod-3', run: headingCmd(3), preventDefault: true },
  { key: 'Mod-4', run: headingCmd(4), preventDefault: true },
  { key: 'Mod-5', run: headingCmd(5), preventDefault: true },
  { key: 'Mod-6', run: headingCmd(6), preventDefault: true },
  { key: 'Mod-0', run: headingCmd(0), preventDefault: true },
  { key: 'Mod-Shift-l', run: listCmd('bullet'), preventDefault: true },
  { key: 'Mod-Shift-o', run: listCmd('ordered'), preventDefault: true },
  { key: 'Mod-Shift-t', run: listCmd('task'), preventDefault: true },
  { key: 'Mod-Shift-q', run: quoteCmd, preventDefault: true },
  { key: 'Mod-Alt-t', run: tableCmd, preventDefault: true },
  { key: 'Enter', run: enterCmd }
]
