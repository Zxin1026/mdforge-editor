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

/**
 * 以下的增删都返回重建后的整段表格源码；越界或解析失败返回 null。
 * 编辑口径与 table-edit 一致：按 parseTable / sourceLineSpans 的"去空行"行号操作，
 * 只动受影响的行，未走的行原文保留。
 */

/** 在指定行下方插入一行空单元格；row = -1 表示表头（插进表头下方、分隔行之后） */
export function insertRow(source: string, row: number): string | null {
  const model = parseTable(source)
  if (!model || row < -1 || row >= model.rows.length) return null
  const spans = sourceLineSpans(source)
  // 表头行下方是分隔行，新行要落在分隔行之后才算第一条数据行
  const anchor = spans[row < 0 ? 1 : row + 2]
  if (!anchor) return null
  const cells = Array.from({ length: model.header.length }, () => '')
  const line = buildRowLine(cells)
  return `${source.slice(0, anchor.to)}\n${line}${source.slice(anchor.to)}`
}

/** 删除一条数据行；表头不可删 */
export function removeRow(source: string, row: number): string | null {
  const model = parseTable(source)
  if (!model || row < 0 || row >= model.rows.length) return null
  const target = sourceLineSpans(source)[row + 2]
  if (!target) return null
  // 连同前面的换行一起删，行首行退化为删行加尾部换行
  const from = target.from > 0 ? target.from - 1 : 0
  const to = target.from > 0 ? target.to : Math.min(target.to + 1, source.length)
  return source.slice(0, from) + source.slice(to)
}

/** 在 col 列右侧插入一列空单元格；分隔行补 ---（不继承对齐） */
export function addColumn(source: string, col: number): string | null {
  const model = parseTable(source)
  if (!model || col < 0 || col >= model.header.length) return null
  const at = col + 1
  let seen = 0
  const next = source.split('\n').map((text) => {
    if (text.trim() === '') return text
    const delimiter = seen === 1
    seen += 1
    const cells = splitRow(text)
    cells.splice(at, 0, delimiter ? '---' : '')
    return buildRowLine(cells)
  })
  return next.join('\n')
}

/** 删除 col 列；最后一列不允许删（单列表格是合法的，从列语义上没有"再少一列"） */
export function removeColumn(source: string, col: number): string | null {
  const model = parseTable(source)
  if (!model || col < 0 || col >= model.header.length || model.header.length <= 1) return null
  const next = source.split('\n').map((text) => {
    if (text.trim() === '') return text
    const cells = splitRow(text)
    cells.splice(col, 1)
    return buildRowLine(cells)
  })
  return next.join('\n')
}
