import { describe, expect, it } from 'vitest'
import {
  formatBytes,
  mimeOfExt,
  relativePosix,
  renamePlan,
  targetNameFor
} from '../src/renderer/src/side/asset-ops'

describe('体积与扩展名', () => {
  it('formatBytes 三档', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })

  it('扩展名到 MIME', () => {
    expect(mimeOfExt('.png')).toBe('image/png')
    expect(mimeOfExt('.jpeg')).toBe('image/jpeg')
    expect(mimeOfExt('.webp')).toBe('image/webp')
    expect(mimeOfExt('.xyz')).toBe('application/octet-stream')
  })
})

describe('批量重命名计划', () => {
  it('前缀 + 补零序号，保留各自扩展名', () => {
    expect(renamePlan(['a.png', 'b.jpg'], 'image', 1)).toEqual(['image-1.png', 'image-2.jpg'])
    expect(renamePlan(Array.from({ length: 12 }, () => 'x.png'), 'pic', 1)[9]).toBe('pic-10.png')
    expect(renamePlan(['x.png'], 'p', 7)).toEqual(['p-7.png'])
  })

  it('序号位宽跟着总数走（整批统一补零）', () => {
    const names = renamePlan(Array.from({ length: 3 }, () => 'x.png'), 'p', 98)
    expect(names).toEqual(['p-098.png', 'p-099.png', 'p-100.png'])
  })
})

describe('压缩目标命名', () => {
  it('同扩展名返回 undefined（原地覆盖）', () => {
    expect(targetNameFor('a.png', 'image/png')).toBeUndefined()
    expect(targetNameFor('a.jpg', 'image/jpeg')).toBeUndefined()
    expect(targetNameFor('a.jpeg', 'image/jpeg')).toBeUndefined()
  })

  it('换格式只换扩展名', () => {
    expect(targetNameFor('a.png', 'image/webp')).toBe('a.webp')
    expect(targetNameFor('截图 1.png', 'image/jpeg')).toBe('截图 1.jpg')
    expect(targetNameFor('a.webp', 'image/png')).toBe('a.png')
  })
})

describe('相对路径判断', () => {
  it('子树内返回相对路径，之外返回 null', () => {
    expect(relativePosix('C:\\root', 'C:\\root\\assets\\a.png')).toBe('assets/a.png')
    expect(relativePosix('C:\\root\\', 'C:\\root\\a.md')).toBe('a.md')
    expect(relativePosix('C:\\root', 'C:\\other\\a.md')).toBeNull()
    expect(relativePosix('C:\\root', 'C:\\root')).toBe('')
  })
})
