import { describe, expect, it } from 'vitest'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import {
  enterPlan,
  headingPlan,
  listPlan,
  parseMarkers,
  quotePlan,
  tablePlan,
  toggleWrapPlan
} from '../src/renderer/src/editor/commands'
import { markdownLanguageExtension } from '../src/renderer/src/editor/markdown'

function stateWith(doc: string, sel?: [number, number?]): EditorState {
  return EditorState.create({
    doc,
    selection: sel ? { anchor: sel[0], head: sel[1] ?? sel[0] } : undefined,
    extensions: [markdownLanguageExtension]
  })
}

function apply(state: EditorState, plan: TransactionSpec | null) {
  if (!plan) return null
  const tr = state.update(plan)
  return { text: tr.state.doc.toString(), sel: tr.state.selection.main }
}

function idx(doc: string, needle: string): number {
  const i = doc.indexOf(needle)
  if (i < 0) throw new Error(`找不到 ${needle}`)
  return i
}

describe('parseMarkers', () => {
  it('解析无序 / 任务 / 有序 / 引用前缀', () => {
    expect(parseMarkers('- 项目')).toMatchObject({ listKind: 'bullet', bulletChar: '-', task: false, content: '项目' })
    expect(parseMarkers('- [ ] 待办')).toMatchObject({ listKind: 'bullet', task: true, content: '待办' })
    expect(parseMarkers('3) 第三')).toMatchObject({ listKind: 'ordered', number: 3, delim: ')', content: '第三' })
    expect(parseMarkers('> 引用')).toMatchObject({ quote: '> ', content: '引用' })
    expect(parseMarkers('> - 列表')).toMatchObject({ quote: '> ', listKind: 'bullet', content: '列表' })
  })
})

describe('强调包裹', () => {
  it('空选区插入成对标记并把光标留在中间', () => {
    const doc = '段落'
    const r = apply(stateWith(doc, [2]), toggleWrapPlan(stateWith(doc, [2]), '**', '**'))
    expect(r?.text).toBe('段落****')
    expect(r?.sel.from).toBe(4)
    expect(r?.sel.empty).toBe(true)
  })

  it('已有标记时取消包裹', () => {
    const doc = '这是**粗体**结尾'
    const from = idx(doc, '粗体')
    const to = from + 2
    const r = apply(stateWith(doc, [from, to]), toggleWrapPlan(stateWith(doc, [from, to]), '**', '**'))
    expect(r?.text).toBe('这是粗体结尾')
  })

  it('选区整体已含标记时去掉选区内的标记', () => {
    const doc = '**粗体**'
    const r = apply(stateWith(doc, [0, doc.length]), toggleWrapPlan(stateWith(doc, [0, doc.length]), '**', '**'))
    expect(r?.text).toBe('粗体')
  })
})

describe('标题', () => {
  it('正文升级为三级标题', () => {
    const r = apply(stateWith('标题', [1]), headingPlan(stateWith('标题', [1]), 3))
    expect(r?.text).toBe('### 标题')
  })

  it('同级再按一次降级为正文', () => {
    const r = apply(stateWith('### 标题', [2]), headingPlan(stateWith('### 标题', [2]), 3))
    expect(r?.text).toBe('标题')
  })

  it('跨级别切换', () => {
    const r = apply(stateWith('## 二级', [2]), headingPlan(stateWith('## 二级', [2]), 1))
    expect(r?.text).toBe('# 二级')
  })
})

describe('列表与引用', () => {
  it('多行加无序列表标记', () => {
    const doc = '甲\n乙\n丙'
    const r = apply(stateWith(doc, [0, doc.length]), listPlan(stateWith(doc, [0, doc.length]), 'bullet'))
    expect(r?.text).toBe('- 甲\n- 乙\n- 丙')
  })

  it('有序列表自动编号', () => {
    const doc = '甲\n乙\n丙'
    const r = apply(stateWith(doc, [0, doc.length]), listPlan(stateWith(doc, [0, doc.length]), 'ordered'))
    expect(r?.text).toBe('1. 甲\n2. 乙\n3. 丙')
  })

  it('已是同种列表时取消', () => {
    const doc = '- 甲\n- 乙'
    const r = apply(stateWith(doc, [0, doc.length]), listPlan(stateWith(doc, [0, doc.length]), 'bullet'))
    expect(r?.text).toBe('甲\n乙')
  })

  it('任务列表切换保留缩进与引用', () => {
    const doc = '> 项'
    const r = apply(stateWith(doc, [2]), listPlan(stateWith(doc, [2]), 'task'))
    expect(r?.text).toBe('> - [ ] 项')
  })

  it('引用切换不会破坏列表标记', () => {
    const doc = '- 项目'
    const r = apply(stateWith(doc, [2]), quotePlan(stateWith(doc, [2])))
    expect(r?.text).toBe('> - 项目')
    const off = apply(stateWith('> - 项目', [2]), quotePlan(stateWith('> - 项目', [2])))
    expect(off?.text).toBe('- 项目')
  })
})

describe('插入表格', () => {
  it('空行插入表格骨架并把光标落在首个数据单元格', () => {
    const header = '| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n'
    const r = apply(stateWith('', [0]), tablePlan(stateWith('', [0])))
    expect(r?.text.startsWith(`${header}|  |  |  |`)).toBe(true)
    expect(r?.sel.empty).toBe(true)
    expect(r?.sel.anchor).toBe(header.length + 2)
    expect(r?.text.slice(header.length, header.length + 2)).toBe('| ')
  })
})

describe('回车续写列表', () => {
  const atEnd = (doc: string) => stateWith(doc, [doc.length])

  it('无序列表续写', () => {
    const doc = '- 项目'
    const r = apply(atEnd(doc), enterPlan(atEnd(doc)))
    expect(r?.text).toBe('- 项目\n- ')
    expect(r?.sel.anchor).toBe(r?.text.length)
  })

  it('有序列表编号递增', () => {
    const doc = '2. 第二项'
    const r = apply(stateWith(doc, [doc.length]), enterPlan(stateWith(doc, [doc.length])))
    expect(r?.text).toBe('2. 第二项\n3. ')
  })

  it('任务列表续写重置为未勾选', () => {
    const doc = '- [x] 完成'
    const r = apply(stateWith(doc, [doc.length]), enterPlan(stateWith(doc, [doc.length])))
    expect(r?.text).toBe('- [x] 完成\n- [ ] ')
  })

  it('空列表项回车退出列表（删除标记，不新增行）', () => {
    const doc = '- '
    const st = stateWith(doc, [doc.length])
    const r = apply(st, enterPlan(st))
    expect(r?.text).toBe('')
    expect(r?.sel.anchor).toBe(0)
  })

  it('引用行续写引用前缀', () => {
    const doc = '> 引用'
    const r = apply(stateWith(doc, [doc.length]), enterPlan(stateWith(doc, [doc.length])))
    expect(r?.text).toBe('> 引用\n> ')
  })

  it('普通段落不接管，返回 null', () => {
    const doc = '普通句子'
    expect(enterPlan(stateWith(doc, [doc.length]))).toBeNull()
  })

  it('在条目中间回车把后半段带到新项', () => {
    const doc = '- 甲乙丙'
    const head = idx(doc, '乙')
    const r = apply(stateWith(doc, [head]), enterPlan(stateWith(doc, [head])))
    expect(r?.text).toBe('- 甲\n- 乙丙')
  })
})
