import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { listAssets, refSpellings, renameAssets, readAssetBytes, replaceAsset, parseImageTarget } from '../src/main/fs/asset-manager'
import { FileOpError } from '../src/main/fs/error'
import { grantFolder, resetFileStore } from '../src/main/fs/file-store'

const PNG_A = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
)

let root: string
let note: string
let other: string

function write(target: string, content: string | Buffer): void {
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content)
}

function assetPath(name: string): string {
  return path.join(root, 'assets', name)
}

function readText(target: string): string {
  return readFileSync(target, 'utf-8')
}

beforeEach(() => {
  resetFileStore()
  root = mkdtempSync(path.join(tmpdir(), 'mdforge-asset-manager-'))
  note = path.join(root, 'note.md')
  other = path.join(root, 'sub', 'other.md')
  write(note, '# 笔记\n\n![图](assets/a.png)\n\n![空间图](./assets/我的 图.png)\n')
  write(other, '# 其他\n\n![图](../assets/a.png)\n')
  write(assetPath('a.png'), PNG_A)
  write(assetPath('我的 图.png'), PNG_A)
  write(assetPath('unused.png'), PNG_A)
  grantFolder(root)
})

describe('引用地址解析', () => {
  it('空格、尖括号与 title 都能剥对', () => {
    expect(parseImageTarget('assets/my pic.png')).toBe('assets/my pic.png')
    expect(parseImageTarget('assets/a.png "w=640"')).toBe('assets/a.png')
    expect(parseImageTarget('<./assets/a b.png>')).toBe('./assets/a b.png')
    expect(parseImageTarget('   ')).toBeNull()
  })
})

describe('图片资源列表', () => {
  it('列出图片、尺寸与引用关系', async () => {
    const result = await listAssets(root)
    expect(result.root).toBe(path.resolve(root))
    // 与文件树同一套 localeCompare('zh-Hans-CN')：中文名排在拉丁名之前
    expect(result.assets.map((asset) => asset.relative)).toEqual(['assets/我的 图.png', 'assets/a.png', 'assets/unused.png'])
    const a = result.assets.find((asset) => asset.relative === 'assets/a.png')!
    expect(a.width).toBe(1)
    expect(a.height).toBe(1)
    expect(a.refs.map((ref) => ref.doc)).toEqual(['note.md', 'sub/other.md'])
    expect(a.refs[0].line).toBe(3)
    const spaced = result.assets.find((asset) => asset.relative === 'assets/我的 图.png')!
    // 编码过的引用也要能找到
    expect(spaced.refs).toEqual([{ doc: 'note.md', line: 5 }])
    const unused = result.assets.find((asset) => asset.relative === 'assets/unused.png')!
    expect(unused.refs).toEqual([])
    expect(result.docs).toBe(2)
  })

  it('未授权的目录拒绝扫描', async () => {
    resetFileStore()
    await expect(listAssets(root)).rejects.toBeInstanceOf(FileOpError)
  })
})

describe('批量重命名与引用改写', () => {
  it('改名后所有文档里的引用跟着换，编码写法也换', async () => {
    const result = await renameAssets({
      root,
      renames: [
        { from: assetPath('a.png'), to: 'hero.png' },
        { from: assetPath('我的 图.png'), to: 'cover.png' }
      ],
      skip: []
    })
    expect(result.files.every((file) => file.kind === 'ok')).toBe(true)
    expect(result.touched.sort()).toEqual([note, other].sort())
    expect(result.refs).toBe(3)
    expect(readText(note)).toContain('![图](assets/hero.png)')
    expect(readText(note)).toContain('![空间图](./assets/cover.png)')
    expect(readText(other)).toContain('![图](../assets/hero.png)')
    expect(existsSync(assetPath('hero.png'))).toBe(true)
    expect(existsSync(assetPath('a.png'))).toBe(false)
  })

  it('skip 里的文档不动磁盘，其余照常改', async () => {
    const result = await renameAssets({
      root,
      renames: [{ from: assetPath('a.png'), to: 'hero.png' }],
      skip: [note]
    })
    expect(result.touched).toEqual([other])
    expect(readText(note)).toContain('assets/a.png')
    expect(readText(other)).toContain('../assets/hero.png')
  })

  it('目标同名与非法名逐个报错，不拖累其他条目', async () => {
    const result = await renameAssets({
      root,
      renames: [
        { from: assetPath('a.png'), to: 'unused.png' },
        { from: assetPath('我的 图.png'), to: 'bad/name.png' },
        { from: assetPath('unused.png'), to: 'ok.png' }
      ],
      skip: []
    })
    expect(result.files[0].kind).toBe('error')
    expect(result.files[1].kind).toBe('error')
    expect(result.files[2].kind).toBe('ok')
    expect(existsSync(assetPath('ok.png'))).toBe(true)
  })

  it('重命名计划里，不同目录的文档各自算相对路径', async () => {
    const spells = refSpellings(path.join(root, 'sub'), assetPath('a.png'), assetPath('hero.png'))
    expect(spells).toContainEqual(['../assets/a.png', '../assets/hero.png'])
    const same = refSpellings(root, assetPath('a.png'), assetPath('hero.png'))
    expect(same).toContainEqual(['assets/a.png', 'assets/hero.png'])
  })
})

describe('压缩写回', () => {
  it('同名覆盖只换字节，不动引用', async () => {
    const bytes = new Uint8Array([...PNG_A, 0x00])
    const result = await replaceAsset({ root, path: assetPath('a.png'), bytes, skip: [] })
    expect(result.path).toBe(assetPath('a.png'))
    expect(result.touched).toEqual([])
    expect(readFileSync(assetPath('a.png')).length).toBe(PNG_A.length + 1)
    expect(readText(note)).toContain('assets/a.png')
  })

  it('换扩展名时写新文件、删旧文件并改写引用', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const result = await replaceAsset({
      root,
      path: assetPath('a.png'),
      bytes,
      newName: 'a.webp',
      skip: []
    })
    expect(result.path).toBe(assetPath('a.webp'))
    expect(existsSync(assetPath('a.png'))).toBe(false)
    expect(existsSync(assetPath('a.webp'))).toBe(true)
    expect(result.refs).toBe(2)
    expect(readText(note)).toContain('assets/a.webp')
    expect(readText(other)).toContain('../assets/a.webp')
  })

  it('空内容与超范围路径都拒绝', async () => {
    await expect(replaceAsset({ root, path: assetPath('a.png'), bytes: new Uint8Array(0), skip: [] })).rejects.toBeInstanceOf(
      FileOpError
    )
    await expect(
      replaceAsset({ root, path: path.join(tmpdir(), 'outside.png'), bytes: new Uint8Array([1]), skip: [] })
    ).rejects.toBeInstanceOf(FileOpError)
  })
})

describe('读取图片字节', () => {
  it('已授权路径能读出内容', async () => {
    const bytes = await readAssetBytes(assetPath('a.png'))
    expect(Buffer.from(bytes).equals(PNG_A)).toBe(true)
  })

  it('未授权或非图片拒绝', async () => {
    await expect(readAssetBytes(path.join(tmpdir(), 'x.png'))).rejects.toBeInstanceOf(FileOpError)
    await expect(readAssetBytes(note)).rejects.toBeInstanceOf(FileOpError)
  })
})
