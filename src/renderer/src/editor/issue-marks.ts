import { StateEffect, StateField, type EditorState, type Range } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { ISSUE_SEVERITY, type Issue } from './inspect'

export interface IssueMark {
  from: number
  /** 命中片段结束位置；缺省只标行 */
  end?: number
  severity: 'error' | 'warning'
}

export const setIssueMarks = StateEffect.define<readonly IssueMark[]>()

const LINE_ERROR = Decoration.line({ class: 'mdf-issue-line is-error' })
const LINE_WARNING = Decoration.line({ class: 'mdf-issue-line is-warning' })
const MARK_ERROR = Decoration.mark({ class: 'mdf-issue-mark is-error' })
const MARK_WARNING = Decoration.mark({ class: 'mdf-issue-mark is-warning' })

function build(state: EditorState, marks: readonly IssueMark[]): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const linesDone = new Set<number>()

  // 先错后警：同一行两种问题叠在一起时优先显示错
  const ordered = [...marks].sort(
    (a, b) => a.from - b.from || (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1)
  )

  for (const mark of ordered) {
    const from = Math.max(0, Math.min(mark.from, state.doc.length))
    const line = state.doc.lineAt(from)
    if (!linesDone.has(line.from)) {
      linesDone.add(line.from)
      ranges.push((mark.severity === 'error' ? LINE_ERROR : LINE_WARNING).range(line.from))
    }
    if (mark.end !== undefined && mark.end > from) {
      const to = Math.min(mark.end, state.doc.length)
      ranges.push((mark.severity === 'error' ? MARK_ERROR : MARK_WARNING).range(from, to))
    }
  }
  return Decoration.set(ranges, true)
}

/**
 * 检查结果的内联标记：行底色条 + 命中片段波浪线。
 * 文档改动时先按变更映射位置（打字的瞬间标记不跳），下次检查再整体替换。
 */
export const issueMarkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (effect.is(setIssueMarks)) next = build(transaction.state, effect.value)
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field)
})

/** 检查结果转内联标记：只有片段位置的条目才画下划线 */
export function marksFromIssues(issues: readonly Issue[]): IssueMark[] {
  const marks: IssueMark[] = []
  for (const issue of issues) {
    if (issue.line <= 0) continue
    marks.push({ from: issue.pos, end: issue.end, severity: ISSUE_SEVERITY[issue.kind] })
  }
  return marks
}
