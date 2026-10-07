import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { processHtmlAssets } from '../src/main/fs/export-assets'
import { grantPath, resetFileStore } from '../src/main/fs/file-store'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
)

let workDir: string
let docDir: string
let docPath: string

beforeEach(() => {
  resetFileStore()
  workDir = mkdtempSync(path.join(tmpdir(), 'mdforge-export-'))
  docDir = path.join(workDir, 'docs')
  docPath = path.join(docDir, 'README.md')
  mkdirSync(path.join(docDir, 'assets'), { recursive: true })
  mkdirSync(path.join(docDir, 'sub'), { recursive: true })
  writeFileSync(docPath, '# 说明\n', 'utf-8')
  writeFileSync(path.join(docDir, 'assets', 'a.png'), PNG)
  writeFileSync(path.join(docDir, 'assets', 'my pic.png'), PNG)
  writeFileSync(path.join(docDir, 'sub', 'a.png'), Buffer.from('different-bytes'))
  // 用户只打开过这份文档，能读的就在它同级目录里
  grantPath(docPath)
})

const html = (src: string): string => `<p><img src="${src}" alt="图"></p>`

describe('导出图片复制', () => {
  it('复制到导出文件旁边并改写相对地址', async () => {
    const outDir = path.join(workDir, 'out')
    mkdirSync(outDir, { recursive: true })
    const result = await processHtmlAssets(html('assets/a.png'), {
      docDir,
      mode: 'copy',
      targetDir: outDir,
      assetDirName: 'README.assets'
    })
    expect(result.html).toBe('<p><img src="README.assets/a.png" alt="图"></p>')
    expect(readFileSync(path.join(outDir, 'README.assets', 'a.png'))).toEqual(PNG)
    expect(result.report.copied).toBe(1)
    expect(result.report.missing).toEqual([])
  })

  it('导到文档自己的目录也不会碰原图', async () => {
    const result = await processHtmlAssets(html('assets/a.png'), {
      docDir,
      mode: 'copy',
      targetDir: docDir,
      assetDirName: 'README.assets'
    })
    expect(result.html).toContain('src="README.assets/a.png"')
    expect(readFileSync(path.join(docDir, 'assets', 'a.png'))).toEqual(PNG)
  })

  it('同名不同图各存一份', async () => {
    const outDir = path.join(workDir, 'out')
    const source = '<p><img src="assets/a.png"><img src="sub/a.png"></p>'
    const result = await processHtmlAssets(source, {
      docDir,
      mode: 'copy',
      targetDir: outDir,
      assetDirName: 'x.assets'
    })
    expect(result.html).toContain('src="x.assets/a.png"')
    expect(result.html).toContain('src="x.assets/a-1.png"')
    expect(result.report.copied).toBe(2)
  })

  it('同一张图引用两次只复制一次', async () => {
    const outDir = path.join(workDir, 'out')
    const source = '<p><img src="assets/a.png"><img src="assets/a.png"></p>'
    const result = await processHtmlAssets(source, {
      docDir,
      mode: 'copy',
      targetDir: outDir,
      assetDirName: 'x.assets'
    })
    expect(result.report.copied).toBe(1)
    expect(result.html.match(/x\.assets\/a\.png/g)?.length).toBe(2)
  })

  it('带空格与百分号编码的地址都能落地', async () => {
    const outDir = path.join(workDir, 'out')
    const result = await processHtmlAssets(html('assets/my%20pic.png'), {
      docDir,
      mode: 'copy',
      targetDir: outDir,
      assetDirName: 'x.assets'
    })
    expect(result.report.copied).toBe(1)
    expect(existsSync(path.join(outDir, 'x.assets', 'my pic.png'))).toBe(true)
  })
})

describe('导出图片内联', () => {
  it('转成 base64 数据地址', async () => {
    const result = await processHtmlAssets(html('assets/a.png'), { docDir, mode: 'inline' })
    expect(result.html).toContain('src="data:image/png;base64,')
    expect(result.report.inlined).toBe(1)
    expect(result.report.copied).toBe(0)
  })

  it('保持原路径时一个字都不改', async () => {
    const source = html('assets/a.png')
    const result = await processHtmlAssets(source, { docDir, mode: 'keep' })
    expect(result.html).toBe(source)
    expect(result.report.copied).toBe(0)
    expect(result.report.inlined).toBe(0)
  })
})

describe('处理不了的引用', () => {
  it('文件不存在只报告，不改写', async () => {
    const source = html('assets/nope.png')
    const result = await processHtmlAssets(source, { docDir, mode: 'copy', targetDir: docDir })
    expect(result.html).toBe(source)
    expect(result.report.missing).toEqual(['assets/nope.png'])
  })

  it('远程与 data 地址原样保留', async () => {
    const source = '<img src="https://example.com/a.png"><img src="data:image/png;base64,AAA">'
    const result = await processHtmlAssets(source, { docDir, mode: 'inline' })
    expect(result.html).toBe(source)
    expect(result.report.skipped).toHaveLength(2)
  })

  it('跳出文档目录的引用不碰', async () => {
    writeFileSync(path.join(workDir, 'outside.png'), PNG)
    const source = html('../outside.png')
    const result = await processHtmlAssets(source, { docDir, mode: 'copy', targetDir: docDir })
    expect(result.html).toBe(source)
    expect(result.report.skipped).toEqual(['../outside.png'])
  })

  it('文档没保存过时无从复制，只标注跳过', async () => {
    const source = html('assets/a.png')
    const result = await processHtmlAssets(source, { docDir: null, mode: 'copy' })
    expect(result.html).toBe(source)
    expect(result.report.skipped).toEqual(['assets/a.png'])
  })

  it('正文没有图片时不建空目录', async () => {
    const result = await processHtmlAssets('<p>只有文字</p>', {
      docDir,
      mode: 'copy',
      targetDir: docDir,
      assetDirName: 'noimg.assets'
    })
    expect(result.report.copied).toBe(0)
    expect(existsSync(path.join(docDir, 'noimg.assets'))).toBe(false)
  })
})
