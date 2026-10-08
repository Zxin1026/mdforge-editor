const REMOVED = /[^\p{L}\p{N} \-_]/gu

const OPEN_MARK = /^#{1,6}\s+/
const CLOSED_MARK = /\s+#+\s*$/
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/g
const LINK = /\[([^\]]*)\]\([^)]*\)/g
const WRAP = /(\*\*|__|~~|`|\*|_)/g

/** 大纲与锚点都用纯文本标题：去掉 # 标记、图片取 alt、链接取文字、剥掉强调包裹符 */
export function headingTitle(raw: string): string {
  return raw
    .replace(OPEN_MARK, '')
    .replace(CLOSED_MARK, '')
    .replace(IMAGE, '$1')
    .replace(LINK, '$1')
    .replace(WRAP, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface Slugger {
  slug(text: string): string
}

/**
 * GitHub 风格的锚点：保留中日韩字符与字母数字，去掉标点，空格转连字符，
 * 重复标题追加 -1 / -2。编辑器大纲与导出 HTML 必须共用同一个实例，
 * 否则重复标题的计数会错位，目录链接指向不存在的锚点。
 */
export function createSlugger(): Slugger {
  const counts = new Map<string, number>()

  return {
    slug(text: string): string {
      const base = text.trim().toLowerCase().replace(REMOVED, '').replace(/ /g, '-')
      const seen = counts.get(base) ?? 0
      counts.set(base, seen + 1)
      return seen === 0 ? base : `${base}-${seen}`
    }
  }
}

export function slugOnce(text: string): string {
  return createSlugger().slug(text)
}
