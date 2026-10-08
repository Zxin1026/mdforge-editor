import path from 'node:path'

export interface ImageSize {
  width: number
  height: number
}

/** 资源管理器认得的图片扩展名（与 asset-store 的 MIME 表同一口径） */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif', '.ico'])

export function isImagePath(target: string): boolean {
  return IMAGE_EXT.has(path.extname(target).toLowerCase())
}

function positive(width: number, height: number): ImageSize | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width: Math.round(width), height: Math.round(height) }
}

function pngSize(buffer: Buffer): ImageSize | null {
  const SIGN = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(SIGN)) return null
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null
  return positive(buffer.readUInt32BE(16), buffer.readUInt32BE(20))
}

function gifSize(buffer: Buffer): ImageSize | null {
  const head = buffer.toString('ascii', 0, 6)
  if (buffer.length < 10 || (head !== 'GIF87a' && head !== 'GIF89a')) return null
  return positive(buffer.readUInt16LE(6), buffer.readUInt16LE(8))
}

/** JPEG：跳过各段，找 SOF0-SOF15（C4/C8/CC 除外）里的尺寸 */
function jpegSize(buffer: Buffer): ImageSize | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null
  let offset = 2
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = buffer[offset + 1]
    // 填充字节与无载荷标记：继续往后找
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += marker === 0xff ? 1 : 2
      continue
    }
    if (offset + 4 > buffer.length) return null
    const length = buffer.readUInt16BE(offset + 2)
    if (length < 2) return null
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (offset + 9 > buffer.length) return null
      return positive(buffer.readUInt16BE(offset + 7), buffer.readUInt16BE(offset + 5))
    }
    offset += 2 + length
  }
  return null
}

function webpSize(buffer: Buffer): ImageSize | null {
  if (buffer.length < 30) return null
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null
  const form = buffer.toString('ascii', 12, 16)
  if (form === 'VP8 ') {
    return positive(buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff)
  }
  if (form === 'VP8L') {
    const bits = buffer.readUInt32LE(21)
    return positive((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
  }
  if (form === 'VP8X') {
    return positive(buffer.readUIntLE(24, 3) + 1, buffer.readUIntLE(27, 3) + 1)
  }
  return null
}

function bmpSize(buffer: Buffer): ImageSize | null {
  if (buffer.length < 26 || buffer[0] !== 0x42 || buffer[1] !== 0x4d) return null
  return positive(buffer.readInt32LE(18), Math.abs(buffer.readInt32LE(22)))
}

function icoSize(buffer: Buffer): ImageSize | null {
  if (buffer.length < 8 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) return null
  // 图标尺寸字段 1 字节，0 表示 256
  return positive(buffer[6] === 0 ? 256 : buffer[6], buffer[7] === 0 ? 256 : buffer[7])
}

/** AVIF：在文件头里找 ispe box，拿真实像素尺寸 */
function avifSize(buffer: Buffer): ImageSize | null {
  const index = buffer.indexOf('ispe', 0, 'ascii')
  if (index < 0 || index + 16 > buffer.length) return null
  return positive(buffer.readUInt32BE(index + 8), buffer.readUInt32BE(index + 12))
}

/** SVG：先读 width/height 属性，缺了再退回 viewBox */
function svgSize(buffer: Buffer): ImageSize | null {
  const text = buffer.toString('utf8')
  const tag = /<svg\b[^>]*>/i.exec(text)
  if (!tag) return null
  const attribute = (name: string): number | null => {
    const match = new RegExp(`\\b${name}\\s*=\\s*["']?([\\d.]+)(?:px)?["']?`, 'i').exec(tag[0])
    if (!match) return null
    const value = Number.parseFloat(match[1])
    return Number.isFinite(value) && value > 0 ? value : null
  }
  const width = attribute('width')
  const height = attribute('height')
  if (width !== null && height !== null) return positive(width, height)
  const box = /\bviewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/i.exec(tag[0])
  if (box) return positive(Number.parseFloat(box[1]), Number.parseFloat(box[2]))
  return null
}

/**
 * 从文件头解析图片尺寸。只认结构简单的几种格式；
 * 解不出来（或文件头不完整）返回 null，列表里显示为未知尺寸。
 */
export function imageSizeOf(buffer: Buffer, target: string): ImageSize | null {
  const ext = path.extname(target).toLowerCase()
  if (ext === '.png') return pngSize(buffer)
  if (ext === '.gif') return gifSize(buffer)
  if (ext === '.jpg' || ext === '.jpeg') return jpegSize(buffer)
  if (ext === '.webp') return webpSize(buffer)
  if (ext === '.bmp') return bmpSize(buffer)
  if (ext === '.ico') return icoSize(buffer)
  if (ext === '.avif') return avifSize(buffer)
  if (ext === '.svg') return svgSize(buffer)
  return null
}
