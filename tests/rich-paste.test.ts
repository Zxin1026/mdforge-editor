import { describe, expect, it } from 'vitest'
import { htmlToMarkdown, stripCfHtml } from '../src/renderer/src/editor/rich-paste'

describe('剪贴板 HTML 清洗', () => {
  it('CF_HTML 带头部与 fragment 标记时取片段', () => {
    const raw =
      'Version:0.9\r\nStartHTML:0000000105\r\nEndHTML:0000001338\r\n<html><body><!--StartFragment--><p>你好</p><!--EndFragment--></body></html>'
    expect(stripCfHtml(raw)).toBe('<p>你好</p>')
  })

  it('只有版本头没有 fragment 标记时从第一个标签开始', () => {
    const raw = 'Version:1.0\r\nStartHTML:0000000105\r\n<html><body><p>hi</p></body></html>'
    expect(stripCfHtml(raw)).toBe('<html><body><p>hi</p></body></html>')
  })

  it('版本头之外什么都没有时视为空', () => {
    expect(stripCfHtml('Version:0.9\r\nStartHTML:0000000105\r\n')).toBe('')
  })

  it('普通的 HTML 片段原样返回', () => {
    const raw = '<p><strong>a</strong></p>'
    expect(stripCfHtml(raw)).toBe(raw)
  })

  it('空 HTML 转不出 Markdown', () => {
    expect(htmlToMarkdown('')).toBeNull()
    expect(htmlToMarkdown('   \n ')).toBeNull()
    expect(htmlToMarkdown('Version:0.9\r\nStartHTML:0000000105\r\n')).toBeNull()
  })
})
