import { describe, expect, it } from 'vitest'
import { buildDocx } from '../src/renderer/src/export/docx'
import { buildOpml } from '../src/renderer/src/export/opml'

const SAMPLE = [
  '---',
  'title: 示例',
  '---',
  '',
  '# 一级标题',
  '',
  '普通段落，含 **加粗**、*斜体* 与 `代码`，还有 [链接](https://example.com)。',
  '',
  '- 无序一',
  '- [x] 任务完成',
  '',
  '1. 有序一',
  '2. 有序二',
  '',
  '> 引用一行',
  '',
  '```js',
  'const a = 1',
  '```',
  '',
  '| A | B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '![图](assets/pic.png "w=320")',
  '',
  '---',
  ''
].join('\n')

describe('DOCX 正文构建', () => {
  it('标题、强调、代码、表格与列表都产出对应标记', async () => {
    const { bodyXml } = await buildDocx(SAMPLE, 'C:\\notes\\a.md')
    expect(bodyXml).toContain('<w:pStyle w:val="Heading1"/>')
    expect(bodyXml).toContain('<w:b/>')
    expect(bodyXml).toContain('<w:i/>')
    expect(bodyXml).toContain('CodeBlock')
    expect(bodyXml).toContain('<w:tbl>')
    expect(bodyXml).toContain('<w:numId w:val="1"/>')
    expect(bodyXml).toContain('<w:numId w:val="2"/>')
    expect(bodyXml).toContain('☑')
    expect(bodyXml).toContain('<w:pStyle w:val="Quote"/>')
  })

  it('超链接与图片登记进关系清单，图片留占位注释', async () => {
    const { links, images, bodyXml } = await buildDocx(SAMPLE, 'C:\\notes\\a.md')
    expect(links).toHaveLength(1)
    expect(links[0].target).toBe('https://example.com')
    expect(bodyXml).toContain(`<w:hyperlink r:id="${links[0].id}">`)
    expect(images).toHaveLength(1)
    expect(images[0].widthPx).toBe(320)
    expect(bodyXml).toContain(`<!--mdfimg:${images[0].id}-->`)
    expect(images[0].path.replace(/\\/g, '/')).toBe('C:/notes/assets/pic.png')
  })

  it('XML 特殊字符被转义', async () => {
    const { bodyXml } = await buildDocx('5 < 6 & "引号"', null)
    expect(bodyXml).toContain('5 &lt; 6 &amp; &quot;引号&quot;')
    expect(bodyXml).not.toContain('5 < 6')
  })

  it('未保存文档的图片退化成 alt 文字', async () => {
    const { images, bodyXml } = await buildDocx('![示意图](pic.png)', null)
    expect(images).toHaveLength(0)
    expect(bodyXml).toContain('[图片：示意图]')
  })

  it('公式在无 DOM 环境（单测）退回源码文本，内容不丢', async () => {
    const { bodyXml } = await buildDocx('行内 $a^2$ 公式\n\n$$\nx = 1\n$$\n', null)
    expect(bodyXml).toContain('$a^2$')
    expect(bodyXml).toContain('$$x = 1$$')
    expect(bodyXml).toContain('<w:jc w:val="center"/>')
  })

  it('mermaid 围栏在无 DOM 环境退回代码块', async () => {
    const { bodyXml, images } = await buildDocx('```mermaid\ngraph TD; A-->B;\n```\n', null)
    expect(images).toHaveLength(0)
    expect(bodyXml).toContain('graph TD; A--&gt;B;')
  })
})

describe('OPML 大纲', () => {
  it('标题成层级，段落/列表/代码成为叶子，代码内容进 _note', () => {
    const opml = buildOpml(
      ['# 顶层', '开头段落', '## 小节', '- 条目一', '- 条目二', '## 另起', '```', 'code line', '```'].join('\n'),
      '示例'
    )
    expect(opml).toContain('<opml version="2.0">')
    expect(opml).toContain('<title>示例</title>')
    const top = opml.indexOf('text="顶层"')
    const section = opml.indexOf('text="小节"')
    const section2 = opml.indexOf('text="另起"')
    expect(top).toBeGreaterThan(-1)
    expect(section).toBeGreaterThan(top)
    expect(section2).toBeGreaterThan(section)
    expect(opml).toContain('text="条目一"')
    expect(opml).toContain('_note="code line"')
  })

  it('特殊字符与换行按属性转义', () => {
    const opml = buildOpml('段落里 <带> & 符号 "引号"\n\n第二行也进来', 'a & b')
    expect(opml).toContain('&lt;带&gt; &amp; 符号 &quot;引号&quot;')
    expect(opml).toContain('<title>a &amp; b</title>')
  })

  it('空文档也有合法外壳', () => {
    const opml = buildOpml('', '未命名')
    expect(opml).toContain('（空文档）')
  })
})
