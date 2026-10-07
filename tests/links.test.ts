import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { linkAt } from '../src/renderer/src/editor/links'
import { markdownLanguageExtension } from '../src/renderer/src/editor/markdown'

const DOC_PATH = 'E:/docs/a.md'

function stateWith(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdownLanguageExtension] })
}

function at(doc: string, needle: string): number {
  const i = doc.indexOf(needle)
  if (i < 0) throw new Error(`找不到 ${needle}`)
  return i + 1
}

describe('linkAt', () => {
  it('外部链接可打开', () => {
    const doc = 'see [text](https://example.com) end\n'
    const target = linkAt(stateWith(doc), at(doc, 'text'), DOC_PATH)
    expect(target?.kind).toBe('external')
    expect(target?.url).toBe('https://example.com')
    expect(target?.openable).toBe(true)
  })

  it('相对 md 链接解析为本地绝对路径', () => {
    const doc = '[去](./note.md)\n'
    const target = linkAt(stateWith(doc), at(doc, '去'), DOC_PATH)
    expect(target?.kind).toBe('relative-md')
    expect(target?.localPath).toBe('E:/docs/note.md')
    expect(target?.openable).toBe(true)
  })

  it('文内锚点', () => {
    const doc = '[章](#sec)\n'
    const target = linkAt(stateWith(doc), at(doc, '章'), DOC_PATH)
    expect(target?.kind).toBe('anchor')
    expect(target?.url).toBe('sec')
  })

  it('图片解析出预览地址但不算可打开链接', () => {
    const doc = '![图](img/a.png)\n'
    const target = linkAt(stateWith(doc), at(doc, '图'), DOC_PATH)
    expect(target?.kind).toBe('image')
    expect(target?.localPath).toBe('E:/docs/img/a.png')
    expect(target?.previewSrc).toMatch(/^mdasset:\/\//)
    expect(target?.openable).toBe(false)
  })

  it('非 md 的相对文件只解析路径', () => {
    const doc = '[表](doc.pdf)\n'
    const target = linkAt(stateWith(doc), at(doc, '表'), DOC_PATH)
    expect(target?.kind).toBe('relative-file')
    expect(target?.openable).toBe(false)
  })

  it('裸链（自动链接）也算外部链接', () => {
    const doc = '访问 https://auto.example 现在\n'
    const target = linkAt(stateWith(doc), at(doc, 'auto.example'), DOC_PATH)
    expect(target?.kind).toBe('external')
    expect(target?.openable).toBe(true)
  })

  it('不在链接内返回 null', () => {
    const doc = '普通段落\n'
    expect(linkAt(stateWith(doc), at(doc, '普通'), DOC_PATH)).toBeNull()
  })
})
