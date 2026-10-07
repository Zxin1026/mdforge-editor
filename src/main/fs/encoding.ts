import iconv from 'iconv-lite'
import { detect } from 'jschardet'
import type { Eol, FileMeta, MdEncoding } from '../../shared/ipc'
import { FileOpError } from './error'

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

export interface CodecInfo {
  encoding: MdEncoding
  codec: string
  bom: boolean
}

export interface DecodedFile {
  text: string
  meta: FileMeta
}

function codecFor(encoding: MdEncoding): string {
  switch (encoding) {
    case 'utf-8':
    case 'utf-8-bom':
      return 'utf8'
    case 'gbk':
      return 'gbk'
    case 'gb18030':
      return 'gb18030'
    case 'big5':
      return 'big5'
    default:
      throw new FileOpError('encoding-unsupported', `不支持的编码：${encoding}`)
  }
}

function decodeStrictUtf8(buffer: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer)
  } catch {
    return null
  }
}

const LEGACY_CANDIDATES: ReadonlyArray<{ encoding: MdEncoding; codec: string }> = [
  { encoding: 'gbk', codec: 'gbk' },
  { encoding: 'big5', codec: 'big5' },
  { encoding: 'gb18030', codec: 'gb18030' }
]

/** jschardet 对短中文文本经常报 GB18030 或 CP949，只当作提示，最终由字节回环决定 */
function hintFor(label: string): { encoding: MdEncoding; codec: string } | null {
  const normalized = label.toUpperCase().replace(/[-_\s]/g, '')
  if (normalized === 'BIG5') return { encoding: 'big5', codec: 'big5' }
  if (normalized === 'GB18030') return { encoding: 'gb18030', codec: 'gb18030' }
  if (normalized === 'GB2312' || normalized === 'GBK') return { encoding: 'gbk', codec: 'gbk' }
  return null
}

function validates(buffer: Buffer, codec: string): boolean {
  if (!iconv.encodingExists(codec)) return false
  try {
    const text = iconv.decode(buffer, codec)
    if (text.includes('\uFFFD')) return false
    return Buffer.compare(iconv.encode(text, codec), buffer) === 0
  } catch {
    return false
  }
}

export function detectCodec(buffer: Buffer): CodecInfo {
  if (buffer.length === 0) return { encoding: 'utf-8', codec: 'utf8', bom: false }

  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(UTF8_BOM)) {
    return { encoding: 'utf-8-bom', codec: 'utf8', bom: true }
  }

  // UTF-16/32 的 BOM 先判掉，否则严格 UTF-8 解码会以非法序列失败并落到猜测分支
  if (buffer.length >= 2) {
    const head = buffer.subarray(0, 2)
    if (head.equals(Buffer.from([0xff, 0xfe])) || head.equals(Buffer.from([0xfe, 0xff]))) {
      throw new FileOpError('encoding-unsupported', 'UTF-16 编码的 Markdown 文件暂不支持', {
        hint: '请先把文件转换为 UTF-8 再打开'
      })
    }
  }

  if (decodeStrictUtf8(buffer) !== null) return { encoding: 'utf-8', codec: 'utf8', bom: false }

  const label = detect(buffer).encoding ?? ''
  const hint = hintFor(label)
  const order = hint
    ? [hint, ...LEGACY_CANDIDATES.filter((candidate) => candidate.codec !== hint.codec)]
    : [...LEGACY_CANDIDATES]

  for (const candidate of order) {
    if (!validates(buffer, candidate.codec)) continue
    if (candidate.encoding === 'gb18030' && validates(buffer, 'gbk')) {
      return { encoding: 'gbk', codec: 'gbk', bom: false }
    }
    return { encoding: candidate.encoding, codec: candidate.codec, bom: false }
  }

  throw new FileOpError('encoding-unsupported', `无法识别文件编码（检测结果：${label || '无'}）`, {
    hint: '请用 UTF-8 重新保存该文件'
  })
}

export function detectEol(raw: string): { eol: Eol; eolMixed: boolean } {
  const total = raw.split('\n').length - 1
  const crlf = raw.split('\r\n').length - 1
  const lf = total - crlf
  return { eol: crlf > 0 && crlf >= lf ? 'crlf' : 'lf', eolMixed: crlf > 0 && lf > 0 }
}

export function toEditorText(raw: string): string {
  return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

export function decodeBuffer(buffer: Buffer): DecodedFile {
  const { encoding, codec, bom } = detectCodec(buffer)
  const body = bom ? buffer.subarray(3) : buffer
  const raw = encoding === 'utf-8' || encoding === 'utf-8-bom' ? body.toString('utf8') : iconv.decode(body, codec)
  const { eol, eolMixed } = detectEol(raw)
  return { text: toEditorText(raw), meta: { encoding, eol, eolMixed, bom } }
}

/**
 * 按用户点选的编码强行解码（不做任何猜测）。
 * 自动检测错判或干脆失败时，这是唯一的纠正入口，因此宁可解出 U+FFFD 也不抛错。
 */
export function decodeBufferWith(buffer: Buffer, encoding: MdEncoding): DecodedFile {
  const wantsBom = encoding === 'utf-8-bom'
  const isUtf8 = encoding === 'utf-8' || wantsBom
  const hasBom = isUtf8 && buffer.length >= 3 && buffer.subarray(0, 3).equals(UTF8_BOM)
  const body = hasBom ? buffer.subarray(3) : buffer
  const raw = isUtf8 ? body.toString('utf8') : iconv.decode(body, codecFor(encoding))
  const { eol, eolMixed } = detectEol(raw)
  return { text: toEditorText(raw), meta: { encoding, eol, eolMixed, bom: wantsBom } }
}

export function canRountripAs(text: string, encoding: MdEncoding): boolean {
  if (encoding === 'utf-8' || encoding === 'utf-8-bom') return true
  const codec = codecFor(encoding)
  const back = iconv.decode(iconv.encode(text, codec), codec)
  return back === text
}

export function encodeText(text: string, meta: FileMeta, filePath?: string): Buffer {
  const body = meta.eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text

  if (meta.encoding === 'utf-8' || meta.encoding === 'utf-8-bom') {
    const utf8 = Buffer.from(body, 'utf8')
    return meta.bom ? Buffer.concat([UTF8_BOM, utf8]) : utf8
  }

  if (!canRountripAs(body, meta.encoding)) {
    throw new FileOpError('encoding-lossy', `内容含有无法用 ${meta.encoding} 表示的字符，直接保存会丢失文字`, {
      path: filePath,
      hint: '改用 UTF-8 保存，或去掉这些字符后再保存'
    })
  }

  return iconv.encode(body, codecFor(meta.encoding))
}
