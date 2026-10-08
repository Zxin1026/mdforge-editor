import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { headingSlugsOf, probeResources } from '../src/main/fs/resource-check'
import { grantFolder, grantPath, resetFileStore } from '../src/main/fs/file-store'

let workDir: string
let docDir: string
let docPath: string

beforeEach(() => {
  resetFileStore()
  workDir = mkdtempSync(path.join(tmpdir(), 'mdforge-probe-'))
  docDir = path.join(workDir, 'docs')
  docPath = path.join(docDir, 'README.md')
  mkdirSync(path.join(docDir, 'assets', 'nested'), { recursive: true })
  writeFileSync(docPath, '# 说明\n', 'utf-8')
  writeFileSync(path.join(docDir, 'assets', 'a.png'), 'png')
  writeFileSync(path.join(docDir, 'assets', 'nested', 'b.png'), 'png2')
  writeFileSync(path.join(docDir, 'assets', '.hidden.png'), 'x')
  grantPath(docPath)
})

describe('引用存在性', () => {
  it('文件、目录、缺失分别给出状态', async () => {
    const result = await probeResources({
      docPath,
      refs: [path.join(docDir, 'assets', 'a.png'), docDir, path.join(docDir, 'assets', 'gone.png')]
    })
    expect(result.states).toEqual(['ok', 'directory', 'missing'])
  })

  it('授权范围之外按未知返回，不确认也不否定', async () => {
    writeFileSync(path.join(workDir, 'secret.md'), 'x')
    const result = await probeResources({ docPath, refs: [path.join(workDir, 'secret.md')] })
    expect(result.states).toEqual(['unknown'])
  })

  it('打开过所在文件夹后就能确认其下的文件', async () => {
    writeFileSync(path.join(workDir, 'secret.md'), 'x')
    grantFolder(workDir)
    const result = await probeResources({ docPath, refs: [path.join(workDir, 'secret.md')] })
    expect(result.states).toEqual(['ok'])
  })

  it('非绝对路径直接算非法引用', async () => {
    const result = await probeResources({ docPath, refs: ['assets/a.png', ''] })
    expect(result.states).toEqual(['outside', 'outside'])
  })

  it('没有引用时只返回清单', async () => {
    const result = await probeResources({ docPath, refs: [] })
    expect(result.states).toEqual([])
    expect(result.assets.length).toBeGreaterThan(0)
  })

  it('文档路径不合法要报错', async () => {
    await expect(probeResources({ docPath: 'docs/README.md', refs: [] })).rejects.toMatchObject({
      code: 'invalid-path'
    })
  })

  it('未保存的文档没有授权目录，清单为空', async () => {
    const result = await probeResources({ docPath: path.join(workDir, 'elsewhere', 'x.md'), refs: [] })
    expect(result.assets).toEqual([])
  })
})

describe('资源清单', () => {
  it('文档同级散落的图片与 assets/ 下的文件都列出来，相对路径用斜杠', async () => {
    // 同级只认图片扩展名：相邻文档、旁挂的 pdf 这类不算"资源"，免得误报未引用
    writeFileSync(path.join(docDir, 'sibling.png'), 'png')
    writeFileSync(path.join(docDir, 'guide.pdf'), 'pdf')
    writeFileSync(path.join(docDir, 'note.md'), '# 相邻文档')
    const result = await probeResources({ docPath, refs: [] })
    expect(result.assets.map((asset) => asset.relative).sort()).toEqual([
      'assets/a.png',
      'assets/nested/b.png',
      'sibling.png'
    ])
    expect(result.assets[0].absolute).toContain('docs')
    expect(result.assets[0].size).toBeGreaterThan(0)
  })
})

describe('跨文档标题锚点', () => {
  it('ATX 与 setext 标题都收，slug 与编辑器口径一致', () => {
    const slugs = headingSlugsOf('# 一级\n\n## **粗** 标题\n\n正文\n===\n\n```\n# 代码里的\n```\n')
    expect(slugs.has('一级')).toBe(true)
    expect(slugs.has('粗-标题')).toBe(true)
    expect(slugs.has('正文')).toBe(true)
    expect(slugs.has('代码里的')).toBe(false)
  })

  it('front matter 与重复标题按大纲规则处理', () => {
    const slugs = headingSlugsOf('---\ntitle: TODO\n---\n\n# 用法\n\n## 用法\n')
    expect(slugs.has('用法')).toBe(true)
    expect(slugs.has('用法-1')).toBe(true)
    expect(slugs.has('todo')).toBe(false)
  })

  it('锚点存在返回 ok，缺失返回 missing，读不出来返回 unknown', async () => {
    writeFileSync(path.join(docDir, 'other.md'), '# 用法\n', 'utf-8')
    const result = await probeResources({
      docPath,
      refs: [],
      anchors: [
        { path: path.join(docDir, 'other.md'), anchor: '用法' },
        { path: path.join(docDir, 'other.md'), anchor: '不存在' },
        { path: path.join(docDir, 'gone.md'), anchor: '用法' },
        { path: path.join(workDir, 'outside.md'), anchor: '用法' }
      ]
    })
    expect(result.anchorStates).toEqual(['ok', 'missing', 'unknown', 'unknown'])
  })

  it('没有传锚点时返回空清单', async () => {
    const result = await probeResources({ docPath, refs: [] })
    expect(result.anchorStates).toEqual([])
  })
})
