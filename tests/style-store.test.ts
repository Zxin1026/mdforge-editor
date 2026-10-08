import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { STYLE_NAME_MAX } from '../src/shared/ipc'
import {
  deleteStyle,
  initStyleStore,
  listStyles,
  parseImportedStyle,
  sanitizeStyleName,
  saveStyle,
  styleProblem,
  uniqueStyleName
} from '../src/main/fs/style-store'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mdforge-style-'))
  initStyleStore(dir)
})

describe('名称清洗', () => {
  it('去掉控制字符与多余空白并限量', () => {
    expect(sanitizeStyleName('  夜航\u0000星  \n 主题 ', '兜底')).toBe('夜航 星 主题')
    expect(sanitizeStyleName('x'.repeat(80), '兜底')).toHaveLength(STYLE_NAME_MAX)
  })

  it('空名用兜底名', () => {
    expect(sanitizeStyleName('   ', '自定义主题')).toBe('自定义主题')
  })

  it('重名加序号且不超长', () => {
    expect(uniqueStyleName('红', ['红'])).toBe('红 2')
    expect(uniqueStyleName('红', ['红', '红 2'])).toBe('红 3')
    expect(uniqueStyleName('红', [])).toBe('红')
    const long = 'x'.repeat(STYLE_NAME_MAX)
    expect(uniqueStyleName(long, [long]).length).toBeLessThanOrEqual(STYLE_NAME_MAX)
  })
})

describe('内容校验', () => {
  it('空内容与超量被拦下', () => {
    expect(styleProblem('theme', '   ')).toContain('不能为空')
    expect(styleProblem('theme', 'a'.repeat(600 * 1024))).toContain('过大')
  })

  it('模板必须有 {{content}} 占位符', () => {
    expect(styleProblem('template', '<html>{{title}}</html>')).toContain('{{content}}')
    expect(styleProblem('template', '<html>{{content}}</html>')).toBeNull()
    expect(styleProblem('theme', 'body { color: red; }')).toBeNull()
  })
})

describe('导入解析', () => {
  it('css 文件用文件名当主题名', () => {
    const parsed = parseImportedStyle('theme', 'E:\\主题\\夜航星.css', 'body { color: red; }')
    expect(parsed.name).toBe('夜航星')
    expect(parsed.content).toContain('color: red')
  })

  it('json 认 {name, css} 与 {name, html}', () => {
    expect(parseImportedStyle('theme', 'a.json', '{"name":"蓝调","css":"body{}"}')).toEqual({
      name: '蓝调',
      content: 'body{}'
    })
    expect(parseImportedStyle('template', 'b.json', '{"name":"壳","html":"<b>{{content}}</b>"}')).toEqual({
      name: '壳',
      content: '<b>{{content}}</b>'
    })
  })

  it('json 缺字段或坏了都会报错', () => {
    expect(() => parseImportedStyle('theme', 'a.json', '{"name":"只有名字"}')).toThrow('css')
    expect(() => parseImportedStyle('template', 'a.json', '{"name":"x","css":"y"}')).toThrow('html')
    expect(() => parseImportedStyle('theme', 'a.json', '不是 json')).toThrow('JSON')
  })
})

describe('主题与模板存取', () => {
  it('新建后能列出，内容原样保存', async () => {
    const saved = await saveStyle({ kind: 'theme', id: null, name: '夜航星', content: 'body { color: #123; }' })
    expect(saved.id).toMatch(/^[a-z0-9][a-z0-9-]*$/)
    const library = await listStyles()
    expect(library.themes).toHaveLength(1)
    expect(library.themes[0].name).toBe('夜航星')
    expect(library.themes[0].css).toBe('body { color: #123; }')
  })

  it('重名自动加序号', async () => {
    await saveStyle({ kind: 'theme', id: null, name: '同名', content: 'a{}' })
    const second = await saveStyle({ kind: 'theme', id: null, name: '同名', content: 'b{}' })
    const library = second.library
    expect(library.themes.map((theme) => theme.name)).toEqual(['同名', '同名 2'])
  })

  it('带 id 保存是覆盖而不是新建，改名字不会给自己加序号', async () => {
    const first = await saveStyle({ kind: 'theme', id: null, name: '旧名', content: 'a{}' })
    const saved = await saveStyle({ kind: 'theme', id: first.id, name: '旧名', content: 'b{}' })
    expect(saved.library.themes).toHaveLength(1)
    expect(saved.library.themes[0].css).toBe('b{}')
  })

  it('编辑不存在的条目会报错', async () => {
    await expect(saveStyle({ kind: 'theme', id: 'abcde', name: 'x', content: 'a{}' })).rejects.toThrow('不在了')
  })

  it('模板缺占位符保存不了', async () => {
    await expect(saveStyle({ kind: 'template', id: null, name: '壳', content: '<html></html>' })).rejects.toThrow(
      '{{content}}'
    )
  })

  it('两类条目互不串门，删除只动自己', async () => {
    await saveStyle({ kind: 'theme', id: null, name: '主题', content: 'a{}' })
    const tpl = await saveStyle({ kind: 'template', id: null, name: '模板', content: '<b>{{content}}</b>' })
    const library = await deleteStyle('template', tpl.id)
    expect(library.templates).toHaveLength(0)
    expect(library.themes).toHaveLength(1)
  })

  it('主题与模板各存各的目录，中文名不落成文件名', async () => {
    const saved = await saveStyle({ kind: 'theme', id: null, name: '中文名字', content: 'a{}' })
    expect(saved.id).not.toContain('中文')
  })
})
