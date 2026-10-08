import { describe, expect, it } from 'vitest'
import { DEFAULT_EXPORT_OPTIONS } from '../src/shared/ipc'
import { buildIndexHtml, buildSitePlan, htmlRelativeOf, type SearchEntry } from '../src/renderer/src/export/site'
import { siteHref } from '../src/renderer/src/export/hast'
import { resolvePath } from '../src/renderer/src/paths'

const ROOT = 'C:/notes'
const DOCS = [
  {
    path: 'C:/notes/index.md',
    text: [
      '---',
      'title: 首页',
      'author: 张三',
      '---',
      '',
      '# 欢迎',
      '',
      '看 [子页](sub/child.md) 和 [锚点](sub/child.md#细节)，还有 [外部](https://example.com)。',
      '',
      '![图](assets/a.png)'
    ].join('\n')
  },
  {
    path: 'C:/notes/sub/child.md',
    text: '# 子页\n\n细节在这里。回到 [首页](../index.md)。\n\n[未知](missing.md)\n\n![图](../assets/a.png)'
  }
]

describe('站点页面计划', () => {
  it('html 相对路径：换扩展名、保留目录结构', () => {
    expect(htmlRelativeOf('a.md')).toBe('a.html')
    expect(htmlRelativeOf('sub/note.markdown')).toBe('sub/note.html')
    expect(htmlRelativeOf('readme.txt')).toBe('readme.html')
  })

  it('生成页面、站内链接改写为 html，图与外部链接不动', async () => {
    const plan = await buildSitePlan({ root: ROOT, docs: DOCS, options: DEFAULT_EXPORT_OPTIONS, site: true })
    expect(plan.files.map((file) => file.relative).sort()).toEqual(['index.html', 'sub/child.html'])

    const home = plan.files.find((file) => file.relative === 'index.html')!.html
    expect(home).toContain('href="sub/child.html"')
    // 序列化时 URL 会做百分号编码，锚点里的中文以 % 形式出现（浏览器仍会解码后匹配）
    expect(home).toContain('href="sub/child.html#%E7%BB%86%E8%8A%82"')
    expect(home).toContain('href="https://example.com"')
    expect(home).toContain('src="assets/a.png"')
    expect(home).toContain('<title>首页</title>')
    expect(home).toContain('href="index.html"') // 页首"返回目录"

    const child = plan.files.find((file) => file.relative === 'sub/child.html')!.html
    expect(child).toContain('href="../index.html"')
    // 指向不存在文档的链接保持原样
    expect(child).toContain('href="missing.md"')
    expect(child).toContain('src="../assets/a.png"')
    expect(child).toContain('<title>子页</title>')
  })

  it('附加文件：导航页 + 搜索索引', async () => {
    const plan = await buildSitePlan({ root: ROOT, docs: DOCS, options: DEFAULT_EXPORT_OPTIONS, site: true })
    expect(plan.extras.map((extra) => extra.relative)).toEqual(['index.html', 'search-index.json'])
    const index = plan.extras[0].content
    expect(index).toContain('href="index.html"')
    expect(index).toContain('href="sub/child.html"')
    expect(index).toContain('window.__MDF_INDEX__=')
    expect(index).toContain('mdf-q')
    const data = JSON.parse(plan.extras[1].content) as { docs: SearchEntry[] }
    expect(data.docs.map((entry) => entry.path)).toEqual(['index.html', 'sub/child.html'])
    expect(data.docs[0].title).toBe('首页')
    expect(data.docs[1].text).toContain('细节在这里')
  })

  it('纯批量导出不带导航页', async () => {
    const plan = await buildSitePlan({ root: ROOT, docs: DOCS, options: DEFAULT_EXPORT_OPTIONS, site: false })
    expect(plan.extras).toEqual([])
    const home = plan.files[0].html
    expect(home).not.toContain('<nav class="mdf-site-nav"')
    // 站内链接仍要改写，页面之间才走得通
    expect(home).toContain('href="sub/child.html"')
  })
})

describe('siteHref 细节', () => {
  const context = {
    pagePath: 'sub/child.html',
    docDir: 'C:/notes/sub',
    map: new Map([['c:/notes/index.md', 'index.html']]),
    resolve: resolvePath
  }

  it('锚点、外部地址与映射外目标保持原样', () => {
    expect(siteHref('#x', context)).toBeNull()
    expect(siteHref('https://a.b/c', context)).toBeNull()
    expect(siteHref('mailto:a@b.c', context)).toBeNull()
    expect(siteHref('other.md', context)).toBeNull()
    expect(siteHref('', context)).toBeNull()
  })

  it('命中映射时返回相对链接并保留锚点', () => {
    expect(siteHref('../index.md', context)).toBe('../index.html')
    expect(siteHref('../index.md#top', context)).toBe('../index.html#top')
  })

  it('空格与中文路径会做百分号编码', () => {
    const spaced = { ...context, map: new Map([['c:/notes/my note.md', 'my note.html']]) }
    expect(siteHref('../my note.md', spaced)).toBe('../my%20note.html')
  })
})

describe('导航页生成', () => {
  it('按目录分组并转义标题', () => {
    const html = buildIndexHtml({
      title: '笔记 <集>',
      entries: [
        { htmlRel: 'a.html', rel: 'a.md', title: 'A & B' },
        { htmlRel: 'sub/b.html', rel: 'sub/b.md', title: '子页' }
      ],
      options: DEFAULT_EXPORT_OPTIONS,
      search: []
    })
    expect(html).toContain('笔记 &lt;集&gt;')
    expect(html).toContain('A &amp; B')
    expect(html).toContain('根目录')
    expect(html).toContain('sub')
  })
})
