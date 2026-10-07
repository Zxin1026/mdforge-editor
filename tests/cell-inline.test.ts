import { describe, expect, it } from 'vitest'
import { parseCellInline } from '../src/renderer/src/editor/cell-inline'

describe('表格单元格行内解析', () => {
  it('纯文本原样返回', () => {
    expect(parseCellInline('只在表格里')).toEqual([{ text: '只在表格里' }])
  })

  it('去掉加粗/斜体/删除线/行内代码的标记', () => {
    expect(parseCellInline('**粗**')).toEqual([{ text: '粗', strong: true }])
    expect(parseCellInline('*斜*')).toEqual([{ text: '斜', em: true }])
    expect(parseCellInline('~~删~~')).toEqual([{ text: '删', strike: true }])
    expect(parseCellInline('`code`')).toEqual([{ text: 'code', code: true }])
  })

  it('链接只保留文字，不显示地址', () => {
    const url = 'E:/DATA_FILE/File/MDForge/mdforge-editor/src/main/fs/folder.ts'
    expect(parseCellInline(`[folder.ts](${url})`)).toEqual([{ text: 'folder.ts', link: true }])
  })

  it('链接文字里的强调样式照常生效', () => {
    expect(parseCellInline('[**重点**](x.md)')).toEqual([{ text: '重点', strong: true, link: true }])
  })

  it('图片退化成 alt 文字', () => {
    expect(parseCellInline('![截图](assets/a.png)')).toEqual([{ text: '截图' }])
  })

  it('未闭合的标记保留原文，不吞字符', () => {
    expect(parseCellInline('2 * 3 = 6')).toEqual([{ text: '2 * 3 = 6' }])
    expect(parseCellInline('**没关')).toEqual([{ text: '**没关' }])
  })

  it('字面竖线原样保留', () => {
    expect(parseCellInline('a | b')).toEqual([{ text: 'a | b' }])
  })

  it('样式段与纯文本段分开产出', () => {
    expect(parseCellInline('a **粗** b')).toEqual([{ text: 'a ' }, { text: '粗', strong: true }, { text: ' b' }])
  })

  it('空串返回空', () => {
    expect(parseCellInline('')).toEqual([])
  })
})
