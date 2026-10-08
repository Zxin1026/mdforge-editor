import { describe, expect, it } from 'vitest'
import { imageSizeOf, isImagePath } from '../src/main/fs/image-meta'

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

function gif(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(16)
  buffer.write('GIF89a', 0, 'ascii')
  buffer.writeUInt16LE(width, 6)
  buffer.writeUInt16LE(height, 8)
  return buffer
}

function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.alloc(6)
  app0.writeUInt16BE(0xffe0, 0)
  app0.writeUInt16BE(4, 2)
  app0.writeUInt16BE(0, 4)
  const sof = Buffer.alloc(11)
  sof.writeUInt16BE(0xffc0, 0)
  sof.writeUInt16BE(11, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])])
}

function webpVp8x(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(30)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(22, 4)
  buffer.write('WEBP', 8, 'ascii')
  buffer.write('VP8X', 12, 'ascii')
  buffer.writeUInt32LE(10, 16)
  buffer.writeUIntLE(width - 1, 24, 3)
  buffer.writeUIntLE(height - 1, 27, 3)
  return buffer
}

function bmp(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(30)
  buffer.write('BM', 0, 'ascii')
  buffer.writeInt32LE(width, 18)
  buffer.writeInt32LE(height, 22)
  return buffer
}

function ico(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(8)
  buffer.writeUInt16LE(0, 0)
  buffer.writeUInt16LE(1, 2)
  buffer.writeUInt16LE(1, 4)
  buffer[6] = width >= 256 ? 0 : width
  buffer[7] = height >= 256 ? 0 : height
  return buffer
}

describe('图片尺寸解析', () => {
  it('认得出常见位图格式的宽高', () => {
    expect(imageSizeOf(png(640, 480), 'a.png')).toEqual({ width: 640, height: 480 })
    expect(imageSizeOf(gif(320, 200), 'a.gif')).toEqual({ width: 320, height: 200 })
    expect(imageSizeOf(jpeg(1024, 768), 'a.jpg')).toEqual({ width: 1024, height: 768 })
    expect(imageSizeOf(jpeg(50, 60), 'a.jpeg')).toEqual({ width: 50, height: 60 })
    expect(imageSizeOf(webpVp8x(800, 600), 'a.webp')).toEqual({ width: 800, height: 600 })
    expect(imageSizeOf(bmp(128, 96), 'a.bmp')).toEqual({ width: 128, height: 96 })
    expect(imageSizeOf(ico(32, 32), 'a.ico')).toEqual({ width: 32, height: 32 })
    expect(imageSizeOf(ico(256, 256), 'a.ico')).toEqual({ width: 256, height: 256 })
  })

  it('SVG 先读 width/height，缺了退回 viewBox', () => {
    const withAttrs = Buffer.from('<svg width="120px" height="80" xmlns="http://www.w3.org/2000/svg"></svg>')
    expect(imageSizeOf(withAttrs, 'a.svg')).toEqual({ width: 120, height: 80 })
    const withBox = Buffer.from('<svg viewBox="0 0 240 180" xmlns="http://www.w3.org/2000/svg"></svg>')
    expect(imageSizeOf(withBox, 'a.svg')).toEqual({ width: 240, height: 180 })
  })

  it('文件头损坏或格式不认识时返回 null', () => {
    expect(imageSizeOf(Buffer.from('not an image'), 'a.png')).toBeNull()
    expect(imageSizeOf(Buffer.alloc(0), 'a.jpg')).toBeNull()
    expect(imageSizeOf(png(0, 10), 'a.png')).toBeNull()
    expect(imageSizeOf(Buffer.from('MZ'), 'a.exe')).toBeNull()
  })

  it('isImagePath 只认图片扩展名', () => {
    expect(isImagePath('C:/a/b.png')).toBe(true)
    expect(isImagePath('x.JPEG')).toBe(true)
    expect(isImagePath('x.md')).toBe(false)
    expect(isImagePath('x')).toBe(false)
  })
})
