import { describe, expect, it } from 'vitest'
import { refRewriteEdits, refSpellings, relativeBetween } from '../src/renderer/src/asset-refs'

describe('相对路径计算', () => {
  it('同目录与子目录', () => {
    expect(relativeBetween('C:\\root', 'C:\\root\\assets\\a.png')).toBe('assets/a.png')
    expect(relativeBetween('C:\\root\\sub', 'C:\\root\\assets\\a.png')).toBe('../assets/a.png')
    expect(relativeBetween('C:\\root\\sub', 'C:\\root\\sub\\a.png')).toBe('a.png')
  })

  it('跨盘符与不同根返回 null', () => {
    expect(relativeBetween('C:\\root', 'D:\\root\\a.png')).toBeNull()
  })
})

describe('引用写法', () => {
  it('覆盖带 ./ 前缀与编码形态', () => {
    const spells = refSpellings('C:\\root', { from: 'C:\\root\\assets\\我 的.png', to: 'C:\\root\\assets\\pic.png' })
    expect(spells).toContainEqual(['assets/我 的.png', 'assets/pic.png'])
    expect(spells).toContainEqual(['./assets/我 的.png', './assets/pic.png'])
    expect(spells).toContainEqual(['assets/%E6%88%91%20%E7%9A%84.png', 'assets/pic.png'])
  })
})

describe('内存缓冲里的引用改写', () => {
  const moves = [{ from: 'C:\\root\\assets\\a.png', to: 'C:\\root\\assets\\hero.png' }]

  it('替换正文里所有写法并给出有序改动', () => {
    const text = '![一](assets/a.png)\n\n![二](./assets/a.png)\n'
    const edits = refRewriteEdits(text, 'C:\\root\\note.md', moves)
    expect(edits).toHaveLength(2)
    let next = text
    for (const edit of [...edits].reverse()) {
      next = next.slice(0, edit.from) + edit.insert + next.slice(edit.to)
    }
    expect(next).toBe('![一](assets/hero.png)\n\n![二](./assets/hero.png)\n')
  })

  it('子目录文档用 ../ 形态', () => {
    const text = '![图](../assets/a.png)'
    const edits = refRewriteEdits(text, 'C:\\root\\sub\\other.md', moves)
    expect(edits).toHaveLength(1)
    expect(text.slice(0, edits[0].from) + edits[0].insert + text.slice(edits[0].to)).toBe('![图](../assets/hero.png)')
  })

  it('没有引用时不给改动', () => {
    expect(refRewriteEdits('普通文字', 'C:\\root\\note.md', moves)).toEqual([])
  })

  it('重叠写法只改一次（./ 形态优先）', () => {
    const text = 'x ./assets/a.png y'
    const edits = refRewriteEdits(text, 'C:\\root\\note.md', moves)
    expect(edits).toHaveLength(1)
    let next = text
    for (const edit of [...edits].reverse()) next = next.slice(0, edit.from) + edit.insert + next.slice(edit.to)
    expect(next).toBe('x ./assets/hero.png y')
  })
})
