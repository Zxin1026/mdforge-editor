import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdownLanguageExtension } from '../src/renderer/src/editor/markdown'
import {
  activeIndex,
  collectOutline,
  headingTitle,
  outlineGuides,
  type OutlineItem
} from '../src/renderer/src/editor/outline'

function stateWith(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdownLanguageExtension] })
}

const DOC = [
  '# 一级',
  '',
  '## 5.1 输入模型',
  '',
  '### **重点** 内容',
  '',
  '## [文档](a.md)',
  '',
  '# 一级',
  '',
  '正文',
  '====',
  ''
].join('\n')

describe('大纲收集', () => {
  it('层级、文本、位置与锚点', () => {
    const items = collectOutline(stateWith(DOC))
    expect(items.map((item) => item.level)).toEqual([1, 2, 3, 2, 1, 1])
    expect(items.map((item) => item.text)).toEqual(['一级', '5.1 输入模型', '重点 内容', '文档', '一级', '正文'])
    expect(items[1].pos).toBe(DOC.indexOf('## 5.1 输入模型'))
    expect(items[1].line).toBe(3)
  })

  it('锚点与导出一致：去标点、重复标题加序号', () => {
    const anchors = collectOutline(stateWith(DOC)).map((item) => item.anchor)
    expect(anchors).toEqual(['一级', '51-输入模型', '重点-内容', '文档', '一级-1', '正文'])
  })

  it('Setext 标题也进大纲', () => {
    const items = collectOutline(stateWith('标题\n====\n\n内容\n'))
    expect(items).toHaveLength(1)
    expect(items[0].level).toBe(1)
  })

  it('front matter 的 YAML 不算标题（收尾 --- 会被当成 setext 下划线）', () => {
    const items = collectOutline(stateWith('---\ntitle: 手册\n---\n\n# 正文\n'))
    expect(items.map((item) => item.text)).toEqual(['正文'])
  })

  it('没有配对收尾时照常收集标题', () => {
    const items = collectOutline(stateWith('---\n标题\n====\n\n内容\n'))
    expect(items.map((item) => item.text)).toEqual(['标题'])
  })

  it('空文档没有大纲', () => {
    expect(collectOutline(stateWith(''))).toEqual([])
  })
})

describe('标题文本清洗', () => {
  it('去掉闭合式 #、强调标记与链接语法', () => {
    expect(headingTitle('#### 标题 ####')).toBe('标题')
    expect(headingTitle('## **粗** 和 `码`')).toBe('粗 和 码')
    expect(headingTitle('# [说明](docs/a.md) 结尾')).toBe('说明 结尾')
    expect(headingTitle('# ![图](a.png) 图片标题')).toBe('图 图片标题')
  })
})

describe('当前标题判定', () => {
  const items = collectOutline(stateWith(DOC))

  it('光标在两个标题之间时归属上一个', () => {
    expect(activeIndex(items, 1)).toBe(0)
    expect(activeIndex(items, 4)).toBe(1)
    expect(activeIndex(items, 12)).toBe(5)
  })

  it('光标在首个标题之前返回 -1', () => {
    expect(activeIndex(items, 0)).toBe(-1)
  })
})

describe('outlineGuides 树形引导线', () => {
  const item = (level: number): OutlineItem => ({ level, text: '', pos: 0, line: 0, anchor: '' })

  it('祖先还有后续同级时竖线延续，末尾同级折角收尾', () => {
    // 结构：H1 / 一、案例(b,c) / 二、小节(d) / H1
    const items = [item(1), item(2), item(3), item(3), item(2), item(3), item(1)]
    const guides = outlineGuides(items)
    // 第一个 H1 后面还有 H1：L1 竖线继续
    expect(guides[0]).toEqual({ spans: [], last: false })
    // 一、的下一行有 L1 竖线（根还续）、自己不是末子（还有 二、）
    expect(guides[1].spans).toEqual([true])
    expect(guides[1].last).toBe(false)
    // 案例：L1 与 L2 两级都连；后面还有同级（任务），折角不是收尾
    expect(guides[2]).toEqual({ spans: [true, true], last: false })
    // 任务：同级最后一个，折角收尾
    expect(guides[3]).toEqual({ spans: [true, true], last: true })
    // 二、：L1 连；自己是最后一个 L2
    expect(guides[4]).toEqual({ spans: [true], last: true })
    // 小节：父级（二、）没有后续同级 → L2 竖线不画
    expect(guides[5]).toEqual({ spans: [true, false], last: true })
    // 末位 H1：没有竖线
    expect(guides[6]).toEqual({ spans: [], last: true })
  })

  it('文档从二级标题开始时，缺位的祖先不画线', () => {
    const items = [item(2), item(3), item(2)]
    const guides = outlineGuides(items)
    expect(guides[0].spans).toEqual([false])
    expect(guides[1].spans).toEqual([false, true])
  })
})
