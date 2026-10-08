import { describe, expect, it } from 'vitest'
import { DOC_TEMPLATES, renderTemplate } from '../src/renderer/src/doc-templates'
import { aggregateTags, docsForTag, filterTags } from '../src/renderer/src/side/tags-logic'

describe('文档模板', () => {
  it('id 唯一、字段齐全', () => {
    const ids = new Set(DOC_TEMPLATES.map((template) => template.id))
    expect(ids.size).toBe(DOC_TEMPLATES.length)
    for (const template of DOC_TEMPLATES) {
      expect(template.name).not.toBe('')
      expect(template.description).not.toBe('')
      expect(template.body.length).toBeGreaterThan(20)
    }
  })

  it('日期与时间占位符按本地时区替换', () => {
    const template = DOC_TEMPLATES.find((item) => item.id === 'meeting')!
    const rendered = renderTemplate(template, new Date(2026, 9, 8, 9, 5))
    expect(rendered).toContain('2026-10-08 09:05')
    expect(rendered).not.toContain('{{date}}')
  })
})

describe('标签聚合', () => {
  const docs = [
    { path: 'a.md', name: 'a.md', tags: ['笔记', '教程'] },
    { path: 'b.md', name: 'b.md', tags: ['笔记'] },
    { path: 'c.md', name: 'c.md', tags: ['note'] },
    { path: '子/d.md', name: 'd.md', tags: ['笔记', 'Note'] }
  ]

  it('计数按次数降序，大小写合并且显示先出现的写法', () => {
    const tags = aggregateTags(docs)
    expect(tags[0]).toEqual({ tag: '笔记', count: 3 })
    const note = tags.find((item) => item.tag.toLowerCase() === 'note')!
    expect(note.tag).toBe('note')
    expect(note.count).toBe(2)
  })

  it('按标签筛选文档不区分大小写', () => {
    expect(docsForTag(docs, 'NOTE').map((doc) => doc.name).sort()).toEqual(['c.md', 'd.md'])
    expect(docsForTag(docs, null)).toEqual([])
  })

  it('标签名过滤按子串匹配', () => {
    const tags = aggregateTags(docs)
    expect(filterTags(tags, '笔').map((item) => item.tag)).toEqual(['笔记'])
    expect(filterTags(tags, '')).toHaveLength(tags.length)
  })
})
