import { describe, expect, it } from 'vitest'
import { buildHtml, deriveTitle, escapeHtml, renderBody } from '../src/renderer/src/export/html'
import { katexExportCss } from '../src/renderer/src/export/katex-css'

const MD = `---
title: 手册标题
---

# 一级标题

段落 **粗体** 与 [链接](a.md)。

| A | B |
| - | - |
| 1 | 2 |

- [x] 已完成

\`\`\`js
const x = 1
\`\`\`

<script>alert(1)</script>

[点我](javascript:alert(1))

<img src=x onerror=alert(1)>
`

describe('remark 导出链', () => {
  it('中文标题生成锚点', async () => {
    expect(await renderBody('# 一级标题\n')).toContain('<h1 id="一级标题">')
  })

  it('GFM 表格与任务列表渲染', async () => {
    const html = await renderBody(MD)
    expect(html).toContain('<table>')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('checked')
  })

  it('代码块带高亮类名', async () => {
    const html = await renderBody(MD)
    expect(html).toContain('hljs')
    expect(html).toContain('language-js')
  })

  it('front matter 不进入正文', async () => {
    expect(await renderBody(MD)).not.toContain('手册标题')
  })
})

describe('安全过滤', () => {
  it('脚本、事件属性与 javascript: 协议被丢弃', async () => {
    const html = await renderBody(MD)
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('javascript:')
  })

  it('普通标签保留，class 按 GitHub 白名单过滤', async () => {
    const html = await renderBody('<div class="note">说明</div>\n')
    expect(html).toContain('<div>说明</div>')
    expect(await renderBody('[说明](docs/a.md)\n')).toContain('href="docs/a.md"')
  })
})

describe('公式与图表导出', () => {
  it('行内公式渲染为 katex，不再留 $ 原文', async () => {
    const html = await renderBody('质能关系 $E=mc^2$ 成立。\n')
    expect(html).toContain('class="katex"')
    expect(html).toContain('mdf-math-inline')
    expect(html).not.toContain('$E=mc^2$')
  })

  it('行间公式渲染成独立块', async () => {
    const html = await renderBody('$$\nx = \\frac{1}{2}\n$$\n')
    expect(html).toContain('mdf-math-block')
    expect(html).toContain('katex-display')
    expect(html).not.toContain('$')
  })

  it('公式里的代码围栏与代码里的 $ 不受影响', async () => {
    const html = await renderBody('```math\nx^2\n```\n\n行内 `$x$` 代码。\n')
    expect(html).toContain('language-math')
    expect(html).not.toContain('mdf-math-block')
  })

  it('原始 HTML 里的公式类名仍被 sanitize 剥掉', async () => {
    const html = await renderBody('<span class="math math-inline">raw</span>\n')
    expect(html).toContain('<span>raw</span>')
    expect(html).not.toContain('math-inline')
  })

  it('文档带公式时才追加 katex 样式与内嵌字体', async () => {
    const withMath = await buildHtml('$a^2$\n', '带公式')
    expect(withMath).toContain('data:font/woff2;base64')
    expect(withMath).toContain('KaTeX_Main')
    const without = await buildHtml('普通段落\n', '不带公式')
    expect(without).not.toContain('data:font/woff2')
  })

  it('katex 样式里的字体全部内嵌，不残留相对路径', () => {
    const css = katexExportCss()
    expect(css).toContain('data:font/woff2;base64')
    expect(css).not.toContain('url(fonts/')
    expect(css).not.toContain('.woff)')
  })

  it('mermaid 在无 DOM 环境渲染失败时退回原始代码块', async () => {
    const html = await renderBody('```mermaid\ngraph TD; A-->B;\n```\n')
    expect(html).toContain('language-mermaid')
  })
})

describe('标题与转义', () => {
  it('依次尝试 front matter、ATX、Setext、回退名', () => {
    expect(deriveTitle(MD, '回退')).toBe('手册标题')
    expect(deriveTitle('# 只有正文标题\n', '回退')).toBe('只有正文标题')
    expect(deriveTitle('普通文本\n====\n', '回退')).toBe('普通文本')
    expect(deriveTitle('没有标题的文档', '回退名')).toBe('回退名')
  })

  it('标题里的 HTML 被转义', () => {
    expect(escapeHtml('<a & "b">')).toBe('&lt;a &amp; &quot;b&quot;&gt;')
  })

  it('完整文档包含样式与结构', async () => {
    const html = await buildHtml('# 标题\n', '标题 <x>')
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('<title>标题 &lt;x&gt;</title>')
    expect(html).toContain('.mdf-doc')
    expect(html).toContain('<h1 id="标题">标题</h1>')
  })
})
