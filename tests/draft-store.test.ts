import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { DocDraft } from '../src/shared/ipc'
import { draftClear, draftList, draftWrite, initDraftStore } from '../src/main/fs/draft-store'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mdforge-draft-'))
  initDraftStore(path.join(dir, 'drafts'))
})

function draftOf(overrides: Partial<DocDraft> = {}): DocDraft {
  return {
    key: 'p:e:\\文档\\说明.md',
    path: 'E:\\文档\\说明.md',
    name: '说明.md',
    text: '# 改了但没保存\n',
    meta: { encoding: 'utf-8', eol: 'crlf', eolMixed: false, bom: false },
    updatedAt: 2,
    ...overrides
  }
}

describe('崩溃草稿', () => {
  it('写入后能列出来，内容与写回参数一起保存', async () => {
    await draftWrite(draftOf())
    const list = await draftList()
    expect(list).toHaveLength(1)
    expect(list[0].text).toBe('# 改了但没保存\n')
    expect(list[0].meta.eol).toBe('crlf')
    expect(list[0].path).toBe('E:\\文档\\说明.md')
  })

  it('键里的中文与盘符不会变成非法文件名', async () => {
    await draftWrite(draftOf())
    const files = readdirSync(path.join(dir, 'drafts'))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^[0-9a-f]{40}\.json$/)
  })

  it('同一个键重复写入只留最新一份', async () => {
    await draftWrite(draftOf({ text: '第一版\n' }))
    await draftWrite(draftOf({ text: '第二版\n', updatedAt: 9 }))
    const list = await draftList()
    expect(list).toHaveLength(1)
    expect(list[0].text).toBe('第二版\n')
  })

  it('清空后不再残留，未命名草稿的 path 为 null 也能存', async () => {
    await draftWrite(draftOf({ key: 'n:new#1', path: null, name: '未命名' }))
    expect(await draftList()).toHaveLength(1)
    await draftClear(['n:new#1'])
    expect(await draftList()).toHaveLength(0)
  })

  it('损坏或半截的草稿文件被跳过，不影响其他草稿', async () => {
    await draftWrite(draftOf())
    const broken = path.join(dir, 'drafts', 'ffff.json')
    writeFileSync(broken, '{ "key": ', 'utf-8')
    writeFileSync(path.join(dir, 'drafts', 'note.txt'), '不是草稿', 'utf-8')
    const list = await draftList()
    expect(list).toHaveLength(1)
    expect(list[0].key).toBe('p:e:\\文档\\说明.md')
    rmSync(broken)
  })

  it('按修改时间从新到旧排列', async () => {
    await draftWrite(draftOf({ key: 'a', updatedAt: 100 }))
    await draftWrite(draftOf({ key: 'b', updatedAt: 900 }))
    await draftWrite(draftOf({ key: 'c', updatedAt: 500 }))
    expect((await draftList()).map((draft) => draft.key)).toEqual(['b', 'c', 'a'])
  })

  it('目录还不存在时列出空列表而不是报错', async () => {
    initDraftStore(path.join(dir, 'not-created-yet'))
    expect(await draftList()).toEqual([])
  })
})
