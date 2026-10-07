import { describe, expect, it } from 'vitest'
import iconv from 'iconv-lite'
import {
  canRountripAs,
  decodeBuffer,
  decodeBufferWith,
  detectCodec,
  detectEol,
  encodeText
} from '../src/main/fs/encoding'
import { FileOpError } from '../src/main/fs/error'
import type { FileMeta } from '../src/shared/ipc'

const SAMPLE = '# 标题\n\n这是 **中文** 内容。\n\n| A | B |\n| - | - |\n| 1 | 2 |\n'

function metaOf(encoding: FileMeta['encoding'], eol: FileMeta['eol'] = 'lf', bom = false): FileMeta {
  return { encoding, eol, eolMixed: false, bom }
}

describe('编码探测', () => {
  it('空文件按 UTF-8 处理', () => {
    expect(detectCodec(Buffer.alloc(0))).toMatchObject({ encoding: 'utf-8', bom: false })
    const decoded = decodeBuffer(Buffer.alloc(0))
    expect(decoded.text).toBe('')
  })

  it('识别 UTF-8 与 UTF-8 BOM', () => {
    const plain = Buffer.from(SAMPLE, 'utf8')
    expect(detectCodec(plain).encoding).toBe('utf-8')

    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), plain])
    expect(detectCodec(withBom)).toMatchObject({ encoding: 'utf-8-bom', bom: true })
    const decoded = decodeBuffer(withBom)
    expect(decoded.text).toBe(SAMPLE)
    expect(decoded.meta.encoding).toBe('utf-8-bom')
  })

  it('GBK 探测、解码与字节回写', () => {
    const buffer = iconv.encode(SAMPLE, 'gbk')
    expect(detectCodec(buffer).encoding).toBe('gbk')
    const decoded = decodeBuffer(buffer)
    expect(decoded.text).toBe(SAMPLE)
    expect(Buffer.compare(encodeText(decoded.text, decoded.meta), buffer)).toBe(0)
  })

  it('GB18030 四字节字符可回写', () => {
    const text = '古文字 𠀀 测试'
    const buffer = iconv.encode(text, 'gb18030')
    const decoded = decodeBuffer(buffer)
    expect(decoded.meta.encoding).toBe('gb18030')
    expect(decoded.text).toBe(text)
    expect(Buffer.compare(encodeText(text, decoded.meta), buffer)).toBe(0)
  })

  it('UTF-16 明确拒绝而不是乱码', () => {
    const buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ab', 'utf16le')])
    const error = (() => {
      try {
        detectCodec(buffer)
        return null
      } catch (e) {
        return e
      }
    })()
    expect(error).toBeInstanceOf(FileOpError)
    expect((error as FileOpError).code).toBe('encoding-unsupported')
  })
})

describe('换行符', () => {
  it('统计 CRLF 与 LF 并判定混合', () => {
    expect(detectEol('a\nb\n')).toEqual({ eol: 'lf', eolMixed: false })
    expect(detectEol('a\r\nb\r\n')).toEqual({ eol: 'crlf', eolMixed: false })
    expect(detectEol('a\r\nb\nc')).toEqual({ eol: 'crlf', eolMixed: true })
    expect(detectEol('no newline')).toEqual({ eol: 'lf', eolMixed: false })
  })

  it('CRLF 文件读入为 LF，写回还原 CRLF', () => {
    const buffer = Buffer.from(SAMPLE.replace(/\n/g, '\r\n'), 'utf8')
    const decoded = decodeBuffer(buffer)
    expect(decoded.text).toBe(SAMPLE)
    expect(decoded.meta.eol).toBe('crlf')
    expect(Buffer.compare(encodeText(SAMPLE, decoded.meta), buffer)).toBe(0)
  })

  it('无结尾换行的文件不补换行', () => {
    const buffer = Buffer.from('# 无结尾换行', 'utf8')
    const decoded = decodeBuffer(buffer)
    expect(decoded.text).toBe('# 无结尾换行')
    expect(encodeText(decoded.text, decoded.meta)).toEqual(buffer)
  })
})

describe('强制按指定编码解码', () => {
  it('GBK 字节按 GBK 重开结果与自动检测一致', () => {
    const buffer = iconv.encode(SAMPLE.replace(/\n/g, '\r\n'), 'gbk')
    const forced = decodeBufferWith(buffer, 'gbk')
    expect(forced.text).toBe(SAMPLE)
    expect(forced.meta).toEqual({ encoding: 'gbk', eol: 'crlf', eolMixed: false, bom: false })
    expect(forced.meta).toEqual(decodeBuffer(buffer).meta)
  })

  it('GBK 字节按 Big5 重开得到文字而不是抛错', () => {
    const buffer = iconv.encode('中文测试', 'gbk')
    const forced = decodeBufferWith(buffer, 'big5')
    expect(forced.meta.encoding).toBe('big5')
    expect(forced.text.length).toBeGreaterThan(0)
  })

  it('UTF-8 字节按 GBK 重开保留原字节语义，UTF-8 重开才正确', () => {
    const buffer = Buffer.from(SAMPLE, 'utf8')
    expect(decodeBufferWith(buffer, 'utf-8').text).toBe(SAMPLE)
    expect(decodeBufferWith(buffer, 'gbk').text).not.toBe(SAMPLE)
  })

  it('选 UTF-8 (BOM) 时记住要补 BOM，选 UTF-8 时不补', () => {
    const buffer = Buffer.from('# 标题\n', 'utf8')
    expect(decodeBufferWith(buffer, 'utf-8-bom').meta.bom).toBe(true)
    expect(decodeBufferWith(buffer, 'utf-8').meta.bom).toBe(false)

    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buffer])
    const reopened = decodeBufferWith(withBom, 'utf-8')
    expect(reopened.text).toBe('# 标题\n')
    expect(reopened.meta.bom).toBe(false)
    // 写回时 UTF-8 (BOM) 会带上 BOM，UTF-8 不会
    expect(encodeText('# 标题\n', reopened.meta)).toEqual(buffer)
    expect(encodeText('# 标题\n', { ...reopened.meta, encoding: 'utf-8-bom', bom: true })).toEqual(withBom)
  })

  it('unknown 只是占位，不能作为重开选项', () => {
    expect(() => decodeBufferWith(Buffer.from('abc'), 'unknown')).toThrowError(/不支持的编码/)
  })
})

describe('不可表示字符的保护', () => {
  it('emoji 写入 GBK 会报错而不是变成问号', () => {
    expect(canRountripAs('正常中文', 'gbk')).toBe(true)
    expect(canRountripAs('带 emoji 😀 的文本', 'gbk')).toBe(false)

    let code: string | null = null
    try {
      encodeText('带 emoji 😀 的文本', metaOf('gbk'))
    } catch (error) {
      code = error instanceof FileOpError ? error.code : 'unexpected'
    }
    expect(code).toBe('encoding-lossy')
  })

  it('UTF-8 始终可表示', () => {
    expect(canRountripAs('😀 🚀', 'utf-8')).toBe(true)
    expect(encodeText('😀', metaOf('utf-8'))).toEqual(Buffer.from('😀', 'utf8'))
  })
})
