import { describe, expect, it } from 'vitest'
import { buildRowLine, parseTable, sourceLineSpans } from '../src/renderer/src/editor/table'

describe('表格网格解析', () => {
  it('表头、对齐与数据行', () => {
    const model = parseTable('| 左 | 中 | 右 |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |')
    expect(model?.header).toEqual(['左', '中', '右'])
    expect(model?.aligns).toEqual(['left', 'center', 'right'])
    expect(model?.rows).toEqual([
      ['1', '2', '3'],
      ['4', '5', '6']
    ])
  })

  it('省略首尾竖线也能解析', () => {
    const model = parseTable('A | B\n--- | ---\n1 | 2')
    expect(model?.header).toEqual(['A', 'B'])
    expect(model?.rows).toEqual([['1', '2']])
  })

  it('转义竖线算单元格内容', () => {
    const model = parseTable('| A | B |\n| - | - |\n| x \\| y | z |')
    expect(model?.rows).toEqual([['x | y', 'z']])
  })

  it('列数不齐时按表头补齐或截断', () => {
    const model = parseTable('| A | B | C |\n| - | - | - |\n| 1 |\n| 1 | 2 | 3 | 4 |')
    expect(model?.rows).toEqual([
      ['1', '', ''],
      ['1', '2', '3']
    ])
  })

  it('没有分隔行不是表格', () => {
    expect(parseTable('| A | B |\n| 1 | 2 |')).toBeNull()
    expect(parseTable('| A | B |\n| - | x |')).toBeNull()
    expect(parseTable('只有一行')).toBeNull()
  })

  it('空单元格保留位置', () => {
    const model = parseTable('| A |  | B |\n| - | - | - |\n| 1 |  | 3 |')
    expect(model?.header).toEqual(['A', '', 'B'])
    expect(model?.rows).toEqual([['1', '', '3']])
  })
})

describe('表格写回源码', () => {
  it('重建整行并转义字面竖线', () => {
    expect(buildRowLine(['苹果', '3'])).toBe('| 苹果 | 3 |')
    expect(buildRowLine(['x | y', 'z'])).toBe('| x \\| y | z |')
  })

  it('空单元格保持占位', () => {
    expect(buildRowLine(['', '2'])).toBe('|  | 2 |')
  })

  it('行偏移与解析口径一致：跳过空行并给出每行源码区间', () => {
    const source = '| A | B |\n\n| - | - |\n| 1 | 2 |'
    const spans = sourceLineSpans(source)
    expect(spans.map((span) => span.text)).toEqual(['| A | B |', '| - | - |', '| 1 | 2 |'])
    expect(source.slice(spans[2].from, spans[2].to)).toBe('| 1 | 2 |')
  })

  it('解析后再重建不改变单元格内容（含转义往返）', () => {
    const line = '| x \\| y | z |'
    const model = parseTable(`| A | B |\n| - | - |\n${line}`)
    expect(buildRowLine(model?.rows[0] ?? [])).toBe(line)
  })
})
