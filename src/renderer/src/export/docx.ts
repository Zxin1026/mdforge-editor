/**
 * DOCX 导出：markdown → mdast → WordprocessingML（<w:body> 片段）。
 * 图片与超链接在正文里留 id 占位，主进程负责读图、补 drawing 与关系表；
 * 公式在这里栅格化成 PNG 后随图片占位一起走，Word 里直接是渲染好的公式。
 */

import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { DOCX_NUM_BULLET, DOCX_NUM_ORDERED, type DocxImageRef, type DocxLinkRef } from '../../../shared/ipc'
import { resolveLocalPath, widthFromTitle } from '../editor/assets'
import { rasterizeMath, type MathImage } from './math-image'
import { rasterizeMermaid, type MermaidImage } from './mermaid-image'

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  depth?: number
  ordered?: boolean
  checked?: boolean | null
  url?: string
  alt?: string | null
  lang?: string | null
  title?: string | null
}

export interface DocxBuild {
  bodyXml: string
  links: DocxLinkRef[]
  images: DocxImageRef[]
}

interface RunStyle {
  bold?: boolean
  italic?: boolean
  strike?: boolean
  code?: boolean
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;'
}

export function escapeXml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => XML_ESCAPES[char])
}

function runProps(style: RunStyle): string {
  const parts: string[] = []
  if (style.bold === true) parts.push('<w:b/>')
  if (style.code === true) parts.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>')
  if (style.italic === true) parts.push('<w:i/>')
  if (style.strike === true) parts.push('<w:strike/>')
  if (style.code === true) parts.push('<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>')
  return parts.length === 0 ? '' : `<w:rPr>${parts.join('')}</w:rPr>`
}

function textRun(text: string, style: RunStyle = {}): string {
  return `<w:r>${runProps(style)}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`
}

function paragraph(pPrInner: string, runs: string): string {
  return `<w:p>${pPrInner === '' ? '' : `<w:pPr>${pPrInner}</w:pPr>`}${runs}</w:p>`
}

const NUM_XML = (numId: number, level: number): string =>
  `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`

const IND_XML = (level: number): string => `<w:ind w:left="${720 + 360 * level}"/>`

const TBL_BORDERS =
  '<w:tblBorders>' +
  ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BBBBBB"/>`)
    .join('') +
  '</w:tblBorders>'

function mathKey(source: string, display: boolean): string {
  return `${display ? 'D' : 'I'}\n${source}`
}

interface RenderedBlocks {
  math: Map<string, MathImage | null>
  mermaid: Map<string, MermaidImage | null>
}

/** 公式与 mermaid 图先统一栅格化：同一段源码只画一次，画不出来的记 null 退回文本 */
async function rasterizeBlocks(children: readonly MdNode[]): Promise<RenderedBlocks> {
  const mathPairs = new Map<string, { source: string; display: boolean }>()
  const mermaidPairs = new Set<string>()
  const collect = (nodes: readonly MdNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'inlineMath' || node.type === 'math') {
        const display = node.type === 'math'
        const source = (node.value ?? '').trim()
        mathPairs.set(mathKey(source, display), { source, display })
      } else if (node.type === 'code' && node.lang === 'mermaid') {
        mermaidPairs.add((node.value ?? '').trim())
      }
      if (node.children !== undefined) collect(node.children)
    }
  }
  collect(children)

  const math = new Map<string, MathImage | null>()
  for (const [key, item] of mathPairs) math.set(key, await rasterizeMath(item.source, item.display))
  const mermaid = new Map<string, MermaidImage | null>()
  for (const source of mermaidPairs) mermaid.set(source, await rasterizeMermaid(source))
  return { math, mermaid }
}

/**
 * 构建 DOCX 正文 XML。docPath 为 null（未保存文档）时相对图片路径解析不了，
 * 会退化成 alt 文字占位；绝对路径的图片照常走占位注释。
 */
export async function buildDocx(markdownText: string, docPath: string | null): Promise<DocxBuild> {
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkFrontmatter, ['yaml'])
    .parse(markdownText) as unknown as MdNode

  const links: DocxLinkRef[] = []
  const images: DocxImageRef[] = []
  const blocks = await rasterizeBlocks(tree.children ?? [])
  let seq = 0

  function mathRun(node: MdNode, display: boolean): string {
    const source = (node.value ?? '').trim()
    const image = blocks.math.get(mathKey(source, display))
    if (image === undefined || image === null) {
      // 无 DOM（单测）或渲染失败：至少把公式源码留在文档里，不静默丢内容
      return textRun(display ? `$$${source}$$` : `$${source}$`, { code: true })
    }
    const id = `I${++seq}`
    images.push({ id, path: '公式', widthPx: image.width, bytes: image.bytes })
    return `<w:r><!--mdfimg:${id}--></w:r>`
  }

  function imageRun(node: MdNode): string {
    const url = (node.url ?? '').trim()
    const local = docPath === null || url === '' ? null : resolveLocalPath(docPath, url)
    if (local === null) {
      const alt = (node.alt ?? '').trim()
      return textRun(alt === '' ? `[图片：${url}]` : `[图片：${alt}]`, { italic: true })
    }
    const id = `I${++seq}`
    images.push({ id, path: local, widthPx: widthFromTitle(node.title ?? null) })
    return `<w:r><!--mdfimg:${id}--></w:r>`
  }

  function inlineRuns(nodes: readonly MdNode[], style: RunStyle = {}): string {
    const out: string[] = []
    for (const node of nodes) {
      if (node.type === 'text') out.push(textRun(node.value ?? '', style))
      else if (node.type === 'strong') out.push(inlineRuns(node.children ?? [], { ...style, bold: true }))
      else if (node.type === 'emphasis') out.push(inlineRuns(node.children ?? [], { ...style, italic: true }))
      else if (node.type === 'delete') out.push(inlineRuns(node.children ?? [], { ...style, strike: true }))
      else if (node.type === 'inlineCode') out.push(textRun(node.value ?? '', { ...style, code: true }))
      else if (node.type === 'break') out.push('<w:r><w:br/></w:r>')
      else if (node.type === 'link') {
        const id = `L${++seq}`
        links.push({ id, target: node.url ?? '' })
        out.push(`<w:hyperlink r:id="${id}">${inlineRuns(node.children ?? [], style)}</w:hyperlink>`)
      } else if (node.type === 'image') out.push(imageRun(node))
      else if (node.type === 'inlineMath') out.push(mathRun(node, false))
      else if (node.type === 'html') continue
      else if (node.children !== undefined) out.push(inlineRuns(node.children, style))
    }
    return out.join('')
  }

  function codeBlockLines(node: MdNode): string {
    return (node.value ?? '')
      .split('\n')
      .map((line) => paragraph('<w:pStyle w:val="CodeBlock"/>', textRun(line, { code: true })))
      .join('')
  }

  /** mermaid 围栏：画成图片居中摆放；渲染不出来的环境（单测等）退回代码块 */
  function codeBlock(node: MdNode): string {
    if (node.lang === 'mermaid') {
      const image = blocks.mermaid.get((node.value ?? '').trim())
      if (image !== undefined && image !== null) {
        const id = `I${++seq}`
        images.push({ id, path: '图表', widthPx: image.width, bytes: image.bytes })
        return paragraph('<w:jc w:val="center"/>', `<w:r><!--mdfimg:${id}--></w:r>`)
      }
    }
    return codeBlockLines(node)
  }

  function tableXml(node: MdNode): string {
    const rows = (node.children ?? []).filter((row) => row.type === 'tableRow')
    const body = rows
      .map((row, rowIndex) =>
        `<w:tr>${(row.children ?? [])
          .map(
            (cell) =>
              `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${paragraph(
                '',
                inlineRuns(cell.children ?? [], rowIndex === 0 ? { bold: true } : {}) || textRun('')
              )}</w:tc>`
          )
          .join('')}</w:tr>`
      )
      .join('')
    return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${TBL_BORDERS}</w:tblPr>${body}</w:tbl>`
  }

  function listItem(node: MdNode, level: number, numId: number): string {
    const parts: string[] = []
    let firstParagraph = true
    for (const child of node.children ?? []) {
      if (child.type === 'paragraph') {
        const prefix =
          node.checked === null || node.checked === undefined ? '' : textRun(node.checked ? '☑ ' : '☐ ')
        const pPr = firstParagraph ? NUM_XML(numId, level) : IND_XML(level)
        parts.push(paragraph(pPr, (firstParagraph ? prefix : '') + inlineRuns(child.children ?? [])))
        firstParagraph = false
      } else if (child.type === 'list') {
        parts.push(listXml(child, level + 1))
      } else {
        parts.push(blockXml(child, false))
      }
    }
    if (parts.length === 0) parts.push(paragraph(NUM_XML(numId, level), ''))
    return parts.join('')
  }

  function listXml(node: MdNode, level: number): string {
    const numId = node.ordered === true ? DOCX_NUM_ORDERED : DOCX_NUM_BULLET
    return (node.children ?? [])
      .filter((child) => child.type === 'listItem')
      .map((item) => listItem(item, level, numId))
      .join('')
  }

  function blockXml(node: MdNode, quoted: boolean): string {
    if (node.type === 'paragraph') {
      const runs = inlineRuns(node.children ?? [])
      return paragraph(quoted ? '<w:pStyle w:val="Quote"/>' : '', runs)
    }
    if (node.type === 'heading') {
      const depth = Math.min(6, Math.max(1, node.depth ?? 1))
      return paragraph(`<w:pStyle w:val="Heading${depth}"/>`, inlineRuns(node.children ?? []))
    }
    if (node.type === 'code') return codeBlock(node)
    // 行间公式单独成段、居中；内联公式在段落里已经处理
    if (node.type === 'math') return paragraph('<w:jc w:val="center"/>', mathRun(node, true))
    if (node.type === 'blockquote') {
      return (node.children ?? []).map((child) => blockXml(child, true)).join('')
    }
    if (node.type === 'list') return listXml(node, 0)
    if (node.type === 'table') return tableXml(node)
    if (node.type === 'thematicBreak') {
      return `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr></w:pPr></w:p>`
    }
    // yaml 之外的未知块（脚注定义等）不产出内容
    return ''
  }

  const bodyXml = (tree.children ?? []).map((node) => blockXml(node, false)).join('')
  return { bodyXml, links, images }
}
