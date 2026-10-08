import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_EXPORT_OPTIONS,
  customRefOf,
  normalizeExportOptions,
  type ExportOptions,
  type CustomStyleLibrary
} from '../src/shared/ipc'
import { cssFor } from '../src/renderer/src/export/export-css'
import { buildDocHtml } from '../src/renderer/src/export/html'
import { applyTemplate, BUILTIN_TEMPLATE_HTML, templateProblem } from '../src/renderer/src/export/page-template'
import {
  cssForRef,
  setStyleLibrary,
  templateHtmlForRef,
  themeRefExists,
  templateRefExists
} from '../src/renderer/src/export/style-lib'

const opts = (patch: Partial<ExportOptions> = {}): ExportOptions => ({ ...DEFAULT_EXPORT_OPTIONS, ...patch })

function library(
  themes: CustomStyleLibrary['themes'],
  templates: CustomStyleLibrary['templates'] = []
): CustomStyleLibrary {
  return { themes, templates }
}

beforeEach(() => {
  setStyleLibrary({ themes: [], templates: [] })
})

describe('导出选项校验（自定义引用）', () => {
  it('custom:<id> 引用保留，坏值回落', () => {
    expect(normalizeExportOptions({ theme: 'custom:abc123' }).theme).toBe('custom:abc123')
    expect(normalizeExportOptions({ theme: 'custom:中文' }).theme).toBe('default')
    expect(normalizeExportOptions({ theme: 'neon' }).theme).toBe('default')
    expect(normalizeExportOptions({ theme: 'custom:' }).theme).toBe('default')
  })

  it('代码高亮主题按白名单校验', () => {
    expect(normalizeExportOptions({ highlight: 'monokai' }).highlight).toBe('monokai')
    expect(normalizeExportOptions({ highlight: '没这个' }).highlight).toBe('auto')
    expect(DEFAULT_EXPORT_OPTIONS.highlight).toBe('auto')
  })

  it('页面模板引用校验与主题同一套规则', () => {
    expect(normalizeExportOptions({ template: 'custom:tpl1' }).template).toBe('custom:tpl1')
    expect(normalizeExportOptions({ template: 'mine' }).template).toBe('builtin')
    expect(normalizeExportOptions({ template: 'builtin' }).template).toBe('builtin')
  })
})

describe('自定义主题 CSS', () => {
  it('custom 引用取注册表里的 CSS，排在基础样式之后', async () => {
    setStyleLibrary(library([{ id: 'star1', name: '夜航星', css: 'body { background: #010b2e; }' }]))
    const html = await buildDocHtml('# A\n', 'A', opts({ theme: customRefOf('star1') }))
    expect(html).toContain('body { background: #010b2e; }')
    expect(html.indexOf('.mdf-doc {')).toBeLessThan(html.indexOf('#010b2e'))
  })

  it('条目被删后回落默认主题而不是空白', () => {
    const css = cssForRef(customRefOf('gone'), 'auto')
    expect(css).toContain('-apple-system')
  })

  it('themeRefExists 能区分内置与失效的自定义引用', () => {
    expect(themeRefExists('default')).toBe(true)
    expect(themeRefExists(customRefOf('gone'))).toBe(false)
    setStyleLibrary(library([{ id: 'star1', name: '夜航星', css: 'b{}' }]))
    expect(themeRefExists(customRefOf('star1'))).toBe(true)
  })
})

describe('代码高亮主题', () => {
  it('auto 不带代码底色，跟随排版主题', () => {
    const css = cssFor('default', { highlight: 'auto' })
    expect(css).not.toContain('pre { background: #272822; }')
    expect(css).toContain('.hljs-keyword, .hljs-selector-tag, .hljs-built_in { color: #d73a49; }')
  })

  it('选了高亮主题后代码块底色与配色都换掉，并排在主题之后', () => {
    const css = cssFor('default', { highlight: 'monokai' })
    expect(css).toContain('pre { background: #272822; }')
    expect(css).toContain('.hljs-keyword, .hljs-selector-tag, .hljs-built_in { color: #f92672; }')
    expect(css.indexOf('pre { background: #272822; }')).toBeGreaterThan(css.indexOf('pre { background: #f6f7f8; }'))
  })

  it('深色高亮主题与浅色排版主题可以叠着用', async () => {
    const html = await buildDocHtml('# A\n', 'A', opts({ theme: 'mdmdt', highlight: 'github-dark' }))
    expect(html).toContain('pre { background: #0d1117; }')
    expect(html).toContain("'Microsoft YaHei UI'")
  })
})

describe('页面模板', () => {
  it('内置模板与 1.2.0 之前的输出一致', async () => {
    const html = await buildDocHtml('# A\n', 'A', opts())
    expect(html).toContain('<title>A</title>')
    expect(html).toContain('<article class="mdf-doc">')
    expect(html).toContain('@page { size: A4; margin: 20mm; }')
    expect(html.startsWith('<!doctype html>\n<html lang="zh-CN">')).toBe(true)
  })

  it('自定义模板替换占位符并保留自己的头部', async () => {
    const custom = `<html><head><title>{{title}}</title>{{style}}</head>
<body data-shell="1"><header>我的页眉</header>{{content}}<footer>{{nav}}</footer></body></html>`
    setStyleLibrary(library([], [{ id: 'tpl1', name: '带页眉', html: custom }]))
    const html = await buildDocHtml('# A\n', '标题 <X>', opts({ template: customRefOf('tpl1') }))
    expect(html).toContain('data-shell="1"')
    expect(html).toContain('我的页眉')
    expect(html).toContain('<title>标题 &lt;X&gt;</title>')
    expect(html).toContain('<article class="mdf-doc">')
    expect(html.startsWith('<!doctype html>')).toBe(false)
  })

  it('模板没写 {{style}} 时样式塞进 </head> 之前', () => {
    const html = applyTemplate('<html><head></head><body>{{content}}</body></html>', {
      title: 'T',
      lang: 'zh-CN',
      style: '<style>x{}</style>',
      nav: '',
      content: 'C'
    })
    expect(html).toContain('<style>x{}</style>\n</head>')
  })

  it('正文里的 $& 不会被替换语义吃掉', () => {
    const html = applyTemplate('<body>{{content}}</body>', {
      title: 'T',
      lang: 'zh-CN',
      style: '',
      nav: '',
      content: '价格 $& 保留'
    })
    expect(html).toContain('价格 $& 保留')
  })

  it('模板校验要求 {{content}}', () => {
    expect(templateProblem('<html>{{title}}</html>')).toContain('{{content}}')
    expect(templateProblem('   ')).toContain('不能为空')
    expect(templateProblem('<html>{{content}}</html>')).toBeNull()
  })

  it('内置模板与 templateHtmlForRef 互相兜底', () => {
    expect(templateHtmlForRef('builtin')).toBeNull()
    expect(templateHtmlForRef(customRefOf('gone'))).toBeNull()
    expect(BUILTIN_TEMPLATE_HTML).toContain('{{content}}')
    setStyleLibrary(library([], [{ id: 'tpl1', name: '壳', html: '<x>{{content}}</x>' }]))
    expect(templateHtmlForRef(customRefOf('tpl1'))).toBe('<x>{{content}}</x>')
    expect(templateRefExists(customRefOf('tpl1'))).toBe(true)
    expect(templateRefExists(customRefOf('gone'))).toBe(false)
  })
})
