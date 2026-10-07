import { describe, expect, it } from 'vitest'
import type { FileSnapshot } from '../src/shared/ipc'
import {
  NEW_FILE_META,
  afterSave,
  displayNameOf,
  draftKeyOf,
  emptyDoc,
  fromSnapshot,
  isDirty,
  isUnsavedNew,
  withMeta,
  withText,
  writeRequest
} from '../src/renderer/src/doc'

function snapshotOf(overrides: Partial<FileSnapshot> = {}): FileSnapshot {
  return {
    path: 'E:\\文档\\说明.md',
    text: '# 说明\r\n',
    meta: { encoding: 'gbk', eol: 'crlf', eolMixed: false, bom: false },
    hash: 'hash-a',
    size: 12,
    mtimeMs: 1,
    ...overrides
  }
}

describe('脏状态', () => {
  it('刚载入的文档不脏', () => {
    expect(isDirty(fromSnapshot(snapshotOf()))).toBe(false)
  })

  it('正文改动算脏，改回原文就不脏', () => {
    const loaded = fromSnapshot(snapshotOf())
    const edited = withText(loaded, `${loaded.text}加一行`)
    expect(isDirty(edited)).toBe(true)
    expect(isDirty(withText(edited, loaded.text))).toBe(false)
  })

  it('只切换编码或换行符也算没保存', () => {
    const loaded = fromSnapshot(snapshotOf())
    const converted = withMeta(loaded, { ...loaded.meta, encoding: 'utf-8', bom: false })
    expect(isDirty(converted)).toBe(true)
    expect(writeRequest(converted).meta.encoding).toBe('utf-8')
    expect(converted.text).toBe(loaded.text)
    expect(isDirty(afterSave(snapshotOf({ meta: converted.meta, hash: 'hash-b' }), converted))).toBe(false)

    const lf = withMeta(loaded, { ...loaded.meta, eol: 'lf' })
    expect(isDirty(lf)).toBe(true)
    expect(writeRequest(lf).meta.eol).toBe('lf')
  })

  it('混合换行符被统一后仍然写回同一 eol', () => {
    const mixed = fromSnapshot(snapshotOf({ meta: { encoding: 'utf-8', eol: 'crlf', eolMixed: true, bom: false } }))
    const unified = withMeta(mixed, { ...mixed.meta, eolMixed: false })
    expect(isDirty(unified)).toBe(true)
    expect(writeRequest(unified).meta.eolMixed).toBe(false)
  })
})

describe('未命名文档', () => {
  it('空的新建文档不算未保存', () => {
    expect(isDirty(emptyDoc())).toBe(false)
    expect(isUnsavedNew(emptyDoc())).toBe(false)
  })

  it('写了字但没路径的文档算未保存', () => {
    const typed = withText(emptyDoc(), '# 草稿')
    expect(isUnsavedNew(typed)).toBe(true)
    expect(isDirty(typed)).toBe(true)
    expect(displayNameOf(typed)).toBe('未命名')
    expect(() => writeRequest(typed)).toThrowError(/另存为/)
  })

  it('新建文档默认 UTF-8 + CRLF 且无 BOM', () => {
    expect(emptyDoc().meta).toEqual(NEW_FILE_META)
  })
})

describe('崩溃草稿键', () => {
  it('已保存的文档用路径推导，重启后能对回同一份草稿', () => {
    const key = draftKeyOf('E:\\文档\\说明.md', 'new#3')
    expect(key).toBe(draftKeyOf('e:\\文档\\说明.md', 'ignored'))
    expect(key.startsWith('p:')).toBe(true)
  })

  it('未命名文档用标签序号', () => {
    expect(draftKeyOf(null, 'new#3')).toBe('n:new#3')
  })
})
