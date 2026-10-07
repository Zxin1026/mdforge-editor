import { StateEffect, StateField, type EditorState, type Text } from '@codemirror/state'

export interface FrontMatterSpan {
  from: number
  to: number
  /** 每个 front matter 行的行首位置，用于逐行弱化 */
  lines: number[]
}

const OPEN = /^---[ \t]*$/
const CLOSE = /^(?:---|\.\.\.)[ \t]*$/
const MAX_LINES = 200

/**
 * 只有文档第一行就是 `---`、且后面能找到配对的 `---` / `...` 才算 front matter。
 * 配不上就完全不介入，避免 `---` 分隔线把整篇正文吃掉。
 */
export function frontMatterOf(doc: Text): FrontMatterSpan | null {
  if (doc.lines < 2) return null
  const first = doc.line(1)
  if (!OPEN.test(first.text)) return null

  const lines = [first.from]
  const limit = Math.min(doc.lines, MAX_LINES)
  for (let number = 2; number <= limit; number++) {
    const line = doc.line(number)
    lines.push(line.from)
    if (CLOSE.test(line.text)) return { from: first.from, to: line.to, lines }
  }
  return null
}

export const setFrontMatterCollapsed = StateEffect.define<boolean>()

/** 折叠状态是文档级 UI 状态，放在 StateField 里装饰集才能感知到变化 */
export const frontMatterCollapsed = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setFrontMatterCollapsed)) return effect.value
    }
    return value
  }
})

export function frontMatterCollapsedOf(state: EditorState): boolean {
  // 单元测试里的临时 state 不带该字段，缺省按展开处理
  return state.field(frontMatterCollapsed, false) ?? false
}
