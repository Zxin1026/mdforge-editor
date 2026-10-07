import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { scanLinks } from '../src/main/fs/link-index'
import { grantFolder, resetFileStore } from '../src/main/fs/file-store'

let root: string

beforeEach(() => {
  resetFileStore()
  root = mkdtempSync(path.join(tmpdir(), 'mdforge-links-'))
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

describe('链接索引', () => {
  it('收集文件夹内文档之间的相对链接', async () => {
    const a = put('a.md', '# A\n\n[去 B](子/b.md)\n')
    const b = put('子/b.md', '# B\n\n[回 A](../a.md)\n')
    const index = await scanLinks(root)
    expect(index.files.map((file) => file.name).sort()).toEqual(['a.md', 'b.md'])
    expect(index.links).toHaveLength(2)
    const fromB = index.links.find((link) => link.from === b)
    expect(fromB?.to).toBe(a)
    expect(fromB?.line).toBe(3)
  })

  it('锚点后缀只取文件名，代码块里的链接不算', async () => {
    const a = put('a.md', '# A\n\n[锚](#a)\n\n[带锚点](b.md#小节)\n')
    put('b.md', '# B\n\n```\n[假链接](a.md)\n```\n')
    const index = await scanLinks(root)
    expect(index.links).toHaveLength(1)
    expect(index.links[0].from).toBe(a)
    expect(index.links[0].to.endsWith('b.md')).toBe(true)
  })

  it('指向文件夹外的链接与图片都不计入', async () => {
    put('a.md', '# A\n\n[外](https://example.com)\n\n![图](p.png)\n\n[出界](../outside.md)\n')
    const index = await scanLinks(root)
    expect(index.links).toHaveLength(0)
  })
})
