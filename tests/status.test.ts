import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { computeStatus, countWords, formatStatus } from '../src/renderer/src/editor/status'

describe('countWords', () => {
  it('中日韩字符逐个计数', () => {
    expect(countWords('中文文本')).toBe(4)
  })

  it('英文按单词计数', () => {
    expect(countWords('hello world')).toBe(2)
  })

  it('中英混排相加', () => {
    expect(countWords('hello 世界 ok')).toBe(4)
  })

  it('标点与空白不计入', () => {
    expect(countWords('。。。!!!')).toBe(0)
  })
})

describe('computeStatus', () => {
  it('字符数不计换行，行列号按光标', () => {
    const doc = 'hello\nworld'
    const state = EditorState.create({ doc, selection: { anchor: 8 } })
    const info = computeStatus(state)
    expect(info.chars).toBe(10)
    expect(info.lines).toBe(2)
    expect(info.line).toBe(2)
    expect(info.col).toBe(3)
  })

  it('选区统计字符与行数', () => {
    const doc = '甲\n乙丙\n丁'
    const state = EditorState.create({ doc, selection: { anchor: 0, head: 3 } })
    const info = computeStatus(state)
    expect(info.selChars).toBe(3)
    expect(info.selLines).toBe(2)
  })

  it('多光标数量计入', () => {
    const selection = EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(3)])
    const state = EditorState.create({
      doc: 'abcdef',
      selection,
      extensions: [EditorState.allowMultipleSelections.of(true)]
    })
    expect(computeStatus(state).cursors).toBe(2)
  })
})

describe('formatStatus', () => {
  it('只在有选区时追加选中信息', () => {
    const state = EditorState.create({ doc: 'abc', selection: { anchor: 0, head: 2 } })
    expect(formatStatus(computeStatus(state))).toContain('选中 2 字符')
    const none = formatStatus(computeStatus(EditorState.create({ doc: 'abc' })))
    expect(none).not.toContain('选中')
  })
})
