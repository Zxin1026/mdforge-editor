import { widthFromTitle } from '../editor/assets'
import { dirOfPath, relativeBetween } from '../paths'

/**
 * 导出链上的 hast 处理。hast 的类型包在依赖内部，这里用自己的宽松形状描述，
 * 只声明用到的字段（v3 的元素节点是 tagName / properties）。
 */
export interface HastNode {
  type: string
  value?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

export interface HastRoot {
  type: 'root'
  children: HastNode[]
}

interface HeadingEntry {
  level: number
  anchor: string
  text: string
}

const HEADING_LEVEL: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 }
const SKIPPED = new Set(['script', 'style'])
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'div',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tr',
  'ul'
])

function element(tagName: string, properties: Record<string, unknown>, children: HastNode[]): HastNode {
  return { type: 'element', tagName, properties, children }
}

function text(value: string): HastNode {
  return { type: 'text', value }
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function textOf(node: HastNode): string {
  if (node.type === 'text') return node.value ?? ''
  if (node.type === 'element' && SKIPPED.has(node.tagName ?? '')) return ''
  return (node.children ?? []).map(textOf).join('')
}

function headingEntries(tree: HastRoot): HeadingEntry[] {
  const items: HeadingEntry[] = []
  for (const node of tree.children) {
    if (node.type !== 'element') continue
    const level = HEADING_LEVEL[node.tagName ?? '']
    if (level === undefined) continue
    items.push({
      level,
      anchor: stringOf(node.properties?.id),
      text: textOf(node).replace(/\s+/g, ' ').trim()
    })
  }
  return items
}

/**
 * 目录：在正文最前面插入扁平列表，按标题层级缩进。
 * 锚点由 rehype-slug 生成，和本应用的大纲同一套规则，链接才指得准。
 * 写成"接入器返回转换器"：unified 按参数个数决定怎么调用，直接收节点的函数会被当成接入器。
 */
export function rehypeToc() {
  return (input: unknown): void => {
    const tree = input as HastRoot
    const headings = headingEntries(tree).filter((item) => item.anchor !== '')
    if (headings.length === 0) return

    const items = headings.map((heading) =>
      element('li', { className: ['mdf-toc-item', `level-${Math.min(6, Math.max(1, heading.level))}`] }, [
        element('a', { href: `#${heading.anchor}` }, [text(heading.text === '' ? '（无标题）' : heading.text)])
      ])
    )

    tree.children.unshift(
      element('nav', { className: ['mdf-toc'], 'aria-label': '目录' }, [
        element('div', { className: ['mdf-toc-title'] }, [text('目录')]),
        element('ul', { className: ['mdf-toc-list'] }, items)
      ])
    )
  }
}

/**
 * 编辑器把图片宽度写在 title 槽里（`![说明](a.png "w=640")`）才不破坏 CommonMark，
 * 导出时还原成 width 属性，剩下的说明文字继续留在 title 上。
 */
export function rehypeImageWidth() {
  return (input: unknown): void => {
    walk(input as HastRoot)
  }
}

/** 站内链接改写所需的上下文：当前页、源文档目录与整站的路径对照表 */
export interface SiteLinkContext {
  /** 当前页面在站点里的相对路径（posix），用于算相对链接 */
  pagePath: string
  /** 源文档所在目录的绝对路径 */
  docDir: string
  /** 源文档绝对路径（小写） → 站点内 html 相对路径 */
  map: Map<string, string>
  /** 相对引用 → 绝对路径（渲染进程侧的 resolvePath） */
  resolve(baseDir: string, relative: string): string
}

/** `b.md#x` → 站点内的 `b.html#x`；指向导出范围之外或外部地址的返回 null 保持原样 */
export function siteHref(href: string, context: SiteLinkContext): string | null {
  if (href === '' || href.startsWith('#')) return null
  if (href.startsWith('//') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return null
  const hashIndex = href.indexOf('#')
  const filePart = hashIndex >= 0 ? href.slice(0, hashIndex) : href
  const hash = hashIndex >= 0 ? href.slice(hashIndex) : ''
  if (filePart === '') return null
  let decoded = filePart
  try {
    decoded = decodeURIComponent(filePart)
  } catch {
    /* 编码异常就按原样解析 */
  }
  const target = context.map.get(context.resolve(context.docDir, decoded).toLowerCase())
  if (target === undefined) return null
  const relative = relativeBetween(dirOfPath(context.pagePath), target)
  if (relative === null) return null
  return encodeURI(relative) + hash
}

/** 把正文里的文档间链接改写为导出页面的地址 */
export function rehypeSiteLinks(context: SiteLinkContext) {
  return (input: unknown): void => {
    rewriteTree(input as HastRoot, context)
  }
}

function rewriteTree(tree: HastRoot, context: SiteLinkContext): void {
  for (const node of tree.children) {
    if (node.type !== 'element') continue
    if (node.tagName === 'a' && node.properties) {
      const href = stringOf(node.properties.href)
      const next = siteHref(href, context)
      if (next !== null) node.properties.href = next
    }
    if (node.children) rewriteTree({ type: 'root', children: node.children }, context)
  }
}

function walk(tree: HastRoot): void {
  for (const node of tree.children) {
    if (node.type === 'element' && node.tagName === 'img' && node.properties) {
      const title = stringOf(node.properties.title)
      const width = widthFromTitle(title === '' ? null : title)
      if (width !== null) {
        node.properties.width = width
        const rest = title.replace(/(^|\s)w=\d+(px)?(?=\s|$)/i, '').trim()
        if (rest === '') delete node.properties.title
        else node.properties.title = rest
      }
    }
    if (node.children) walk({ type: 'root', children: node.children })
  }
}

function inlineText(node: HastNode, out: string[]): void {
  if (node.type === 'text' || node.type === 'comment') {
    out.push(node.value ?? '')
    return
  }
  if (node.type !== 'element') return
  const tag = node.tagName ?? ''
  if (SKIPPED.has(tag)) return
  if (tag === 'img') {
    const alt = stringOf(node.properties?.alt).trim()
    if (alt !== '') out.push(alt)
    return
  }
  if (tag === 'br') {
    out.push('\n')
    return
  }
  if (tag === 'li') out.push('\n- ')
  else if (tag === 'td' || tag === 'th') out.push('\t')
  else if (BLOCK_TAGS.has(tag)) out.push('\n')
  for (const child of node.children ?? []) inlineText(child, out)
  if (tag === 'td' || tag === 'th' || BLOCK_TAGS.has(tag)) out.push('\n')
}

/** 纯文本导出：走同一条渲染链，只把文字取出来 */
export function toPlainText(input: unknown): string {
  const tree = input as HastRoot
  const out: string[] = []
  for (const node of tree.children) inlineText(node, out)
  return out
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
