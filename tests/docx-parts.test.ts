import { describe, expect, it } from 'vitest'
import { buildDocxEntries } from '../src/main/fs/docx'
import { documentXml, drawingXml, EMU_PER_PX, numberingXml } from '../src/main/fs/docx-parts'
import { createZip, readZip } from '../src/main/fs/zip'
import { DEFAULT_EXPORT_OPTIONS, DOCX_NUM_BULLET, DOCX_NUM_ORDERED } from '../src/shared/ipc'

describe('DOCX 包组装', () => {
  it('zip 里包含全部固定部件，drawing 与关系表对得上', () => {
    const bodyXml = '<w:p><w:r><!--mdfimg:I1--></w:r></w:p>'
    const patched = bodyXml
      .split('<!--mdfimg:I1-->')
      .join(drawingXml('I1', 1, 'pic.png', { widthPx: 320, heightPx: 160 }))
    const entries = buildDocxEntries(
      {
        bodyXml: patched,
        title: '标题',
        options: DEFAULT_EXPORT_OPTIONS,
        links: [{ id: 'L1', target: 'https://example.com' }]
      },
      [{ id: 'I1', name: 'media/image1.png', data: Buffer.from([1, 2, 3]) }]
    )
    const files = readZip(createZip(entries))
    const names = files.map((file) => file.name)
    expect(names).toContain('word/document.xml')
    expect(names).toContain('word/styles.xml')
    expect(names).toContain('word/numbering.xml')
    expect(names).toContain('word/_rels/document.xml.rels')
    expect(names).toContain('word/media/image1.png')

    const doc = files.find((file) => file.name === 'word/document.xml')!.data.toString('utf8')
    expect(doc).toContain('r:embed="I1"')
    expect(doc).toContain(`<wp:extent cx="${320 * EMU_PER_PX}" cy="${160 * EMU_PER_PX}"/>`)

    const rels = files.find((file) => file.name === 'word/_rels/document.xml.rels')!.data.toString('utf8')
    expect(rels).toContain('Target="https://example.com" TargetMode="External"')
    expect(rels).toContain('Target="media/image1.png"')

    const types = files.find((file) => file.name === '[Content_Types].xml')!.data.toString('utf8')
    expect(types).toContain('Extension="png"')
  })

  it('纸张与页边距写进 sectPr，编号表带两种格式', () => {
    const doc = documentXml('', { ...DEFAULT_EXPORT_OPTIONS, paper: 'A5', margin: 'wide' })
    expect(doc).toContain('<w:pgSz w:w="8391" w:h="11906"/>')
    expect(doc).toContain('w:top="1701"')
    const numbering = numberingXml()
    expect(numbering).toContain(`w:numId="${DOCX_NUM_BULLET}"`)
    expect(numbering).toContain(`w:numId="${DOCX_NUM_ORDERED}"`)
    expect(numbering).toContain('numFmt w:val="decimal"')
  })
})
