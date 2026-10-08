import { templatePlaceholderProblem } from '../../../shared/ipc'

/**
 * 页面模板：导出页的外壳 HTML，占位符在装配时替换。
 * parts 里的值都以 HTML 片段/已转义文本的形式传入（title 由调用方转义），
 * 这里只做字面替换，避免正文里的 $&、$' 之类被 replace 的替换串语义吃掉。
 */

export interface TemplateParts {
  /** 已转义的文档标题 */
  title: string
  /** html lang，目前固定 zh-CN */
  lang: string
  /** 完整的 <style> 标签（排版主题 + 代码高亮 + @page） */
  style: string
  /** 页首导航片段（静态站点用），没有时传空串 */
  nav: string
  /** 正文：<article class="mdf-doc">…</article>，目录页会再跟一段脚本 */
  content: string
}

export const TEMPLATE_PLACEHOLDER_HINT = '{{title}} · {{lang}} · {{style}} · {{nav}} · {{content}}（必填）'

/** 内置标准页：与 1.2.0 之前的导出结构逐字节一致 */
export const BUILTIN_TEMPLATE_HTML = `<!doctype html>
<html lang="{{lang}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{title}}</title>
{{style}}
</head>
<body>
{{nav}}{{content}}
</body>
</html>
`

export function templateProblem(html: string): string | null {
  if (html.trim() === '') return '模板内容不能为空'
  return templatePlaceholderProblem(html)
}

export function applyTemplate(template: string, parts: TemplateParts): string {
  let html = template.replaceAll('{{title}}', () => parts.title)
  html = html.replaceAll('{{lang}}', () => parts.lang)
  html = html.replaceAll('{{nav}}', () => parts.nav)
  html = html.replaceAll('{{content}}', () => parts.content)
  // {{style}} 没写时把样式塞进 </head> 之前；连 head 都没有就放在最前面
  if (html.includes('{{style}}')) return html.replaceAll('{{style}}', () => parts.style)
  if (html.includes('</head>')) return html.replace('</head>', () => `${parts.style}\n</head>`)
  return `${parts.style}\n${html}`
}
