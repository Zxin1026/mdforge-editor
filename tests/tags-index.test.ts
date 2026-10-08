import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { scanTags } from '../src/main/fs/tags-index'
import { grantFolder, resetFileStore } from '../src/main/fs/file-store'

let root: string

beforeEach(() => {
  resetFileStore()
  root = mkdtempSync(path.join(tmpdir(), 'mdforge-tags-'))
  grantFolder(root)
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

function put(relative: string, text: string): string {
  const target = path.join(root, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, text, 'utf8')
  return target
}

describe('标签索引', () => {
  it('行内列表、换行列表与 keywords 别名都认', async () => {
    put('a.md', '---\ntags: [笔记, 教程]\n---\n\n# A\n')
    put('b.md', '---\ntags:\n  - 笔记\n  - "长标签"\n---\n\n# B\n')
    put('子/c.md', '---\nkeywords: 笔记, 归档\n---\n\n# C\n')

    const index = await scanTags(root)
    expect(index.files.map((file) => file.name).sort()).toEqual(['a.md', 'b.md', 'c.md'])

    const byName = new Map(index.docs.map((doc) => [doc.name, doc.tags]))
    expect(byName.get('a.md')).toEqual(['笔记', '教程'])
    expect(byName.get('b.md')).toEqual(['笔记', '长标签'])
    expect(byName.get('c.md')).toEqual(['笔记', '归档'])
  })

  it('没有 front matter 或没有标签的文档不进标签表，但仍在文件清单里', async () => {
    put('plain.md', '# 没有 front matter\n')
    put('empty.md', '---\ntitle: 只有标题\n---\n\n正文\n')
    const index = await scanTags(root)
    expect(index.files).toHaveLength(2)
    expect(index.docs).toEqual([])
  })

  it('去重、剥井号、过滤空标签，大小写不同视为同一个', async () => {
    put('a.md', '---\ntags: [#Note, note, NOTE, "", "  "]\n---\n\n# A\n')
    const index = await scanTags(root)
    expect(index.docs[0].tags).toEqual(['Note'])
  })

  it('未授权的文件夹拒绝扫描', async () => {
    resetFileStore()
    await expect(scanTags(root)).rejects.toThrow(/授权/)
  })
})
