import type { EditorState } from '@codemirror/state'

export interface StatusInfo {
  /** 中日韩字符逐个计数 + 拉丁单词计数 */
  words: number
  /** 除换行符外的全部字符 */
  chars: number
  lines: number
  line: number
  col: number
  selChars: number
  selLines: number
  cursors: number
}

// 中日韩统一表意(4E00-9FFF)+扩展A(3400-4DBF)+兼容(F900-FAFF)+假名(3040-30FF)+谚文(AC00-D7AF)
const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/g
const LATIN = /[A-Za-z0-9\u00c0-\u024f][A-Za-z0-9_'\-\u00c0-\u024f]*/g

export function countWords(text: string): number {
  const cjk = text.match(CJK)
  const latin = text.match(LATIN)
  return (cjk ? cjk.length : 0) + (latin ? latin.length : 0)
}

export function computeStatus(state: EditorState): StatusInfo {
  const text = state.doc.toString()
  const sel = state.selection.main
  const lineObj = state.doc.lineAt(sel.head)

  const firstLine = state.doc.lineAt(sel.from).number
  const lastLine = state.doc.lineAt(sel.to).number

  return {
    words: countWords(text),
    chars: text.length - state.doc.lines + 1,
    lines: state.doc.lines,
    line: lineObj.number,
    col: sel.head - lineObj.from + 1,
    selChars: sel.to - sel.from,
    selLines: lastLine - firstLine + 1,
    cursors: state.selection.ranges.length
  }
}

export function formatStatus(info: StatusInfo): string {
  const parts = [`字数 ${info.words}`, `字符 ${info.chars}`, `行 ${info.line}, 列 ${info.col}`]
  if (info.selChars > 0) parts.push(`选中 ${info.selChars} 字符 / ${info.selLines} 行`)
  if (info.cursors > 1) parts.push(`${info.cursors} 个光标`)
  return parts.join(' ｜ ')
}
