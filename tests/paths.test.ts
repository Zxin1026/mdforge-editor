import { describe, expect, it } from 'vitest'
import { dirOfPath, relativeBetween, relativePosix, resolvePath } from '../src/renderer/src/paths'

describe('目录与解析', () => {
  it('dirOfPath 处理盘符、斜杠与无分隔符', () => {
    expect(dirOfPath('C:\\root\\sub\\a.md')).toBe('C:\\root\\sub')
    expect(dirOfPath('C:/root/a.md')).toBe('C:/root')
    expect(dirOfPath('a.md')).toBe('')
  })

  it('resolvePath 折叠 . 与 ..，支持根路径与反斜杠', () => {
    expect(resolvePath('C:/root/sub', '../assets/a.png')).toBe('C:/root/assets/a.png')
    expect(resolvePath('C:/root', './x/./y.md')).toBe('C:/root/x/y.md')
    expect(resolvePath('C:/root', 'C:/other/a.md')).toBe('C:/other/a.md')
    expect(resolvePath('C:/root', '/assets/a.png')).toBe('C:/assets/a.png')
    expect(resolvePath('C:\\root\\sub', 'a b.png')).toBe('C:/root/sub/a b.png')
    expect(resolvePath('/home/user', '../etc/x')).toBe('/home/etc/x')
  })
})

describe('相对路径', () => {
  it('relativeBetween 在子树与跨目录两种情形都正确', () => {
    expect(relativeBetween('C:/root', 'C:/root/a.html')).toBe('a.html')
    expect(relativeBetween('C:/root/sub', 'C:/root/a.html')).toBe('../a.html')
    expect(relativeBetween('C:/root/sub/deep', 'C:/root/other/a.html')).toBe('../../other/a.html')
    expect(relativeBetween('', 'sub/a.html')).toBe('sub/a.html')
    expect(relativeBetween('C:/root', 'D:/x.html')).toBeNull()
  })

  it('relativePosix 只在子树内给结果', () => {
    expect(relativePosix('C:\\root', 'C:\\root\\sub\\a.md')).toBe('sub/a.md')
    expect(relativePosix('C:/root', 'C:/root')).toBe('')
    expect(relativePosix('C:/root', 'C:/other/a.md')).toBeNull()
  })
})
