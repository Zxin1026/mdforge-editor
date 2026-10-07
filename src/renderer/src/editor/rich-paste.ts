/**
 * 富文本粘贴：剪贴板同时带 HTML 时（浏览器、Word、其它应用的网页版表格等），
 * 先转成 Markdown 再插入——与 Typora 的粘贴行为对齐。
 * 只有纯文本的粘贴不经过这里，仍是 CodeMirror 的默认行为。
 */
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

/** Windows 的 CF_HTML 封装带头部和 fragment 标记，取真正的片段 */
export function stripCfHtml(raw: string): string {
  const marker = '<!--StartFragment-->'
  const start = raw.indexOf(marker)
  const end = raw.lastIndexOf('<!--EndFragment-->')
  if (start >= 0 && end > start) return raw.slice(start + marker.length, end)
  // 没有 fragment 标记时退而求其次：砍掉版本头，从第一个标签开始
  const tag = raw.indexOf('<')
  if (/^Version:\s*[\d.]/.test(raw)) return tag > 0 ? raw.slice(tag) : ''
  return raw
}

const converter = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  linkStyle: 'inlined'
})
// GFM：表格、删除线、任务列表、代码块语言
converter.use(gfm)

// 来源 HTML 的文本里可能本来就写着 Markdown 链接（如聊天界面把 `[folder.ts](E:/…)`
// 当文件签的文本存下来），默认转义会把方括号与下划线打成字面量、链接就废了。
// 方形括号与下划线在正文里几乎没有歧义，放开这三种；其余转义照旧。
const escapeDefault = converter.escape.bind(converter)
converter.escape = (text: string): string => escapeDefault(text).replace(/\\([[\]_])/g, '$1')

/** HTML → Markdown；转不出内容（空片段 / 解析异常）时返回 null，调用方退回纯文本 */
export function htmlToMarkdown(html: string): string | null {
  const fragment = stripCfHtml(html)
  if (fragment.trim() === '') return null
  try {
    const markdown = converter.turndown(fragment).trim()
    return markdown === '' ? null : markdown
  } catch {
    return null
  }
}

export function richPaste(): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const data = event.clipboardData
      // 带文件的粘贴（图片/文件）不接管：图片走 imagePaste，其余交给默认行为
      if (!data || Array.from(data.files ?? []).length > 0) return false
      const html = data.getData('text/html')
      if (html.trim() === '') return false
      const markdown = htmlToMarkdown(html)
      if (markdown === null) return false
      event.preventDefault()
      view.dispatch({
        ...view.state.replaceSelection(markdown),
        scrollIntoView: true,
        userEvent: 'input.paste'
      })
      return true
    }
  })
}
