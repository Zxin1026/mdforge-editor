import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { inspectDocument, type AssetEntry, type InspectSource } from '../src/renderer/src/editor/inspect'
import { markdownLanguageExtension } from '../src/renderer/src/editor/markdown'

const DOC_PATH = 'E:/docs/README.md'

function stateWith(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdownLanguageExtension] })
}

/** 只有 a.png 与 used.png 存在，其余按缺失处理 */
function sourceWith(assets: AssetEntry[] = []): InspectSource {
  return {
    probe: async (refs) => ({
      states: refs.map((ref) => (/a\.png|used\.png|note\.md/.test(ref) ? 'ok' : 'missing')),
      assets
    })
  }
}

describe('缺图与坏链', () => {
  it('图片文件不存在要报缺图', async () => {
    const report = await inspectDocument(stateWith('![图](assets/gone.png)\n'), DOC_PATH, sourceWith())
    expect(report.issues.map((issue) => issue.kind)).toEqual(['missing-image'])
    expect(report.issues[0].label).toContain('assets/gone.png')
    expect(report.issues[0].detail).toBe('文件不存在')
    expect(report.issues[0].line).toBe(1)
  })

  it('相对文档链接不存在要报坏链', async () => {
    const report = await inspectDocument(stateWith('[去](other.md)\n'), DOC_PATH, sourceWith())
    expect(report.issues).toHaveLength(1)
    expect(report.issues[0].kind).toBe('broken-link')
  })

  it('存在就不报，外部链接只计数', async () => {
    const report = await inspectDocument(
      stateWith('![图](assets/a.png)\n\n[去](note.md)\n\n[网](https://example.com)\n'),
      DOC_PATH,
      sourceWith()
    )
    expect(report.issues).toEqual([])
    expect(report.checked).toBe(2)
    expect(report.external).toBe(1)
  })

  it('指向目录的引用说清楚', async () => {
    const source: InspectSource = { probe: async () => ({ states: ['directory'], assets: [] }) }
    const report = await inspectDocument(stateWith('![图](assets/a.png)\n'), DOC_PATH, source)
    expect(report.issues[0].detail).toBe('指向的是目录，不是文件')
  })

  it('未保存的文档给出可执行的提示', async () => {
    const report = await inspectDocument(stateWith('![图](assets/a.png)\n'), '', sourceWith())
    expect(report.issues[0].detail).toContain('还没保存')
  })
})

describe('锚点与标题层级', () => {
  it('指不到标题的锚点算坏链', async () => {
    const report = await inspectDocument(stateWith('# 用法\n\n[对](#用法)\n\n[跳](#不存在)\n'), DOC_PATH, sourceWith())
    expect(report.issues).toHaveLength(1)
    expect(report.issues[0].detail).toContain('#不存在')
    expect(report.issues[0].line).toBe(5)
  })

  it('标题跳级报一行，逐级往下不报', async () => {
    const report = await inspectDocument(stateWith('# 甲\n\n## 乙\n\n### 丙\n'), DOC_PATH, sourceWith())
    expect(report.issues).toEqual([])
    const jumped = await inspectDocument(stateWith('# 甲\n\n## 乙\n\n##### 戊\n'), DOC_PATH, sourceWith())
    expect(jumped.issues.map((issue) => issue.kind)).toEqual(['heading-jump'])
    expect(jumped.issues[0].line).toBe(5)
    expect(jumped.issues[0].detail).toContain('H2')
  })
})

describe('未引用资源', () => {
  const assets: AssetEntry[] = [
    { relative: 'assets/used.png', absolute: 'E:/docs/assets/used.png', size: 2048 },
    { relative: 'assets/orphan.png', absolute: 'E:/docs/assets/orphan.png', size: 1024 }
  ]

  it('正文里没用到的图片列出来', async () => {
    const report = await inspectDocument(stateWith('![图](assets/used.png)\n'), DOC_PATH, sourceWith(assets))
    const unused = report.issues.filter((issue) => issue.kind === 'unused-asset')
    expect(unused).toHaveLength(1)
    expect(unused[0].label).toBe('assets/orphan.png')
    expect(unused[0].path).toBe('E:/docs/assets/orphan.png')
    expect(unused[0].detail).toContain('1 KB')
    expect(report.note).toContain('扫描了 2 个')
  })

  it('链接引用过的资源不算未引用', async () => {
    const report = await inspectDocument(stateWith('[原图](assets/orphan.png)\n'), DOC_PATH, sourceWith(assets))
    const unused = report.issues.filter((issue) => issue.kind === 'unused-asset')
    expect(unused.map((issue) => issue.label)).toEqual(['assets/used.png'])
  })
})

describe('新增规则', () => {
  it('重复标题点名第二处并给出锚点形式', async () => {
    const report = await inspectDocument(stateWith('# 用法\n\n## 用法\n\n### 用法\n'), DOC_PATH, sourceWith())
    const dup = report.issues.filter((issue) => issue.kind === 'duplicate-heading')
    expect(dup).toHaveLength(2)
    expect(dup[0].line).toBe(3)
    expect(dup[0].detail).toContain('#用法-1')
    expect(dup[1].line).toBe(5)
  })

  it('空图片描述报出来，有描述不报', async () => {
    const report = await inspectDocument(
      stateWith('![](assets/a.png)\n\n![有描述](assets/a.png)\n'),
      DOC_PATH,
      sourceWith()
    )
    const empty = report.issues.filter((issue) => issue.kind === 'empty-image-alt')
    expect(empty).toHaveLength(1)
    expect(empty[0].line).toBe(1)
    expect(empty[0].end).toBeGreaterThan(empty[0].pos)
  })

  it('未闭合代码块在开头处报错', async () => {
    const report = await inspectDocument(stateWith('正文\n\n```js\nconst a = 1\n'), DOC_PATH, sourceWith())
    const fences = report.issues.filter((issue) => issue.kind === 'unclosed-fence')
    expect(fences).toHaveLength(1)
    expect(fences[0].line).toBe(3)
    expect(fences[0].detail).toContain('```')
    const closed = await inspectDocument(stateWith('```js\nconst a = 1\n```\n'), DOC_PATH, sourceWith())
    expect(closed.issues.filter((issue) => issue.kind === 'unclosed-fence')).toHaveLength(0)
  })

  it('front matter 没闭合与非法行都报出来', async () => {
    const unclosed = await inspectDocument(stateWith('---\ntitle: 标题\n\n正文\n'), DOC_PATH, sourceWith())
    expect(unclosed.issues.filter((issue) => issue.kind === 'invalid-frontmatter')).toHaveLength(1)
    expect(unclosed.issues[0].label).toContain('结束标记')

    const bad = await inspectDocument(
      stateWith('---\ntitle: 标题\n就是一行裸文本\n---\n\n正文\n'),
      DOC_PATH,
      sourceWith()
    )
    const issues = bad.issues.filter((issue) => issue.kind === 'invalid-frontmatter')
    expect(issues).toHaveLength(1)
    expect(issues[0].line).toBe(3)
    expect(issues[0].detail).toContain('键: 值')

    const dup = await inspectDocument(stateWith('---\ntitle: A\ntitle: B\n---\n'), DOC_PATH, sourceWith())
    expect(dup.issues.filter((issue) => issue.kind === 'invalid-frontmatter')[0].detail).toContain('重复')
  })

  it('超过 200 字符的行点名，代码块里跳过', async () => {
    const long = 'x'.repeat(220)
    const report = await inspectDocument(
      stateWith(`短行\n\n${long}\n\n\`\`\`\n${long}\n\`\`\`\n`),
      DOC_PATH,
      sourceWith()
    )
    const lines = report.issues.filter((issue) => issue.kind === 'long-line')
    expect(lines).toHaveLength(1)
    expect(lines[0].line).toBe(3)
    expect(lines[0].detail).toContain('220')
  })
})

it('问题按类别再按行号排序', async () => {
  const doc = '# 一级\n\n### 三级\n\n![缺](assets/nope.png)\n\n[坏](gone.md)\n'
  const report = await inspectDocument(stateWith(doc), DOC_PATH, sourceWith())
  expect(report.issues.map((issue) => issue.kind)).toEqual(['missing-image', 'broken-link', 'heading-jump'])
  expect(report.issues[2].line).toBe(3)
})
