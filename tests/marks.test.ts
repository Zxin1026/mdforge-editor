import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdownLanguageExtension } from '../src/renderer/src/editor/markdown'
import { frontMatterCollapsed, setFrontMatterCollapsed } from '../src/renderer/src/editor/frontmatter'
import { collectMarks, type MarkRange } from '../src/renderer/src/editor/marks'

function stateWith(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdownLanguageExtension] })
}

function hidden(ranges: MarkRange[]): MarkRange[] {
  return ranges.filter((range) => range.type === 'hide')
}

function indexOfText(doc: string, needle: string): number {
  const index = doc.indexOf(needle)
  if (index < 0) throw new Error(`测试文本中找不到 ${needle}`)
  return index
}

describe('行级装饰', () => {
  it('标题按级别加类名', () => {
    const doc = '# 一级\n\n## 二级\n'
    const ranges = collectMarks(stateWith(doc), [])
    const h1 = ranges.find((range) => range.type === 'line' && range.from === 0)
    const h2 = ranges.find((range) => range.type === 'line' && range.from === indexOfText(doc, '## 二级'))
    expect(h1?.cls).toContain('mdf-heading-1')
    expect(h2?.cls).toContain('mdf-heading-2')
  })

  it('引用块逐行加类名', () => {
    const doc = '> 第一行\n> 第二行\n\n普通段落\n'
    const ranges = collectMarks(stateWith(doc), [])
    const quoteLines = ranges.filter((range) => range.cls === 'mdf-quote-line')
    expect(quoteLines).toHaveLength(2)
    expect(quoteLines[0].from).toBe(0)
    expect(quoteLines[1].from).toBe(indexOfText(doc, '> 第二行'))
  })
})

describe('标记符隐藏', () => {
  const doc = '段落 **粗体** 结尾\n\n另一段文字\n'

  it('光标不在本行时隐藏 ** 标记', () => {
    const ranges = collectMarks(stateWith(doc), [{ from: indexOfText(doc, '另一段'), to: indexOfText(doc, '另一段') }])
    const marks = hidden(ranges)
    expect(marks.map((range) => [range.from, range.to])).toEqual([
      [indexOfText(doc, '**粗'), indexOfText(doc, '**粗') + 2],
      [indexOfText(doc, '** 结尾'), indexOfText(doc, '** 结尾') + 2]
    ])
  })

  it('光标在本行时保留标记，可以编辑', () => {
    const cursor = indexOfText(doc, '粗体') + 1
    const ranges = collectMarks(stateWith(doc), [{ from: cursor, to: cursor }])
    expect(hidden(ranges)).toEqual([])
  })

  it('多光标各自判定所在行', () => {
    const multi = '# 标题一\n\n# 标题二\n\n# 标题三\n'
    const second = indexOfText(multi, '# 标题二')
    const third = indexOfText(multi, '# 标题三')
    const ranges = collectMarks(stateWith(multi), [
      { from: 0, to: 0 },
      { from: third, to: third }
    ])
    expect(hidden(ranges).map((range) => range.from)).toEqual([second])
  })

  it('引用符在光标离开该行后隐藏', () => {
    const quote = '> 引用\n\n正文\n'
    const away = collectMarks(stateWith(quote), [{ from: indexOfText(quote, '正文'), to: indexOfText(quote, '正文') }])
    expect(hidden(away).some((range) => range.from === 0)).toBe(true)
    const inside = collectMarks(stateWith(quote), [{ from: 2, to: 2 }])
    expect(hidden(inside)).toEqual([])
  })
})

describe('内容类装饰', () => {
  it('粗体、斜体、删除线、行内代码各自加类', () => {
    const doc = '**粗** *斜* ~~删~~ `码`\n'
    const ranges = collectMarks(stateWith(doc), [{ from: 100, to: 100 }])
    const cls = ranges.filter((range) => range.type === 'mark').map((range) => range.cls)
    expect(cls).toContain('mdf-strong')
    expect(cls).toContain('mdf-em')
    expect(cls).toContain('mdf-strike')
    expect(cls).toContain('mdf-inline-code')
  })

  it('链接的文字与地址分开着色，方括号隐藏', () => {
    const doc = '看 [链接](https://example.com) 这里\n'
    const ranges = collectMarks(stateWith(doc), [{ from: 100, to: 100 }])
    const link = ranges.find((range) => range.cls === 'mdf-link')
    const url = ranges.find((range) => range.cls === 'mdf-url')
    expect(link?.from).toBe(indexOfText(doc, '[链接]'))
    expect(url?.from).toBe(indexOfText(doc, 'https://example.com'))
    expect(hidden(ranges).filter((range) => doc.slice(range.from, range.to).match(/^[[\]()!]$/))).toHaveLength(4)
  })

  it('表格竖线只弱化，不隐藏，避免列错位', () => {
    const doc = '| A | B |\n| - | - |\n| 1 | 2 |\n'
    const ranges = collectMarks(stateWith(doc), [{ from: 100, to: 100 }])
    const pipes = ranges.filter((range) => range.cls === 'mdf-pipe')
    expect(pipes.length).toBeGreaterThan(0)
    expect(hidden(ranges)).toEqual([])
  })

  it('围栏代码块的 ``` 保留可见', () => {
    const doc = '```js\nconst x = 1\n```\n'
    const ranges = collectMarks(stateWith(doc), [{ from: 100, to: 100 }])
    expect(ranges.filter((range) => range.cls === 'mdf-fence')).toHaveLength(2)
    expect(ranges.some((range) => range.cls === 'mdf-code-info')).toBe(true)
    expect(hidden(ranges)).toEqual([])
  })

  it('任务列表标记与列表符号弱化', () => {
    const doc = '- [x] 已完成\n- 未完成\n'
    const ranges = collectMarks(stateWith(doc), [{ from: 100, to: 100 }])
    expect(ranges.some((range) => range.cls === 'mdf-task-mark')).toBe(true)
    expect(ranges.filter((range) => range.cls === 'mdf-list-mark')).toHaveLength(2)
  })

  it('原始 HTML 只弱化显示，不实例化', () => {
    const doc = '<div>raw</div>\n'
    const ranges = collectMarks(stateWith(doc), [{ from: 100, to: 100 }])
    expect(ranges.some((range) => range.cls === 'mdf-raw-html')).toBe(true)
  })
})

describe('块级预览', () => {
  const DOC = 'E:/docs/a.md'
  const AWAY = [{ from: 9999, to: 9999 }]

  it('本地图片在行尾生成块级预览', () => {
    const doc = '![流程图](img/flow.png)\n\n说明文字\n'
    const ranges = collectMarks(stateWith(doc), AWAY, DOC)
    const widgets = ranges.filter((range) => range.widget === 'image')
    expect(widgets).toHaveLength(1)
    expect(widgets[0].block).toBe(true)
    expect(widgets[0].from).toBe(indexOfText(doc, '\n') + 1)
    expect(widgets[0].src).toMatch(/^mdasset:\/\/file\//)
  })

  it('远程图片不生成预览', () => {
    const doc = '![远端](https://cdn.example.com/a.png)\n'
    expect(collectMarks(stateWith(doc), AWAY, DOC).some((range) => range.widget === 'image')).toBe(false)
  })

  it('光标在图片行时不生成预览', () => {
    const doc = '![流程图](img/flow.png)\n'
    const ranges = collectMarks(stateWith(doc), [{ from: 5, to: 5 }], DOC)
    expect(ranges.some((range) => range.widget === 'image')).toBe(false)
  })

  it('任务列表方括号替换为复选框，并保留勾选状态', () => {
    const doc = '- [x] 已完成\n- [ ] 未完成\n'
    const ranges = collectMarks(stateWith(doc), AWAY, DOC)
    const tasks = ranges.filter((range) => range.widget === 'task')
    expect(tasks).toHaveLength(2)
    expect(tasks[0].checked).toBe(true)
    expect(tasks[0].to - tasks[0].from).toBe(3)
    expect(tasks[1].checked).toBe(false)
  })

  it('光标进入任务行时恢复原始 [x] 文本可编辑', () => {
    const doc = '- [x] 已完成\n'
    const ranges = collectMarks(stateWith(doc), [{ from: 3, to: 3 }], DOC)
    expect(ranges.some((range) => range.widget === 'task')).toBe(false)
  })
})

describe('输出顺序', () => {
  it('按起点升序，同起点时长的在前', () => {
    const doc = '# **粗**标题\n'
    const ranges = collectMarks(stateWith(doc), [{ from: 100, to: 100 }])
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i].from).toBeGreaterThanOrEqual(ranges[i - 1].from)
      if (ranges[i].from === ranges[i - 1].from) {
        expect(ranges[i].to).toBeLessThanOrEqual(ranges[i - 1].to)
      }
    }
    expect(ranges.length).toBeGreaterThan(0)
  })

  it('空文档不产生装饰', () => {
    expect(collectMarks(stateWith(''), [])).toEqual([])
  })
})

function stateFolded(doc: string): EditorState {
  const base = EditorState.create({ doc, extensions: [markdownLanguageExtension, frontMatterCollapsed] })
  return base.update({ effects: setFrontMatterCollapsed.of(true) }).state
}

describe('数学渲染', () => {
  const AWAY = [{ from: 9999, to: 9999 }]

  it('$$ 块产出公式块，源码逐行弱化', () => {
    const doc = '$$\nE = mc^2\n$$\n\n正文\n'
    const ranges = collectMarks(stateWith(doc), AWAY)
    const widget = ranges.find((range) => range.widget === 'math-block')
    expect(widget?.content).toBe('E = mc^2')
    expect(widget?.block).toBe(true)
    // 预览落在块后的第一行行首（这里是块与正文之间的空行）
    expect(widget?.from).toBe(indexOfText(doc, '正文') - 1)
    expect(ranges.filter((range) => range.cls === 'mdf-math-line')).toHaveLength(3)
  })

  it('单行 $$…$$ 也产出公式块', () => {
    const ranges = collectMarks(stateWith('$$x^2$$\n\n正文\n'), AWAY)
    expect(ranges.find((range) => range.widget === 'math-block')?.content).toBe('x^2')
  })

  it('光标落在块内时不预览，源码可编辑', () => {
    const doc = '$$\nE = mc^2\n$$\n'
    const ranges = collectMarks(stateWith(doc), [{ from: indexOfText(doc, 'mc'), to: indexOfText(doc, 'mc') }])
    expect(ranges.some((range) => range.widget === 'math-block')).toBe(false)
  })

  it('未闭合的 $$ 不产生公式块', () => {
    const ranges = collectMarks(stateWith('$$\nx + 1\n\n正文\n'), AWAY)
    expect(ranges.some((range) => range.widget === 'math-block')).toBe(false)
  })

  it('行内 $…$ 替换为行内公式', () => {
    const doc = '勾股定理 $a^2+b^2=c^2$ 很有名\n'
    const ranges = collectMarks(stateWith(doc), AWAY)
    const widget = ranges.find((range) => range.widget === 'math-inline')
    expect(widget?.content).toBe('a^2+b^2=c^2')
    expect(widget?.block).toBeUndefined()
    expect(doc.slice(widget?.from ?? 0, widget?.to ?? 0)).toBe('$a^2+b^2=c^2$')
  })

  it('金额写法不当作数学', () => {
    const ranges = collectMarks(stateWith('价格 $100 与 $200 不等\n'), AWAY)
    expect(ranges.some((range) => range.widget === 'math-inline')).toBe(false)
  })

  it('引用块里的 $$ 去掉引用符再渲染', () => {
    const ranges = collectMarks(stateWith('> $$\n> \\alpha\n> $$\n'), AWAY)
    expect(ranges.find((range) => range.widget === 'math-block')?.content).toBe('\\alpha')
  })
})

describe('mermaid 与表格预览', () => {
  const AWAY = [{ from: 9999, to: 9999 }]

  it('mermaid 围栏产出图块并带上正文', () => {
    const doc = '```mermaid\ngraph TD; A-->B;\n```\n\n说明\n'
    const ranges = collectMarks(stateWith(doc), AWAY)
    const widget = ranges.find((range) => range.widget === 'mermaid')
    expect(widget?.content).toBe('graph TD; A-->B;')
    expect(widget?.block).toBe(true)
  })

  it('非 mermaid 语言不产出图块', () => {
    const ranges = collectMarks(stateWith('```js\nconst a = 1\n```\n'), AWAY)
    expect(ranges.some((range) => range.widget === 'mermaid')).toBe(false)
  })

  it('空 mermaid 围栏不产出图块', () => {
    expect(collectMarks(stateWith('```mermaid\n```\n'), AWAY).some((range) => range.widget === 'mermaid')).toBe(false)
  })

  it('表格产出网格块，整段替换掉表格源码', () => {
    const doc = '| A | B |\n| :- | --: |\n| 1 | 2 |\n\n正文\n'
    const ranges = collectMarks(stateWith(doc), AWAY)
    const widget = ranges.find((range) => range.widget === 'table')
    expect(widget?.from).toBe(0)
    expect(widget?.block).toBeUndefined()
    expect(widget?.nodeFrom).toBe(widget?.from)
    // 替换区间正好盖住表格源码（末尾换行允许多带一个）
    expect(doc.slice(widget!.from, widget!.to).trimEnd()).toBe('| A | B |\n| :- | --: |\n| 1 | 2 |')
    expect(widget?.content).toContain('| A | B |')
  })

  it('光标进入表格行时网格消失，竖线仍可编辑', () => {
    const doc = '| A | B |\n| - | - |\n| 1 | 2 |\n'
    const ranges = collectMarks(stateWith(doc), [{ from: 2, to: 2 }])
    expect(ranges.some((range) => range.widget === 'table')).toBe(false)
    expect(ranges.some((range) => range.cls === 'mdf-pipe')).toBe(true)
  })

  it('光标停在表格首/尾边界时不切源码（刚粘贴完的位置）', () => {
    // 无结尾换行：表格尾边界就是文末，粘贴完光标正落在这里
    const doc = '| A | B |\n| - | - |\n| 1 | 2 |'
    const gridAt = (pos: number): boolean =>
      collectMarks(stateWith(doc), [{ from: pos, to: pos }]).some((range) => range.widget === 'table')
    expect(gridAt(0)).toBe(true)
    expect(gridAt(doc.length)).toBe(true)
    expect(gridAt(2)).toBe(false)
  })

  it('表头列数与分隔行不匹配的伪表格不产出网格', () => {
    const ranges = collectMarks(stateWith('| A | B |\n| 1 | 2 |\n'), AWAY)
    expect(ranges.some((range) => range.widget === 'table')).toBe(false)
  })
})

describe('front matter 渲染', () => {
  const AWAY = [{ from: 9999, to: 9999 }]
  const DOC = '---\ntitle: 手册\nbold: *示例*\n---\n\n# 正文\n'

  it('整块逐行弱化', () => {
    const ranges = collectMarks(stateWith(DOC), AWAY)
    expect(ranges.filter((range) => range.cls === 'mdf-frontmatter')).toHaveLength(4)
  })

  it('块内的强调、分隔线装饰被丢弃', () => {
    const ranges = collectMarks(stateWith(DOC), AWAY)
    expect(ranges.some((range) => range.cls === 'mdf-strong' || range.cls === 'mdf-em')).toBe(false)
    expect(ranges.some((range) => range.cls === 'mdf-hr')).toBe(false)
  })

  it('正文部分的装饰不受影响', () => {
    const ranges = collectMarks(stateWith(DOC), AWAY)
    expect(ranges.some((range) => (range.cls ?? '').includes('mdf-heading-1'))).toBe(true)
  })

  it('默认在收尾行末尾给折叠开关', () => {
    const ranges = collectMarks(stateWith(DOC), AWAY)
    const toggle = ranges.find((range) => range.widget === 'front-matter')
    expect(toggle?.collapsed).toBe(false)
    expect(toggle?.lines).toBe(4)
    expect(toggle?.nodeFrom).toBe(0)
  })

  it('折叠后只剩一个占位 widget，行装饰消失', () => {
    const ranges = collectMarks(stateFolded(DOC), AWAY)
    expect(ranges.filter((range) => range.cls === 'mdf-frontmatter')).toHaveLength(0)
    const widget = ranges.find((range) => range.widget === 'front-matter')
    expect(widget?.collapsed).toBe(true)
    expect(widget?.from).toBe(0)
    expect(DOC.slice(widget?.from ?? 0, widget?.to ?? 0)).toBe('---\ntitle: 手册\nbold: *示例*\n---')
  })

  it('光标进入折叠块时自动展开', () => {
    const ranges = collectMarks(stateFolded(DOC), [{ from: 6, to: 6 }])
    expect(ranges.find((range) => range.widget === 'front-matter')?.collapsed).toBe(false)
  })
})

describe('图片宽度提示', () => {
  const DOC = 'E:/docs/a.md'
  const AWAY = [{ from: 9999, to: 9999 }]

  it('title 里的 w= 被读成宽度', () => {
    const ranges = collectMarks(stateWith('![流程图](img/flow.png "w=640")\n'), AWAY, DOC)
    const widget = ranges.find((range) => range.widget === 'image')
    expect(widget?.width).toBe(640)
    expect(widget?.src).toMatch(/^mdasset:\/\//)
    expect(widget?.alt).toBe('流程图')
  })

  it('说明文字与宽度提示可以共存', () => {
    const ranges = collectMarks(stateWith('![a](x.png "说明 w=320")\n'), AWAY, DOC)
    expect(ranges.find((range) => range.widget === 'image')?.width).toBe(320)
  })

  it('普通 title 不当作宽度', () => {
    const ranges = collectMarks(stateWith('![a](x.png "2024 年度图")\n'), AWAY, DOC)
    expect(ranges.find((range) => range.widget === 'image')?.width).toBeUndefined()
  })

  it('记下 Image 节点区间供写回', () => {
    const doc = '![a](x.png)\n'
    const widget = collectMarks(stateWith(doc), AWAY, DOC).find((range) => range.widget === 'image')
    expect(doc.slice(widget?.nodeFrom ?? 0, widget?.nodeTo ?? 0)).toBe('![a](x.png)')
  })
})
