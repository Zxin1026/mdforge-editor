/** 围栏代码块扫描：哪些行在代码块里、有没有到文末还没闭合的块 */

export interface FenceScan {
  /** 位于围栏代码块内的行（1 起，含围栏行本身） */
  fenced: Set<number>
  /** 没有等到收尾围栏的开头（1 起的行号 + 围栏字符） */
  unclosed: { line: number; marker: string } | null
}

const OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/

export function scanFences(text: string): FenceScan {
  const fenced = new Set<number>()
  let open: { marker: string; length: number; line: number } | null = null
  const lines = text.split('\n')

  for (let index = 0; index < lines.length; index += 1) {
    const number = index + 1
    const match = OPEN.exec(lines[index])
    if (open === null) {
      if (match) {
        open = { marker: match[1][0], length: match[1].length, line: number }
        fenced.add(number)
      }
      continue
    }
    fenced.add(number)
    // 收尾围栏：同一种字符、不短于开头、后面不能带 info 串
    if (match && match[1][0] === open.marker && match[1].length >= open.length && match[2].trim() === '') {
      open = null
    }
  }

  return { fenced, unclosed: open === null ? null : { line: open.line, marker: open.marker.repeat(3) } }
}
