import { describe, expect, it } from 'vitest'
import { DEFAULT_EXPORT_OPTIONS, normalizeExportOptions, type ExportOptions } from '../src/shared/ipc'
import { buildHtml, renderBody, renderText } from '../src/renderer/src/export/html'

const opts = (patch: Partial<ExportOptions> = {}): ExportOptions => ({ ...DEFAULT_EXPORT_OPTIONS, ...patch })

describe('导出目录', () => {
  it('默认不插目录', async () => {
    expect(await renderBody('# A\n\n## B\n', opts())).not.toContain('mdf-toc')
  })

  it('开了目录按标题层级生成锚点', async () => {
    const html = await renderBody('# 说明\n\n## 用法\n\n### 细节\n', opts({ toc: true }))
    expect(html).toContain('<nav class="mdf-toc"')
    expect(html).toContain('href="#说明"')
    expect(html).toContain('href="#细节"')
    expect(html).toContain('class="mdf-toc-item level-3"')
    expect(html.indexOf('<nav')).toBeLessThan(html.indexOf('<h1'))
  })

  it('重复标题的计数与 rehype-slug 一致', async () => {
    const html = await renderBody('# 用法\n\n# 用法\n', opts({ toc: true }))
    expect(html).toContain('href="#用法"')
    expect(html).toContain('href="#用法-1"')
  })

  it('没有标题时不生成空目录', async () => {
    expect(await renderBody('只有正文\n', opts({ toc: true }))).not.toContain('mdf-toc')
  })
})

describe('图片宽度还原', () => {
  it('title 里的宽度提示变成 width 属性', async () => {
    const html = await renderBody('![说明](a.png "w=640")\n')
    expect(html).toContain('width="640"')
    expect(html).not.toContain('w=640')
    expect(html).not.toContain('title=')
  })

  it('保留用户自己写的说明文字', async () => {
    const html = await renderBody('![说明](a.png "看图 w=320")\n')
    expect(html).toContain('width="320"')
    expect(html).toContain('title="看图"')
  })

  it('没有宽度提示的 title 原样留着', async () => {
    const html = await renderBody('![说明](a.png "只是说明")\n')
    expect(html).toContain('title="只是说明"')
    expect(html).not.toContain('width=')
  })
})

describe('主题与纸张', () => {
  it('主题、纸张与页边距写进样式', async () => {
    const html = await buildHtml('# A\n', 'A', opts({ theme: 'serif', paper: 'Letter', margin: 'narrow' }))
    expect(html).toContain('@page { size: letter; margin: 12mm; }')
    expect(html).toContain('Georgia')
    expect(html).not.toContain('-apple-system')
  })

  it('朴素主题不带装饰底色', async () => {
    const html = await buildHtml('# A\n', 'A', opts({ theme: 'plain' }))
    expect(html).toContain('code { background: #f0f0f0; }')
    expect(html).not.toContain('Georgia')
  })

  it('默认主题保持原排版', async () => {
    const html = await buildHtml('# A\n', 'A', opts())
    expect(html).toContain('@page { size: A4; margin: 20mm; }')
    expect(html).toContain('-apple-system')
    expect(html).toContain('.mdf-doc')
    expect(html).toContain('<title>A</title>')
  })

  it('深色主题与应用界面同一套色阶', async () => {
    const html = await buildHtml('# A\n', 'A', opts({ theme: 'dark' }))
    expect(html).toContain('color-scheme: dark')
    expect(html).toContain('html { background: #1b1d1f; }')
    expect(html).toContain('body { color: #d7dbde;')
    expect(html).toContain('.hljs-keyword, .hljs-selector-tag, .hljs-built_in { color: #ff7b72; }')
  })

  it('dark 与 mdmdt 都是合法导出主题，未知值回落默认', () => {
    expect(normalizeExportOptions({ theme: 'dark' }).theme).toBe('dark')
    expect(normalizeExportOptions({ theme: 'mdmdt' }).theme).toBe('mdmdt')
    expect(normalizeExportOptions({ theme: 'neon' }).theme).toBe('default')
  })

  it('mdmdt 导出主题带雅黑正文与蓝色引用块', async () => {
    const html = await buildHtml('# A\n', 'A', opts({ theme: 'mdmdt' }))
    expect(html).toContain("'Microsoft YaHei UI'")
    expect(html).toContain('background: rgba(62, 105, 215, 0.06)')
    expect(html).toContain('letter-spacing: 2px')
  })
})

describe('纯文本导出', () => {
  it('去掉标记，保留列表与代码内容', async () => {
    const text = await renderText(
      '# 标题\n\n段落 **粗** 与 [链接](a.md)\n\n- 甲\n- 乙\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nconst x = 1\n```\n'
    )
    expect(text).toContain('标题')
    expect(text).toContain('段落 粗 与 链接')
    expect(text).toContain('- 甲')
    expect(text).toContain('- 乙')
    expect(text).toContain('const x = 1')
    expect(text).toContain('A')
    expect(text).not.toContain('**')
    expect(text).not.toContain('](a.md)')
    expect(text).not.toMatch(/\n{3,}/)
  })

  it('front matter 不进正文', async () => {
    expect(await renderText('---\ntitle: X\n---\n\n正文\n')).toBe('正文')
  })

  it('图片退化成替代文字', async () => {
    expect(await renderText('![流程图](a.png)\n')).toBe('流程图')
  })
})
