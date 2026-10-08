import { randomUUID } from 'node:crypto'
import type { ZipEntry } from './zip'

/**
 * EPUB 的 XML 组装：不碰磁盘与 Electron，方便单测。
 * 结构按 EPUB 3：mimetype（存储、第一条）+ container.xml + OPF + 导航 + 章节。
 */

/** XML 只认五个预定义实体，其余命名实体换成数字引用；不认识的转义成文本 */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: '&#160;',
  mdash: '&#8212;',
  ndash: '&#8211;',
  hellip: '&#8230;',
  copy: '&#169;',
  reg: '&#174;',
  trade: '&#8482;',
  deg: '&#176;',
  middot: '&#183;',
  lsquo: '&#8216;',
  rsquo: '&#8217;',
  ldquo: '&#8220;',
  rdquo: '&#8221;',
  laquo: '&#171;',
  raquo: '&#187;',
  sect: '&#167;',
  para: '&#182;',
  times: '&#215;',
  divide: '&#247;',
  plusmn: '&#177;',
  ne: '&#8800;',
  le: '&#8804;',
  ge: '&#8805;',
  larr: '&#8592;',
  rarr: '&#8594;',
  uarr: '&#8593;',
  darr: '&#8595;',
  harr: '&#8596;',
  amp: '&amp;',
  lt: '&lt;',
  gt: '&gt;',
  quot: '&quot;',
  apos: '&#39;'
}

const VOID_TAGS = /<(img|br|hr|input|col|area|base|embed|source|track|wbr|param)(\b[^>]*?)\s*\/?>/gi

/** HTML 片段 → XHTML：空元素补闭合、命名实体换成 XML 认得的形式 */
export function toXhtml(html: string): string {
  return html
    .replace(VOID_TAGS, '<$1$2/>')
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (_all, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? `&amp;${name};`)
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export interface EpubChapter {
  title: string
  /** 章节正文 HTML（图片应已内联成 base64） */
  body: string
}

export interface EpubBookInput {
  title: string
  author?: string
  language?: string
  css: string
  chapters: readonly EpubChapter[]
}

export const EPUB_CONTAINER_XML = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`

function htmlDocument(title: string, language: string, body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(
    language
  )}" lang="${escapeXml(language)}">
<head>
<meta charset="utf-8"/>
<title>${escapeXml(title)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${body}
</body>
</html>
`
}

export function chapterDocument(chapter: EpubChapter, language: string): string {
  return htmlDocument(chapter.title, language, `<section epub:type="chapter">\n${chapter.body}\n</section>`)
}

export function navDocument(chapters: ReadonlyArray<{ title: string; file: string }>, language: string): string {
  const items = chapters
    .map((chapter) => `      <li><a href="${escapeXml(chapter.file)}">${escapeXml(chapter.title)}</a></li>`)
    .join('\n')
  return htmlDocument(
    '目录',
    language,
    `<nav epub:type="toc" id="toc">
<h1>目录</h1>
<ol>
${items}
</ol>
</nav>`
  )
}

export function opfDocument(
  book: { title: string; author?: string; language: string },
  chapters: ReadonlyArray<{ file: string; id: string }>
): string {
  const items = chapters
    .map((chapter) => `    <item id="${chapter.id}" href="${escapeXml(chapter.file)}" media-type="application/xhtml+xml"/>`)
    .join('\n')
  const spine = chapters.map((chapter) => `    <itemref idref="${chapter.id}"/>`).join('\n')
  const creator = book.author && book.author !== '' ? `\n    <dc:creator>${escapeXml(book.author)}</dc:creator>` : ''
  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:${randomUUID()}</dc:identifier>
    <dc:title>${escapeXml(book.title)}</dc:title>
    <dc:language>${escapeXml(book.language)}</dc:language>${creator}
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="style" href="style.css" media-type="text/css"/>
${items}
  </manifest>
  <spine>
${spine}
  </spine>
</package>
`
}

/** 组装 EPUB 的 zip 条目清单（mimetype 必须存储且排第一） */
export function buildEpubEntries(book: EpubBookInput): ZipEntry[] {
  const language = book.language ?? 'zh-CN'
  const chapters = book.chapters.map((chapter, index) => ({
    title: chapter.title.trim() === '' ? `第 ${index + 1} 章` : chapter.title,
    file: `chapter-${index + 1}.xhtml`,
    id: `chapter-${index + 1}`,
    body: chapter.body
  }))

  const entries: ZipEntry[] = [
    { name: 'mimetype', data: Buffer.from('application/epub+zip', 'ascii'), store: true },
    { name: 'META-INF/container.xml', data: Buffer.from(EPUB_CONTAINER_XML, 'utf8') },
    {
      name: 'OEBPS/content.opf',
      data: Buffer.from(opfDocument({ title: book.title, author: book.author, language }, chapters), 'utf8')
    },
    { name: 'OEBPS/nav.xhtml', data: Buffer.from(navDocument(chapters, language), 'utf8') },
    { name: 'OEBPS/style.css', data: Buffer.from(book.css, 'utf8') }
  ]
  for (const chapter of chapters) {
    entries.push({
      name: `OEBPS/${chapter.file}`,
      data: Buffer.from(chapterDocument(chapter, language), 'utf8')
    })
  }
  return entries
}
