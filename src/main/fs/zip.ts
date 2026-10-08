import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'

export interface ZipEntry {
  /** 打包内路径（posix），如 OEBPS/chapter-1.xhtml */
  name: string
  data: Buffer
  /** true 表示不压缩存储（EPUB 的 mimetype 必须这样放第一个） */
  store?: boolean
}

interface DosTime {
  time: number
  date: number
}

function dosTimeOf(when: Date): DosTime {
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2)
  const date = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()
  return { time, date }
}

/**
 * 最小可用的 ZIP 打包（deflate + 存储两种方法）。
 * EPUB 就是一个固定结构的 zip：mimetype 头第一条且不压缩，其余条目无要求。
 */
export function createZip(entries: readonly ZipEntry[]): Buffer {
  const when = dosTimeOf(new Date())
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const method = entry.store === true ? 0 : 8
    const raw = entry.data
    const body = method === 0 ? raw : deflateRawSync(raw)
    const crc = crc32(raw) >>> 0
    // bit 11：名字是 UTF-8（中文文件名依赖它）
    const flags = 0x0800

    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(when.time, 10)
    local.writeUInt16LE(when.date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)

    locals.push(local, body)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(when.time, 12)
    central.writeUInt16LE(when.date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centrals.push(central)

    offset += local.length + body.length
  }

  const centralDir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDir.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, centralDir, end])
}

/** 读出中央目录里的条目名与内容：测试与自检用 */
export function readZip(buffer: Buffer): Array<{ name: string; data: Buffer }> {
  const endIndex = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (endIndex < 0) throw new Error('不是 zip 文件')
  const count = buffer.readUInt16LE(endIndex + 10)
  let offset = buffer.readUInt32LE(endIndex + 16)
  const out: Array<{ name: string; data: Buffer }> = []

  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('中央目录损坏')
    const method = buffer.readUInt16LE(offset + 10)
    const compressed = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)

    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const dataStart = localOffset + 30 + localNameLength + buffer.readUInt16LE(localOffset + 28)
    const payload = buffer.subarray(dataStart, dataStart + compressed)
    out.push({ name, data: method === 0 ? Buffer.from(payload) : Buffer.from(inflateRawSync(payload)) })

    offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32)
  }
  return out
}
