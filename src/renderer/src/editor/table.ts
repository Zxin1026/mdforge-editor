export type TableAlign = 'left' | 'center' | 'right' | null

export interface TableModel {
  header: string[]
  aligns: TableAlign[]
  rows: string[][]
}

const DELIMITER_CELL = /^:?-{1,}:?$/

/** 按 GFM 规则切单元格：`\|` 是字面竖线，不作为分隔符 */
function splitRow(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1)

  const cells: string[] = []
  let current = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\' && text[i + 1] === '|') {
      current += '|'
      i++
      continue
    }
    if (ch === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  cells.push(current.trim())
  return cells
}

function alignOf(cell: string): TableAlign {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return null
}

function isDelimiterRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => DELIMITER_CELL.test(cell))
}

/**
 * 把 GFM 表格源码解析成网格模型。行数列数不一致时按表头列数对齐：
 * 多出的单元格丢弃，缺失的补空，保证渲染出的网格永远是矩形。
 */
export function parseTable(source: string): TableModel | null {
  const lines = source.split('\n').filter((line) => line.trim() !== '')
  if (lines.length < 2) return null

  const header = splitRow(lines[0])
  const delimiter = splitRow(lines[1])
  if (!isDelimiterRow(delimiter) || delimiter.length !== header.length) return null

  const fit = (cells: string[]): string[] => {
    const row = cells.slice(0, header.length)
    while (row.length < header.length) row.push('')
    return row
  }

  return {
    header: fit(header),
    aligns: delimiter.map(alignOf),
    rows: lines.slice(2).map((line) => fit(splitRow(line)))
  }
}

/** 单元格写回源码前转义字面竖线（解析端 splitRow 会还原） */
export function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|')
}

/** 用一组单元格重建一整行 GFM 表格源码 */
export function buildRowLine(cells: string[]): string {
  return `| ${cells.map(escapeCell).join(' | ')} |`
}

export interface SourceLineSpan {
  from: number
  to: number
  text: string
}

/** 与 parseTable 相同的"去空行"口径，返回每行在源码里的偏移，用于把行号映射成文档区间 */
export function sourceLineSpans(source: string): SourceLineSpan[] {
  const spans: SourceLineSpan[] = []
  let from = 0
  for (const text of source.split('\n')) {
    if (text.trim() !== '') spans.push({ from, to: from + text.length, text })
    from += text.length + 1
  }
  return spans
}
