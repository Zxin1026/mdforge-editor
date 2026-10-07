import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { FileOpError } from '../src/main/fs/error'
import { grantFolder, grantPath, isUnderGrantedRoot, resetFileStore } from '../src/main/fs/file-store'
import { MAX_ASSET_BYTES, sanitizeAssetName, saveAsset } from '../src/main/fs/asset-store'
import type { AssetWriteInput } from '../src/shared/ipc'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02])
const OTHER = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x09, 0x08])

let dir: string
let doc: string

beforeEach(() => {
  resetFileStore()
  dir = mkdtempSync(path.join(tmpdir(), 'mdforge-test-'))
  doc = path.join(dir, 'note.md')
  writeFileSync(doc, '# 笔记\n', 'utf8')
})

function grantedDoc(): string {
  grantPath(doc)
  return doc
}

function makeInput(name: string, bytes: Uint8Array = PNG, docPath = grantedDoc()): AssetWriteInput {
  return { docPath, name, bytes }
}

function assetsDir(): string {
  return path.join(dir, 'assets')
}

function namesIn(target: string): string[] {
  return existsSync(target) ? readdirSync(target).sort() : []
}

async function expectError(action: () => Promise<unknown>): Promise<FileOpError> {
  try {
    await action()
  } catch (error) {
    expect(error).toBeInstanceOf(FileOpError)
    return error as FileOpError
  }
  throw new Error('期望抛出 FileOpError，但成功了')
}

describe('贴图落盘授权', () => {
  it('文档未经用户选择时拒绝写入', async () => {
    const error = await expectError(() => saveAsset(makeInput('shot.png', PNG, doc)))
    expect(error.code).toBe('not-granted')
    expect(existsSync(assetsDir())).toBe(false)
  })

  it('空路径与相对路径的文档判为不可用', async () => {
    expect((await expectError(() => saveAsset(makeInput('shot.png', PNG, '')))).code).toBe('not-granted')
    expect((await expectError(() => saveAsset(makeInput('shot.png', PNG, 'note.md')))).code).toBe('not-granted')
  })

  it('打开文件夹后，其内文档可以直接落盘', async () => {
    grantFolder(dir)
    const result = await saveAsset(makeInput('shot.png', PNG, doc))
    expect(result.relative).toBe('assets/shot.png')
    expect(readFileSync(result.absolute)).toEqual(Buffer.from(PNG))
  })
})

describe('贴图落盘', () => {
  it('写到文档同级 assets/，relative 为 POSIX 风格相对链接', async () => {
    const result = await saveAsset(makeInput('screenshot-2.png'))
    expect(result.name).toBe('screenshot-2.png')
    expect(result.relative).toBe('assets/screenshot-2.png')
    expect(result.absolute).toBe(path.join(assetsDir(), 'screenshot-2.png'))
    expect(result.relative.includes('\\')).toBe(false)
    expect(readFileSync(result.absolute)).toEqual(Buffer.from(PNG))
    expect(namesIn(dir)).toEqual(['assets', 'note.md'])
  })

  it('写入的文件立刻满足 mdasset 协议的授权闸门', async () => {
    const result = await saveAsset(makeInput('shot.png'))
    expect(isUnderGrantedRoot(result.absolute)).toBe(true)
  })

  it('assets/ 目录不存在时自动创建', async () => {
    expect(existsSync(assetsDir())).toBe(false)
    await saveAsset(makeInput('a.png'))
    expect(existsSync(assetsDir())).toBe(true)
  })

  it('同名图片不覆盖，第二个加 -1 后缀', async () => {
    const first = await saveAsset(makeInput('shot.png', PNG))
    const second = await saveAsset(makeInput('shot.png', OTHER))

    expect(second.name).toBe('shot-1.png')
    expect(second.relative).toBe('assets/shot-1.png')
    expect(readFileSync(first.absolute)).toEqual(Buffer.from(PNG))
    expect(readFileSync(second.absolute)).toEqual(Buffer.from(OTHER))
    expect(namesIn(assetsDir())).toEqual(['shot-1.png', 'shot.png'])
  })

  it('空字节拒绝且不创建 assets/', async () => {
    const error = await expectError(() => saveAsset(makeInput('shot.png', new Uint8Array(0))))
    expect(error.code).toBe('invalid-path')
    expect(existsSync(assetsDir())).toBe(false)
  })

  it('超过大小上限拒绝', async () => {
    const huge = new Uint8Array(MAX_ASSET_BYTES + 1)
    const error = await expectError(() => saveAsset(makeInput('huge.png', huge)))
    expect(error.code).toBe('invalid-path')
    expect(error.hint).toBeTruthy()
    expect(namesIn(assetsDir())).toEqual([])
  })
})

describe('文件名清洗', () => {
  it('目录写法一律丢弃，只剩文件名本体', () => {
    expect(sanitizeAssetName('../../evil.png')).toBe('evil.png')
    expect(sanitizeAssetName('C:\\windows\\temp\\x.png')).toBe('x.png')
    expect(sanitizeAssetName('/etc/passwd.png')).toBe('passwd.png')
    expect(sanitizeAssetName('a/b/c/shot')).toBe('shot.png')
  })

  it('非法字符换成连字符，中文与空名退回默认名', () => {
    expect(sanitizeAssetName('my shot(1)#$.png')).toBe('my shot-1.png')
    expect(sanitizeAssetName('.hidden.png')).toBe('hidden.png')
    expect(sanitizeAssetName('截图.png')).toBe('image.png')
    expect(sanitizeAssetName('')).toBe('image.png')
    expect(sanitizeAssetName('..')).toBe('image.png')
    expect(sanitizeAssetName('con.png')).toBe('image.png')
    expect(sanitizeAssetName(`${'a'.repeat(200)}.png`)).toBe(`${'a'.repeat(64)}.png`)
  })

  it('扩展名只认白名单，其余按 mime 或 png 兜底', () => {
    expect(sanitizeAssetName('report.pdf')).toBe('report.png')
    expect(sanitizeAssetName('Photo.JPG')).toBe('Photo.jpg')
    expect(sanitizeAssetName('keep.gif')).toBe('keep.gif')
    expect(sanitizeAssetName('shot', 'image/webp')).toBe('shot.webp')
    expect(sanitizeAssetName('evil.exe', 'image/jpeg')).toBe('evil.jpg')
    expect(sanitizeAssetName('real.png', 'application/pdf')).toBe('real.png')
  })

  it('带穿越写的名字最终仍落在 assets/ 内', async () => {
    const result = await saveAsset(makeInput('../../../../escape.png'))
    expect(result.name).toBe('escape.png')
    expect(path.dirname(result.absolute)).toBe(assetsDir())
    expect(namesIn(assetsDir())).toEqual(['escape.png'])
    expect(namesIn(dir)).toEqual(['assets', 'note.md'])
    expect(existsSync(path.join(dir, 'escape.png'))).toBe(false)
    expect(existsSync(path.join(path.dirname(dir), 'escape.png'))).toBe(false)
  })

  it('绝对路径写法的剪贴板文件也只在 assets/ 内生成一个文件', async () => {
    const result = await saveAsset(makeInput('C:\\Users\\me\\Pictures\\screenshot 3.png'))
    expect(result.relative).toBe('assets/screenshot 3.png')
    expect(namesIn(assetsDir())).toEqual(['screenshot 3.png'])
  })
})
