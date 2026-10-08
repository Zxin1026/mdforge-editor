import { describe, expect, it } from 'vitest'
import {
  buildFrontMatter,
  entryList,
  entryValue,
  parseFrontMatter,
  readFields,
  splitList
} from '../src/shared/frontmatter-yaml'

const SAMPLE = [
  '# 这是注释',
  'title: 我的笔记',
  'author: "张三"',
  'tags: [笔记, 教程]',
  'summary: 一句话摘要',
  'cover: assets/cover.png',
  'custom:',
  '  nested: true',
  '  keep: 1'
].join('\n')

describe('front matter 解析', () => {
  it('前导注释进 preamble，未知字段整块保留', () => {
    const model = parseFrontMatter(SAMPLE)
    expect(model.preamble).toEqual(['# 这是注释'])
    expect(model.entries.map((entry) => entry.key)).toEqual(['title', 'author', 'tags', 'summary', 'cover', 'custom'])
    const custom = model.entries.find((entry) => entry.key === 'custom')!
    expect(custom.lines).toEqual(['custom:', '  nested: true', '  keep: 1'])
  })

  it('标量剥引号，列表与块标量各归其位', () => {
    const model = parseFrontMatter(SAMPLE)
    const byKey = new Map(model.entries.map((entry) => [entry.key, entry]))
    expect(entryValue(byKey.get('title')!)).toBe('我的笔记')
    expect(entryValue(byKey.get('author')!)).toBe('张三')
    expect(entryValue(byKey.get('tags')!)).toBe('笔记, 教程')
    expect(entryList(byKey.get('cover')!)).toBeNull()
  })

  it('块列表与块标量', () => {
    const block = ['tags:', '  - a', '  - "b b"', 'desc: |', '  第一行', '  第二行'].join('\n')
    const model = parseFrontMatter(block)
    expect(entryValue(model.entries[0])).toBe('a, b b')
    expect(entryValue(model.entries[1])).toBe('第一行\n第二行')
  })

  it('readFields 按别名取值', () => {
    const values = readFields(parseFrontMatter(SAMPLE))
    expect(values.title).toBe('我的笔记')
    expect(values.author).toBe('张三')
    expect(values.tags).toBe('笔记, 教程')
    // summary 命中 description 的别名
    expect(values.description).toBe('一句话摘要')
    expect(values.date).toBe('')
  })
})

describe('front matter 生成', () => {
  it('已知字段按顺序排在前面，未知字段与注释原样保留', () => {
    const model = parseFrontMatter(SAMPLE)
    const yaml = buildFrontMatter(model, {
      title: '新标题',
      author: '李四',
      date: '2026-10-08',
      tags: '一, 二',
      description: '新摘要'
    })
    expect(yaml).toBe(
      [
        '# 这是注释',
        '',
        'title: 新标题',
        'author: 李四',
        'date: 2026-10-08',
        'tags: [一, 二]',
        'summary: 新摘要',
        'cover: assets/cover.png',
        'custom:',
        '  nested: true',
        '  keep: 1'
      ].join('\n')
    )
  })

  it('清空字段等于删除该字段，未知字段继续保留', () => {
    const model = parseFrontMatter(SAMPLE)
    const yaml = buildFrontMatter(model, { title: '', author: '', date: '', tags: '', description: '' })
    expect(yaml).not.toContain('title:')
    expect(yaml).not.toContain('author:')
    expect(yaml).toContain('cover: assets/cover.png')
    expect(yaml).toContain('custom:')
  })

  it('需要引号的值自动加引号（含冒号等特殊字符），表单值首尾空白会被去掉', () => {
    const model = parseFrontMatter('')
    const yaml = buildFrontMatter(model, {
      title: 'a: b',
      author: '  空格  ',
      date: '',
      tags: 'a, b: c',
      description: ''
    })
    expect(yaml).toContain('title: "a: b"')
    expect(yaml).toContain('author: 空格')
    expect(yaml).toContain('tags: [a, "b: c"]')
  })

  it('沿用原文命中的键名（authors）', () => {
    const model = parseFrontMatter('authors: 甲')
    const yaml = buildFrontMatter(model, { title: '', author: '乙', date: '', tags: '', description: '' })
    expect(yaml).toBe('authors: 乙')
  })

  it('生成后再解析得到同一组表单值', () => {
    const model = parseFrontMatter(SAMPLE)
    const values = {
      title: '带: 冒号',
      author: '张三',
      date: '2026-10-08',
      tags: 'x, y y',
      description: '多行\n摘要'
    }
    const again = readFields(parseFrontMatter(buildFrontMatter(model, values)))
    expect(again).toEqual(values)
  })
})

describe('splitList', () => {
  it('逗号、中文逗号与分号都能切', () => {
    expect(splitList('a, b；c，d')).toEqual(['a', 'b', 'c', 'd'])
    expect(splitList('  ')).toEqual([])
  })
})
