import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { frontMatterOf } from '../src/renderer/src/editor/frontmatter'

function doc(text: string): EditorState['doc'] {
  return EditorState.create({ doc: text }).doc
}

describe('front matter 识别', () => {
  it('文档开头的 --- 到 --- 才算块', () => {
    const text = '---\ntitle: 手册\nslug: a\n---\n\n# 标题\n'
    const span = frontMatterOf(doc(text))
    expect(span?.from).toBe(0)
    expect(text.slice(span?.from ?? 0, span?.to ?? 0)).toBe('---\ntitle: 手册\nslug: a\n---')
    expect(span?.lines).toHaveLength(4)
  })

  it('三点式收尾同样有效', () => {
    const span = frontMatterOf(doc('---\na: 1\n...\n正文\n'))
    expect(span?.lines).toHaveLength(3)
  })

  it('没有配对收尾时完全不介入', () => {
    expect(frontMatterOf(doc('---\n正文开始\n'))).toBeNull()
    expect(frontMatterOf(doc('---\n\n正文\n'))).toBeNull()
  })

  it('不在第一行就不是 front matter', () => {
    expect(frontMatterOf(doc('说明\n---\na: 1\n---\n'))).toBeNull()
  })

  it('开标记必须独占一行', () => {
    expect(frontMatterOf(doc('---x\na: 1\n---\n'))).toBeNull()
    expect(frontMatterOf(doc('  ---\na: 1\n---\n'))).toBeNull()
  })

  it('单独的分割线不算', () => {
    expect(frontMatterOf(doc('---\n'))).toBeNull()
    expect(frontMatterOf(doc('# 标题\n\n---\n\n---\n'))).toBeNull()
  })

  it('超长未配对内容不扫下去', () => {
    const text = '---\n' + '正文行\n'.repeat(400)
    expect(frontMatterOf(doc(text))).toBeNull()
  })
})
