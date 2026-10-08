import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createFolder, listFolder, movePath, renamePath } from '../src/main/fs/folder'
import { replaceWorkspace, searchWorkspace } from '../src/main/fs/search'
import { FileOpError } from '../src/main/fs/error'
import { grantFolder, resetFileStore } from '../src/main/fs/file-store'

let root: string

beforeEach(() => {
  resetFileStore()
  root = mkdtempSync(path.join(tmpdir(), 'mdforge-search-'))
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

function hashOf(target: string): string {
  return createHash('sha1').update(readFileSync(target)).digest('hex')
}

describe('工作区搜索', () => {
  it('按内容逐行给出命中，行列都是 1 起', async () => {
    put('笔记/a.md', '# A\n\n今天写 Markdown 工具。\n再来一行 markdown。\n')
    const result = await searchWorkspace({ dir: root, query: 'markdown', caseSensitive: false, regex: false })
    expect(result.files).toHaveLength(1)
    expect(result.files[0].matches.map((match) => match.line)).toEqual([3, 4])
    expect(result.files[0].matches[0].col).toBe(5)
    expect(result.files[0].matches[0].length).toBe(8)
  })

  it('文件名命中也会列出来，即使内容没匹配', async () => {
    put('markdown-手册.md', '# 手册\n\n正文。\n')
    const result = await searchWorkspace({ dir: root, query: 'markdown', caseSensitive: false, regex: false })
    expect(result.files).toHaveLength(1)
    expect(result.files[0].nameMatch).toBe(true)
    expect(result.files[0].matches).toHaveLength(0)
  })

  it('区分大小写开关生效', async () => {
    put('a.md', 'Markdown 与 markdown\n')
    const loose = await searchWorkspace({ dir: root, query: 'Markdown', caseSensitive: false, regex: false })
    expect(loose.totalMatches).toBe(1)
    const strict = await searchWorkspace({ dir: root, query: 'markdown', caseSensitive: true, regex: false })
    expect(strict.totalMatches).toBe(1)
    expect(strict.files[0].matches[0].col).toBe(12)
  })

  it('字面量模式把正则符号当普通字符', async () => {
    put('a.md', '价格是 1+1=2 元\n')
    const result = await searchWorkspace({ dir: root, query: '1+1', caseSensitive: false, regex: false })
    expect(result.totalMatches).toBe(1)
  })

  it('正则模式支持表达式，非法正则给出可读报错', async () => {
    put('a.md', '编号 A-12 与 B-20\n')
    const result = await searchWorkspace({ dir: root, query: '[A-Z]-\\d+', caseSensitive: false, regex: true })
    expect(result.totalMatches).toBe(1)
    expect(result.files[0].matches[0].length).toBe(4)
    await expect(searchWorkspace({ dir: root, query: '([', caseSensitive: false, regex: true })).rejects.toThrow(
      /正则表达式无效/
    )
  })

  it('跳过隐藏目录与 node_modules', async () => {
    put('.hidden/x.md', 'needle\n')
    put('node_modules/pkg/readme.md', 'needle\n')
    put('visible.md', 'needle\n')
    const result = await searchWorkspace({ dir: root, query: 'needle', caseSensitive: false, regex: false })
    expect(result.files.map((file) => file.name)).toEqual(['visible.md'])
  })

  it('过滤串按 glob 收窄文件：包含、排除与目录通配', async () => {
    put('a.md', 'needle\n')
    put('b.txt', 'needle\n')
    put('draft/c.md', 'needle\n')
    put('notes/deep/d.md', 'needle\n')

    const onlyMd = await searchWorkspace({ dir: root, query: 'needle', caseSensitive: false, regex: false, filter: '*.md' })
    expect(onlyMd.files.map((file) => file.name).sort()).toEqual(['a.md', 'c.md', 'd.md'])

    const noDraft = await searchWorkspace({ dir: root, query: 'needle', caseSensitive: false, regex: false, filter: '!draft/**' })
    expect(noDraft.files.map((file) => file.name).sort()).toEqual(['a.md', 'b.txt', 'd.md'])

    const notesOnly = await searchWorkspace({ dir: root, query: 'needle', caseSensitive: false, regex: false, filter: 'notes/**' })
    expect(notesOnly.files.map((file) => file.name)).toEqual(['d.md'])
    expect(notesOnly.scanned).toBe(1)

    const combined = await searchWorkspace({ dir: root, query: 'needle', caseSensitive: false, regex: false, filter: '**/*.md, !draft/**' })
    expect(combined.files.map((file) => file.name).sort()).toEqual(['a.md', 'd.md'])
  })

  it('过滤串只写了排除项时，其余文件仍然参与搜索', async () => {
    put('keep.md', 'needle\n')
    put('skip/x.md', 'needle\n')
    const result = await searchWorkspace({ dir: root, query: 'needle', caseSensitive: false, regex: false, filter: '!skip/**' })
    expect(result.files.map((file) => file.name)).toEqual(['keep.md'])
  })

  it('未授权的文件夹拒绝搜索', async () => {
    resetFileStore()
    await expect(searchWorkspace({ dir: root, query: 'x', caseSensitive: false, regex: false })).rejects.toThrow(
      FileOpError
    )
  })
})

describe('批量替换', () => {
  it('按哈希核对后写回，保留原有编码', async () => {
    const target = put('a.md', 'foo 与 foo\n')
    const found = await searchWorkspace({ dir: root, query: 'foo', caseSensitive: false, regex: false })
    const outcome = await replaceWorkspace({
      dir: root,
      query: 'foo',
      caseSensitive: false,
      regex: false,
      replacement: 'bar',
      targets: [{ path: target, hash: found.files[0].hash }]
    })
    expect(outcome.replacedFiles).toBe(1)
    expect(outcome.replacedMatches).toBe(2)
    expect(readFileSync(target, 'utf8')).toBe('bar 与 bar\n')
  })

  it('搜索之后文件被改动过就跳过，不覆盖', async () => {
    const target = put('a.md', 'foo\n')
    const found = await searchWorkspace({ dir: root, query: 'foo', caseSensitive: false, regex: false })
    writeFileSync(target, '外部改过了 foo\n', 'utf8')
    const outcome = await replaceWorkspace({
      dir: root,
      query: 'foo',
      caseSensitive: false,
      regex: false,
      replacement: 'bar',
      targets: [{ path: target, hash: found.files[0].hash }]
    })
    expect(outcome.files[0].kind).toBe('skipped')
    expect(readFileSync(target, 'utf8')).toBe('外部改过了 foo\n')
  })

  it('正则替换支持 $1 分组引用', async () => {
    const target = put('a.md', '编号 A-12\n')
    const outcome = await replaceWorkspace({
      dir: root,
      query: '([A-Z])-(\\d+)',
      caseSensitive: false,
      regex: true,
      replacement: '$1$2',
      targets: [{ path: target, hash: hashOf(target) }]
    })
    expect(outcome.replacedMatches).toBe(1)
    expect(readFileSync(target, 'utf8')).toBe('编号 A12\n')
  })

  it('字面量替换不解释 $ 占位', async () => {
    const target = put('a.md', '价格 $5\n')
    const outcome = await replaceWorkspace({
      dir: root,
      query: '$5',
      caseSensitive: false,
      regex: false,
      replacement: '$1',
      targets: [{ path: target, hash: hashOf(target) }]
    })
    expect(outcome.replacedMatches).toBe(1)
    expect(readFileSync(target, 'utf8')).toBe('价格 $1\n')
  })
})

describe('文件树操作', () => {
  it('列出子目录与文件，目录在前', async () => {
    put('b.md', '# B\n')
    put('a.md', '# A\n')
    mkdirSync(path.join(root, '子目录'))
    const entries = await listFolder(root)
    expect(entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual(['dir:子目录', 'file:a.md', 'file:b.md'])
    expect(entries[1].preview).toContain('A')
  })

  it('新建文件夹拒绝非法名字与重名', async () => {
    await createFolder(root, '笔记')
    await expect(createFolder(root, '笔记')).rejects.toThrow(/同名/)
    await expect(createFolder(root, 'a/b')).rejects.toThrow(/不能包含/)
    await expect(createFolder(root, '.dot')).rejects.toThrow(FileOpError)
  })

  it('重命名文件返回新路径，重名报错', async () => {
    const target = put('old.md', '# Old\n')
    put('other.md', '# Other\n')
    const renamed = await renamePath(target, 'new.md')
    expect(path.basename(renamed)).toBe('new.md')
    expect(readFileSync(renamed, 'utf8')).toBe('# Old\n')
    await expect(renamePath(renamed, 'other.md')).rejects.toThrow(/同名/)
  })

  it('移动文件到子目录，拒绝把目录移进自己', async () => {
    const target = put('note.md', '# Note\n')
    const sub = await createFolder(root, '子目录')
    const moved = await movePath(target, sub)
    expect(moved).toBe(path.join(sub, 'note.md'))
    expect(readFileSync(moved, 'utf8')).toBe('# Note\n')
    await expect(movePath(sub, sub)).rejects.toThrow(FileOpError)
  })
})
