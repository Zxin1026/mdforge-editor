import {
  DOCX_NUM_BULLET,
  DOCX_NUM_ORDERED,
  MARGIN_MM,
  type DocxLinkRef,
  type ExportOptions,
  type PaperSize
} from '../../shared/ipc'

/** 纸张尺寸（twips，1/20 磅）：与打印链的纸张表同一组规格 */
const PAPER_TWIPS: Record<PaperSize, { width: number; height: number }> = {
  A4: { width: 11906, height: 16838 },
  Letter: { width: 12240, height: 15840 },
  Legal: { width: 12240, height: 20160 },
  A5: { width: 8391, height: 11906 }
}

/** px → EMU（Word 的绘图单位，96dpi 下 1px = 9525） */
export const EMU_PER_PX = 9525

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function contentTypesXml(mediaExtensions: readonly string[]): string {
  const mediaTypes: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    avif: 'image/avif'
  }
  const defaults = [...new Set(mediaExtensions)]
    .filter((ext) => mediaTypes[ext] !== undefined)
    .map((ext) => `<Default Extension="${ext}" ContentType="${mediaTypes[ext]}"/>`)
    .join('')
  return `${XML_DECL}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${defaults}
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>
`
}

export function relsRootXml(): string {
  return `${XML_DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rIdCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rIdApp" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>
`
}

/** document.xml：套上根元素，正文后补 A4 等纸张与页边距对应的 sectPr */
export function documentXml(bodyXml: string, options: ExportOptions): string {
  const paper = PAPER_TWIPS[options.paper]
  const margin = Math.round(MARGIN_MM[options.margin] * 56.6929)
  return `${XML_DECL}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>
${bodyXml}<w:sectPr><w:pgSz w:w="${paper.width}" w:h="${paper.height}"/><w:pgMar w:top="${margin}" w:right="${margin}" w:bottom="${margin}" w:left="${margin}" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
</w:body>
</w:document>
`
}

const HEADING_SIZE = [32, 28, 24, 22, 21, 21]

export function stylesXml(): string {
  const headings = HEADING_SIZE.map(
    (size, index) => `<w:style w:type="paragraph" w:styleId="Heading${index + 1}">
<w:name w:val="heading ${index + 1}"/>
<w:basedOn w:val="Normal"/>
<w:pPr><w:keepNext/><w:spacing w:before="280" w:after="120"/><w:outlineLvl w:val="${index}"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>
</w:style>`
  ).join('\n')
  return `${XML_DECL}
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults>
<w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="微软雅黑"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
${headings}
<w:style w:type="paragraph" w:styleId="Quote">
<w:name w:val="Quote"/>
<w:basedOn w:val="Normal"/>
<w:pPr><w:ind w:left="420"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="CCCCCC"/></w:pBdr></w:pPr>
<w:rPr><w:i/><w:color w:val="595959"/></w:rPr>
</w:style>
<w:style w:type="paragraph" w:styleId="CodeBlock">
<w:name w:val="Code Block"/>
<w:basedOn w:val="Normal"/>
<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F4F5F7"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="120"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr>
</w:style>
</w:styles>
`
}

function numberingLevels(format: 'bullet' | 'decimal'): string {
  const texts = format === 'bullet' ? ['•', 'o', '▪', '•', 'o'] : ['%1.', '%2.', '%3.', '%4.', '%5.']
  return texts
    .map(
      (text, index) => `<w:lvl w:ilvl="${index}">
<w:start w:val="1"/>
<w:numFmt w:val="${format}"/>
<w:lvlText w:val="${text}"/>
<w:lvlJc w:val="left"/>
<w:pPr><w:ind w:left="${720 + 360 * index}" w:hanging="360"/></w:pPr>
</w:lvl>`
    )
    .join('\n')
}

/** 编号表：numId 1 为无序、2 为有序（与渲染进程写进 numPr 的常量一致），各带 5 级 */
export function numberingXml(): string {
  return `${XML_DECL}
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="multilevel"/>
${numberingLevels('bullet')}
</w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="multilevel"/>
${numberingLevels('decimal')}
</w:abstractNum>
<w:num w:numId="${DOCX_NUM_BULLET}"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="${DOCX_NUM_ORDERED}"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>
`
}

export function coreXml(title: string): string {
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  return `${XML_DECL}
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${escapeAttr(title)}</dc:title>
<dc:creator>MDForge</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>
</cp:coreProperties>
`
}

export function appXml(): string {
  return `${XML_DECL}
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>MDForge</Application>
</Properties>
`
}

export interface DocxMediaRef {
  id: string
  /** 包内路径，如 media/image1.png */
  name: string
}

export function documentRelsXml(links: readonly DocxLinkRef[], media: readonly DocxMediaRef[]): string {
  const linkRels = links
    .map(
      (link) =>
        `<Relationship Id="${escapeAttr(link.id)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeAttr(
          link.target
        )}" TargetMode="External"/>`
    )
    .join('')
  const mediaRels = media
    .map(
      (item) =>
        `<Relationship Id="${escapeAttr(item.id)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${escapeAttr(
          item.name
        )}"/>`
    )
    .join('')
  return `${XML_DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
${linkRels}${mediaRels}
</Relationships>
`
}

export interface DrawingSize {
  widthPx: number
  heightPx: number
}

/** 内嵌图片：正文占位注释被它替换；尺寸换算成 EMU */
export function drawingXml(relId: string, index: number, name: string, size: DrawingSize): string {
  const cx = Math.max(1, Math.round(size.widthPx * EMU_PER_PX))
  const cy = Math.max(1, Math.round(size.heightPx * EMU_PER_PX))
  const safeName = escapeAttr(name)
  return `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${index}" name="image${index}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${index}" name="${safeName}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${escapeAttr(
    relId
  )}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`
}

/** 图片读不到时的文字占位（体例与导出 HTML 的提示一致） */
export function missingImageRun(name: string): string {
  return `<w:r><w:rPr><w:i/><w:color w:val="888888"/></w:rPr><w:t xml:space="preserve">[图片缺失：${escapeAttr(name)}]</w:t></w:r>`
}
