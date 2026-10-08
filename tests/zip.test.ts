import { describe, expect, it } from 'vitest'
import { createZip, readZip, type ZipEntry } from '../src/main/fs/zip'

const ENTRIES: ZipEntry[] = [
  { name: 'mimetype', data: Buffer.from('application/epub+zip', 'ascii'), store: true },
  { name: 'META-INF/container.xml', data: Buffer.from('<container/>', 'utf8') },
  { name: 'OEBPS/第一章.xhtml', data: Buffer.from('<html>中文内容</html>'.repeat(50), 'utf8') }
]

describe('zip 打包', () => {
  it('写完能原样读回（存储与压缩两种方法）', () => {
    const zip = createZip(ENTRIES)
    const back = readZip(zip)
    expect(back.map((entry) => entry.name)).toEqual(ENTRIES.map((entry) => entry.name))
    for (const [index, entry] of back.entries()) {
      expect(entry.data.equals(ENTRIES[index].data)).toBe(true)
    }
  })

  it('mimetype 是第一条且不压缩（EPUB 的硬要求）', () => {
    const zip = createZip(ENTRIES)
    expect(zip.readUInt32LE(0)).toBe(0x04034b50)
    expect(zip.readUInt16LE(8)).toBe(0)
    expect(zip.toString('ascii', 30, 38)).toBe('mimetype')
  })

  it('压缩条目确实变短', () => {
    const zip = createZip([ENTRIES[2]])
    const back = readZip(zip)
    // 局部头 30 + 名字 + 压缩体；重复内容压完应远小于原文
    expect(zip.length).toBeLessThan(ENTRIES[2].data.length)
    expect(back[0].data.length).toBe(ENTRIES[2].data.length)
  })

  it('空清单也能生成合法 zip', () => {
    const zip = createZip([])
    expect(readZip(zip)).toEqual([])
  })
})
