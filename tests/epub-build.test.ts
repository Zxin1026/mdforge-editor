import { describe, expect, it } from 'vitest'
import { buildEpubEntries, chapterDocument, toXhtml } from '../src/main/fs/epub-build'
import { createZip, readZip } from '../src/main/fs/zip'

describe('HTML → XHTML', () => {
  it('空元素补自闭合', () => {
    expect(toXhtml('<p><img src="a.png" alt="图"><br>文字</p>')).toBe('<p><img src="a.png" alt="图"/><br/>文字</p>')
    expect(toXhtml('<hr>')).toBe('<hr/>')
    expect(toXhtml('<input type="checkbox" checked>')).toBe('<input type="checkbox" checked/>')
  })

  it('命名实体换成 XML 认得的写法', () => {
    expect(toXhtml('a&nbsp;b&mdash;c')).toBe('a&#160;b&#8212;c')
    expect(toXhtml('&amp; &lt; &gt; &quot;')).toBe('&amp; &lt; &gt; &quot;')
    // 不认识的实体转义成文本，保证 XML 可解析
    expect(toXhtml('&unknown;')).toBe('&amp;unknown;')
  })
})

describe('EPUB 章节文档', () => {
  it('包成 XHTML 并挂上样式表', () => {
    const doc = chapterDocument({ title: '第一章 & 起', body: '<p>正文</p>' }, 'zh-CN')
    expect(doc).toContain('<?xml version="1.0" encoding="utf-8"?>')
    expect(doc).toContain('xmlns="http://www.w3.org/1999/xhtml"')
    expect(doc).toContain('<title>第一章 &amp; 起</title>')
    expect(doc).toContain('epub:type="chapter"')
    expect(doc).toContain('href="style.css"')
  })
})

describe('EPUB 打包清单', () => {
  const entries = buildEpubEntries({
    title: '我的手记',
    author: '张三',
    css: 'body { color: #000; }',
    chapters: [
      { title: '开始', body: '<p>第一章正文</p>' },
      { title: '', body: '<p>第二章正文</p>' }
    ]
  })

  it('结构完整：mimetype 第一、OPF/导航/样式/章节都在', () => {
    expect(entries[0]).toMatchObject({ name: 'mimetype', store: true })
    const names = entries.map((entry) => entry.name)
    expect(names).toEqual([
      'mimetype',
      'META-INF/container.xml',
      'OEBPS/content.opf',
      'OEBPS/nav.xhtml',
      'OEBPS/style.css',
      'OEBPS/chapter-1.xhtml',
      'OEBPS/chapter-2.xhtml'
    ])
  })

  it('OPF 里有书名、作者与 spine 顺序', () => {
    const opf = entries.find((entry) => entry.name === 'OEBPS/content.opf')!.data.toString('utf8')
    expect(opf).toContain('<dc:title>我的手记</dc:title>')
    expect(opf).toContain('<dc:creator>张三</dc:creator>')
    expect(opf).toContain('properties="nav"')
    expect(opf.indexOf('idref="chapter-1"')).toBeLessThan(opf.indexOf('idref="chapter-2"'))
  })

  it('导航页列出章节，无标题章节给默认名', () => {
    const nav = entries.find((entry) => entry.name === 'OEBPS/nav.xhtml')!.data.toString('utf8')
    expect(nav).toContain('>开始</a>')
    expect(nav).toContain('>第 2 章</a>')
    expect(nav).toContain('chapter-2.xhtml')
  })

  it('打包成 zip 后能原样读回', () => {
    const zip = createZip(entries)
    const back = readZip(zip)
    const mimetype = back.find((entry) => entry.name === 'mimetype')!
    expect(mimetype.data.toString('ascii')).toBe('application/epub+zip')
    const chapter = back.find((entry) => entry.name === 'OEBPS/chapter-2.xhtml')!
    expect(chapter.data.toString('utf8')).toContain('<p>第二章正文</p>')
  })
})
