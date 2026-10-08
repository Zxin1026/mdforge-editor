import { syntaxTree } from '@codemirror/language'
import { Prec, type EditorState, type Line, type TransactionSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
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

// ---- 语法转换：代码块 / 任务勾选 / 标题级别 ----

const FENCE = '```'

/** 选区（多光标取最小外框）或光标所在段落（以空行为界，与 view.ts 同口径） */
function scriptRange(state: EditorState): { from: number; to: number } {
  if (!state.selection.main.empty) {
    let from = Number.POSITIVE_INFINITY
    let to = 0
    for (const range of state.selection.ranges) {
      from = Math.min(from, state.doc.lineAt(range.from).from)
      to = Math.max(to, state.doc.lineAt(range.to).to)
    }
    return { from, to }
  }
  const line = state.doc.lineAt(state.selection.main.head)
  let first = line.number
  while (first > 1 && state.doc.line(first - 1).text.trim() !== '') first -= 1
  let last = line.number
  while (last < state.doc.lines && state.doc.line(last + 1).text.trim() !== '') last += 1
  return { from: state.doc.line(first).from, to: state.doc.line(last).to }
}

/** 光标所在围栏代码块：不在里面返回 null */
function fenceAt(state: EditorState, pos: number): { from: number; to: number } | null {
  let node = syntaxTree(state).resolveInner(Math.min(pos, state.doc.length), -1)
  while (node && node.name !== 'FencedCode') node = node.parent!
  return node ? { from: node.from, to: node.to } : null
}

/** 切换代码块：光标在围栏里就拆掉围栏，否则把选区/当前段落包进围栏。 */
export function codeBlockPlan(state: EditorState): TransactionSpec | null {
  const fence = fenceAt(state, state.selection.main.head)
  if (fence) {
    const first = state.doc.lineAt(fence.from)
    const last = state.doc.lineAt(fence.to)
    return {
      changes: [
        { from: first.from, to: Math.min(first.to + 1, state.doc.length) },
        { from: Math.max(0, last.from - 1), to: last.to }
      ],
      selection: { anchor: first.from }
    }
  }
  const range = scriptRange(state)
  const open = `${FENCE}\n`
  return {
    changes: [
      { from: range.from, insert: open },
      { from: range.to, insert: `\n${FENCE}` }
    ],
    selection: { anchor: range.from + open.length }
  }
}

/** 任务勾选切换：任务行翻转 [ ] / [x]；普通列表行升级为任务；行首裸写 []/[x] 规范成任务项。 */
export function taskTogglePlan(state: EditorState): TransactionSpec | null {
  const lines = linesTouched(state).filter((line) => !insideCode(state, Math.min(line.from + 1, state.doc.length)))
  if (lines.length === 0) return null
  const changes = lines.map((line) => {
    const p = parseMarkers(line.text)
    if (p.task) {
      const flipped = p.listRaw.replace(/\[([ xX])\]/, (_all, mark: string) => (mark === ' ' ? '[x]' : '[ ]'))
      return { from: line.from, to: line.to, insert: `${p.indent}${p.quote}${flipped}${p.content}` }
    }
    if (p.listKind !== '') {
      return { from: line.from, to: line.to, insert: `${p.indent}${p.quote}${p.listRaw}[ ] ${p.content}` }
    }
    const bare = /^([ \t]*(?:>[ \t]?)*)(\[[ xX]?\])([ \t]*)(.*)$/.exec(line.text)
    if (bare) {
      return { from: line.from, to: line.to, insert: `${bare[1]}- [${/x/i.test(bare[2]) ? 'x' : ' '}] ${bare[4]}` }
    }
    return { from: line.from, to: line.to, insert: `${p.indent}${p.quote}- [ ] ${p.content}` }
  })
  return { changes }
}

/** 标题级别加减（delta=1 降一级、-1 升一级），只动标题行，级别夹在 1–6。 */
export function headingLevelPlan(state: EditorState, delta: 1 | -1): TransactionSpec | null {
  let touched = false
  const changes = linesTouched(state).map((line) => {
    const parsed = /^([ \t]*)(#{1,6})([ \t]+)(.*)$/.exec(line.text)
    if (!parsed) return { from: line.from, to: line.to, insert: line.text }
    const level = Math.min(6, Math.max(1, parsed[2].length + delta))
    if (level === parsed[2].length) return { from: line.from, to: line.to, insert: line.text }
    touched = true
    return { from: line.from, to: line.to, insert: `${parsed[1]}${'#'.repeat(level)}${parsed[3]}${parsed[4]}` }
  })
  return touched ? { changes } : null
}

/**
 * Typora 式的输入即转：行首敲出 [] / [x] / 中文序号（1、或 1））后按空格，
 * 就地变成任务列表或有序列表的标记，键盘流不用回头补语法。
 */
export const smartListInput = Prec.high(
  EditorView.inputHandler.of((view, from, to, insert) => {
    if (from !== to || view.composing || view.state.readOnly) return false
    if (insert !== ' ' && insert !== '　') return false
    const state = view.state
    const line = state.doc.lineAt(from)
    const before = state.sliceDoc(line.from, from)
    const task = /^([ \t]*)\[([ xX]?)\]$/.exec(before)
    let next: string | null = task ? `${task[1]}- [${/x/i.test(task[2]) ? 'x' : ' '}] ` : null
    if (next === null) {
      const ordered = /^([ \t]*)(\d{1,9})[、）]$/.exec(before)
      if (ordered) next = `${ordered[1]}${ordered[2]}. `
    }
    if (next === null || insideCode(state, from)) return false
    view.dispatch({
      changes: { from: line.from, to: from, insert: next },
      selection: { anchor: line.from + next.length },
      userEvent: 'input.type'
    })
    return true
  })
)

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
export const codeBlockCmd: Command = (view) => run(view, codeBlockPlan(view.state))
export const taskToggleCmd: Command = (view) => run(view, taskTogglePlan(view.state))

export function headingLevelCmd(delta: 1 | -1): Command {
  return (view) => run(view, headingLevelPlan(view.state, delta))
}

/** IME 合成期间的回车用于确认候选词，不能触发列表续写。 */
export const enterCmd: Command = (view) => {
  if (view.state.field(compositionField).composing) return false
  return run(view, enterPlan(view.state))
}
