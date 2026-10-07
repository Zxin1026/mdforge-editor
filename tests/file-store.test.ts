import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import iconv from 'iconv-lite'
import { NEW_FILE_META } from '../src/renderer/src/doc'
import { FileOpError } from '../src/main/fs/error'
import {
  diskState,
  grantPath,
  readFile,
  readFileWithEncoding,
  rememberedHash,
  resetFileStore,
  writeFile
} from '../src/main/fs/file-store'
import type { FileMeta, WriteRequest } from '../src/shared/ipc'

let dir: string

beforeEach(() => {
  resetFileStore()
  dir = mkdtempSync(path.join(tmpdir(), 'mdforge-test-'))
})

function fileIn(name: string): string {
  return path.join(dir, name)
}

function writeRaw(target: string, buffer: Buffer | string): string {
  writeFileSync(target, buffer)
  grantPath(target)
  return target
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

describe('授权', () => {
  it('未经选择的文件拒绝读取', async () => {
    const target = fileIn('secret.md')
    writeFileSync(target, '# 未授权', 'utf8')
    const error = await expectError(() => readFile(target))
    expect(error.code).toBe('not-granted')
  })

  it('空路径与含 NUL 的路径判为非法', async () => {
    expect((await expectError(() => readFile(''))).code).toBe('invalid-path')
    expect((await expectError(() => readFile(fileIn('a\0.md')))).code).toBe('invalid-path')
  })

  it('已授权路径大小写不同仍可读取', async () => {
    const target = writeRaw(fileIn('Case.md'), '# Case')
    const again = path.join(path.dirname(target), path.basename(target).toLowerCase())
    grantPath(again)
    expect((await readFile(again)).path.toLowerCase()).toBe(again.toLowerCase())
  })

  it('不存在的文件报 not-found', async () => {
    const target = fileIn('missing.md')
    grantPath(target)
    const error = await expectError(() => readFile(target))
    expect(error.code).toBe('not-found')
    expect(error.path).toContain('missing.md')
  })
})

describe('字节保真写回', () => {
  const cases: Array<{ name: string; bytes: Buffer; encoding: FileMeta['encoding'] }> = [
    { name: 'utf8-lf.md', bytes: Buffer.from('# 标题\n\n内容\n', 'utf8'), encoding: 'utf-8' },
    {
      name: 'utf8-bom-crlf.md',
      bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# 标题\r\n\r\n内容\r\n', 'utf8')]),
      encoding: 'utf-8-bom'
    },
    { name: 'gbk-crlf.md', bytes: iconv.encode('# 标题\r\n\r\n中文内容\r\n', 'gbk'), encoding: 'gbk' },
    { name: 'no-final-newline.md', bytes: Buffer.from('# 结尾无换行', 'utf8'), encoding: 'utf-8' }
  ]

  for (const testCase of cases) {
    it(`${testCase.name}：不改动直接保存，字节完全一致`, async () => {
      const target = writeRaw(fileIn(testCase.name), testCase.bytes)
      const snapshot = await readFile(target)
      expect(snapshot.meta.encoding).toBe(testCase.encoding)

      const request: WriteRequest = {
        path: target,
        text: snapshot.text,
        meta: snapshot.meta,
        baseHash: snapshot.hash
      }
      await writeFile(request)
      expect(readFileSync(target)).toEqual(testCase.bytes)
    })
  }

  it('改动后保存仍按原编码与原换行写回', async () => {
    const bytes = iconv.encode('# 标题\n\n原文\n', 'gbk')
    const target = writeRaw(fileIn('gbk-edit.md'), bytes)
    const snapshot = await readFile(target)

    await writeFile({
      path: target,
      text: `${snapshot.text}追加一行\n`,
      meta: { ...snapshot.meta, eol: 'crlf' },
      baseHash: snapshot.hash
    })

    const written = readFileSync(target)
    expect(iconv.decode(written, 'gbk')).toBe('# 标题\r\n\r\n原文\r\n追加一行\r\n')
    expect(written.includes(0x0a)).toBe(true)
    expect(written.includes(0xef)).toBe(false)
  })

  it('新建文档使用 UTF-8 与 CRLF 且无 BOM', async () => {
    const target = fileIn('brand-new.md')
    grantPath(target)
    const snapshot = await writeFile({
      path: target,
      text: '# 新建\n',
      meta: NEW_FILE_META,
      baseHash: '',
      force: true
    })
    expect(snapshot.meta.encoding).toBe('utf-8')
    expect(readFileSync(target, 'utf8')).toBe('# 新建\r\n')
  })

  it('中文与空格目录可读写', async () => {
    const nested = path.join(dir, '文档 目录')
    const target = path.join(nested, '说明 文件.md')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(nested, { recursive: true })
    writeRaw(target, Buffer.from('# 中文路径 测试\n', 'utf8'))
    const snapshot = await readFile(target)
    expect(snapshot.text).toBe('# 中文路径 测试\n')
    await writeFile({ path: target, text: snapshot.text, meta: snapshot.meta, baseHash: snapshot.hash })
    expect(readFileSync(target, 'utf8')).toBe('# 中文路径 测试\n')
  })

  it('保存后不遗留临时文件', async () => {
    const target = writeRaw(fileIn('clean.md'), '# 清理\n')
    const snapshot = await readFile(target)
    await writeFile({
      path: target,
      text: `${snapshot.text}改一行\n`,
      meta: snapshot.meta,
      baseHash: snapshot.hash
    })
    expect(readdirSync(dir).filter((name) => name.includes('mdforge-tmp'))).toEqual([])
  })
})

describe('按指定编码重开', () => {
  it('GBK 文件强制按 UTF-8 重开会解出替换符，再按 GBK 重开恢复正常', async () => {
    const target = writeRaw(fileIn('reopen.md'), iconv.encode('# 中文\n', 'gbk'))
    expect((await readFile(target)).meta.encoding).toBe('gbk')

    const asUtf8 = await readFileWithEncoding(target, 'utf-8')
    expect(asUtf8.meta.encoding).toBe('utf-8')
    expect(asUtf8.text.includes('\uFFFD')).toBe(true)

    const backToGbk = await readFileWithEncoding(target, 'gbk')
    expect(backToGbk.text).toBe('# 中文\n')
    expect(backToGbk.meta.eol).toBe('lf')
  })

  it('按指定编码重开后写回，字节按新编码走', async () => {
    const original = iconv.encode('# 转码\n', 'gbk')
    const target = writeRaw(fileIn('convert.md'), original)

    // 强制按 GBK 重开：与自动检测结果一致，写回应保持字节完全相同
    const reopened = await readFileWithEncoding(target, 'gbk')
    expect(reopened.text).toBe('# 转码\n')
    await writeFile({ path: target, text: reopened.text, meta: reopened.meta, baseHash: reopened.hash })
    expect(readFileSync(target)).toEqual(original)

    // 换成 UTF-8 写回就是转码，不再被"自己刚写过盘"当成冲突
    const utf8Request: WriteRequest = {
      path: target,
      text: reopened.text,
      meta: { ...reopened.meta, encoding: 'utf-8', bom: false },
      baseHash: reopened.hash
    }
    const converted = await writeFile(utf8Request)
    expect(readFileSync(target, 'utf8')).toBe('# 转码\n')
    expect(converted.meta.encoding).toBe('utf-8')

    // 基准没跟着更新就还是冲突：只有刚载入/刚保存的那个哈希才允许直接写
    const stale = await expectError(() =>
      writeFile({ ...utf8Request, text: `${utf8Request.text}再加一行\n`, baseHash: reopened.hash })
    )
    expect(stale.code).toBe('conflict')
    const fresh = await writeFile({ ...utf8Request, text: `${utf8Request.text}再加一行\n`, baseHash: converted.hash })
    expect(readFileSync(target, 'utf8')).toBe(`${utf8Request.text}再加一行\n`)
    expect(fresh.meta.encoding).toBe('utf-8')
  })

  it('未授权的路径不能借强制编码绕过', async () => {
    const target = fileIn('private.md')
    writeFileSync(target, '# 未授权\n', 'utf8')
    const error = await expectError(() => readFileWithEncoding(target, 'gbk'))
    expect(error.code).toBe('not-granted')
  })

  it('diskState 与 rememberedHash 反映最近一次载入/保存', async () => {
    const target = writeRaw(fileIn('state.md'), '# 状态\n')
    const loadedSnapshot = await readFile(target)
    expect(rememberedHash(target)).toBe(loadedSnapshot.hash)
    expect((await diskState(target))?.hash).toBe(loadedSnapshot.hash)

    writeFileSync(target, '# 外部改动\n', 'utf8')
    expect(rememberedHash(target)).toBe(loadedSnapshot.hash)
    expect((await diskState(target))?.hash).not.toBe(loadedSnapshot.hash)

    rmSync(target)
    expect(await diskState(target)).toBeNull()
  })
})

describe('外部修改冲突', () => {
  it('磁盘内容被外部改动时拒绝保存', async () => {
    const target = writeRaw(fileIn('conflict.md'), '# 原始\n')
    const snapshot = await readFile(target)
    writeFileSync(target, '# 外部改动\n', 'utf8')

    const error = await expectError(() =>
      writeFile({
        path: target,
        text: `${snapshot.text}本地新增\n`,
        meta: snapshot.meta,
        baseHash: snapshot.hash
      })
    )
    expect(error.code).toBe('conflict')
    expect(readFileSync(target, 'utf8')).toBe('# 外部改动\n')
  })

  it('force 覆盖后基准更新，可再次保存', async () => {
    const target = writeRaw(fileIn('force.md'), '# 原始\n')
    const snapshot = await readFile(target)
    writeFileSync(target, '# 外部改动\n', 'utf8')

    const text = `${snapshot.text}本地新增\n`
    const forced = await writeFile({ path: target, text, meta: snapshot.meta, baseHash: snapshot.hash, force: true })
    expect(readFileSync(target, 'utf8')).toBe(text)

    const again = await writeFile({ path: target, text: `${text}再改\n`, meta: forced.meta, baseHash: forced.hash })
    expect(again.hash).not.toBe(forced.hash)
    expect(readFileSync(target, 'utf8')).toBe(`${text}再改\n`)
  })
})
