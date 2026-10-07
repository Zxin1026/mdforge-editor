import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeSlug from 'rehype-slug'
import rehypeStringify from 'rehype-stringify'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { DEFAULT_EXPORT_OPTIONS, type ExportOptions } from '../../../shared/ipc'
import { cssFor, pageCss } from './export-css'
import { rehypeImageWidth, rehypeToc, toPlainText } from './hast'

/**
 * 导出与校验走 remark 链（CommonMark 合规），与编辑期的 lezer 分工但互不依赖。
 * allowDangerousHtml + rehype-raw 让原始 HTML 进入 hast，再由 rehype-sanitize
 * 统一收口：脚本、事件属性与 javascript: 协议在这里被丢弃。
 * 收口之后才做锚点、图片宽度和目录，避免这些插件生成的属性被当成用户输入过滤掉。
 */
function body() {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, defaultSchema)
}

function htmlProcessor(options: ExportOptions) {
  const processor = body().use(rehypeSlug).use(rehypeImageWidth)
  if (options.toc) processor.use(rehypeToc)
  return processor.use(rehypeHighlight).use(rehypeStringify)
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;'
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => ESCAPES[char])
}

export function deriveTitle(markdownText: string, fallback: string): string {
  const frontMatterTitle = /^---\r?\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m.exec(markdownText)
  if (frontMatterTitle) return frontMatterTitle[1].trim()

  const atx = /^#\s+(.+?)\s*#*\s*$/m.exec(markdownText)
  if (atx) return atx[1].trim()

  const setext = /^(.+)\r?\n=+\s*$/m.exec(markdownText)
  if (setext) return setext[1].trim()

  return fallback
}

export async function renderBody(
  markdownText: string,
  options: ExportOptions = DEFAULT_EXPORT_OPTIONS
): Promise<string> {
  return String(await htmlProcessor(options).process(markdownText))
}

/** 纯文本导出：走同一条渲染链，只取文字，不生成 HTML */
export async function renderText(markdownText: string): Promise<string> {
  const processor = body()
  return toPlainText(await processor.run(processor.parse(markdownText)))
}

export async function buildHtml(
  markdownText: string,
  title: string,
  options: ExportOptions = DEFAULT_EXPORT_OPTIONS
): Promise<string> {
  const bodyHtml = await renderBody(markdownText, options)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${cssFor(options.theme)}
${pageCss(options.paper, options.margin)}</style>
</head>
<body>
<article class="mdf-doc">
${bodyHtml}
</article>
</body>
</html>
`
}
