import type { BlockContext, BlockParser, InlineContext, LeafBlock, LeafBlockParser, Line } from '@lezer/markdown'
import { tags } from '@lezer/highlight'
import type { MarkdownConfig } from '@lezer/markdown'

const DOLLAR = 36
const BACKSLASH = 92
const MATH_BLOCK = '$$'

const isSpace = (ch: number): boolean => ch === 32 || ch === 9 || ch === 10 || ch === 13
const isDigit = (ch: number): boolean => ch >= 48 && ch <= 57

/** 去掉块级标记后的行文本 */
function bodyOf(line: Line): string {
  return line.text.slice(line.pos).trim()
}

const closesBlock = (line: Line): boolean => {
  const body = bodyOf(line)
  return body.length >= MATH_BLOCK.length && body.endsWith(MATH_BLOCK)
}

function firstLineLength(content: string): number {
  const index = content.indexOf('\n')
  return index < 0 ? content.length : index
}

/**
 * `$$` 块挂在段落式块上观察：凑齐闭合的 `$$` 才成为数学块，
 * 否则整块退回普通段落——输入到一半时既不预览，也不会吞掉后文。
 */
class BlockMathParser implements LeafBlockParser {
  nextLine(cx: BlockContext, line: Line, leaf: LeafBlock): boolean {
    if (!closesBlock(line)) return false
    // 与 SetextHeading 同：先吃掉闭合行，块末尾取 prevLineEnd，否则闭合行会被当成新段落
    cx.nextLine()
    emitBlock(cx, leaf, leaf.start, cx.prevLineEnd())
    return true
  }

  finish(cx: BlockContext, leaf: LeafBlock): boolean {
    const length = firstLineLength(leaf.content)
    // 只认首行自成一块（$$x$$）且段落没有后续行的写法
    if (length !== leaf.content.length || length < 4) return false
    if (!leaf.content.startsWith(MATH_BLOCK) || !leaf.content.endsWith(MATH_BLOCK)) return false
    emitBlock(cx, leaf, leaf.start, leaf.start + length)
    return true
  }
}

function emitBlock(cx: BlockContext, leaf: LeafBlock, from: number, to: number): void {
  const marks = [cx.elt('MathMark', from, from + MATH_BLOCK.length), cx.elt('MathMark', to - MATH_BLOCK.length, to)]
  cx.addLeafElement(leaf, cx.elt('BlockMath', from, to, marks))
}

const blockMath: BlockParser = {
  name: 'BlockMath',
  leaf(_cx: BlockContext, leaf: LeafBlock): LeafBlockParser | null {
    return leaf.content.startsWith(MATH_BLOCK) ? new BlockMathParser() : null
  },
  // 允许 $$ 在没有空行的情况下另起一块；已在观察数学块时不再打断自己
  endLeaf(_cx: BlockContext, line: Line, leaf: LeafBlock): boolean {
    if (leaf.parsers.some((parser) => parser instanceof BlockMathParser)) return false
    return bodyOf(line).startsWith(MATH_BLOCK)
  },
  before: 'SetextHeading'
}

/**
 * 行内 `$…$` 与 `$$…$$`：单标记时开标记后不能是空格或 `$`，
 * 闭标记前不能是空格、后不能是数字，这样 `$100 与 $200` 不会被当成数学。
 * 双标记只做配对，不卡空格（`$$ x $$` 是常见写法）。
 */
function inlineMath(cx: InlineContext, next: number, pos: number): number {
  if (next !== DOLLAR) return -1
  const double = cx.char(pos + 1) === DOLLAR
  if (!double && isSpace(cx.char(pos + 1))) return -1

  for (let i = pos + (double ? 2 : 1); i < cx.end; i++) {
    const ch = cx.char(i)
    if (ch === 10 || ch === 13) break
    if (ch === BACKSLASH) {
      i++
      continue
    }
    if (ch !== DOLLAR) continue

    const closes = double ? cx.char(i + 1) === DOLLAR : !isSpace(cx.char(i - 1)) && !isDigit(cx.char(i + 1))
    if (!closes) continue
    // $$$$ 这类紧贴的四个标记不视为空公式
    if (double && i === pos + 2) continue

    const to = i + (double ? 2 : 1)
    const marks = [cx.elt('MathMark', pos, pos + (double ? 2 : 1)), cx.elt('MathMark', i, to)]
    return cx.addElement(cx.elt('Math', pos, to, marks))
  }
  return -1
}

/** lezer 不带数学语法，这里按 remark-math 的常见约束补齐，源文本一个字节都不改 */
export const mathSyntax: MarkdownConfig = {
  defineNodes: [
    { name: 'BlockMath', block: true },
    { name: 'Math' },
    { name: 'MathMark', style: tags.processingInstruction }
  ],
  parseBlock: [blockMath],
  parseInline: [{ name: 'Math', parse: inlineMath, after: 'Emphasis' }]
}
