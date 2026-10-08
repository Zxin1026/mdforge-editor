import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import type { DocxExportInput, DocxExportResult, DocxLinkRef, ExportOptions } from '../../shared/ipc'
import { pickFile, safeBase, startDir } from '../export'
import { grantPath, isUnderGrantedRoot } from './file-store'
import {
  appXml,
  contentTypesXml,
  coreXml,
  documentRelsXml,
  documentXml,
  drawingXml,
  missingImageRun,
  numberingXml,
  relsRootXml,
  stylesXml,
  type DocxMediaRef
} from './docx-parts'
import { imageSizeOf } from './image-meta'
import { createZip, type ZipEntry } from './zip'

const DOCX_FILTERS: Electron.FileFilter[] = [{ name: 'Word 文档', extensions: ['docx'] }]

const MEDIA_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'])
/** 单张图片的嵌入上限：文档里放超大图没有意义，超过按缺图文字占位 */
const MAX_EMBED_BYTES = 16 * 1024 * 1024
/** 页面正文宽度的显示上限（px）：图片再大也收进版心 */
const MAX_DISPLAY_WIDTH = 640

/** 图片就位后的 OPC 包组装（纯函数，便于单测） */
export function buildDocxEntries(
  input: { bodyXml: string; title: string; options: ExportOptions; links: readonly DocxLinkRef[] },
  media: readonly { id: string; name: string; data: Buffer }[]
): ZipEntry[] {
  const mediaRels: DocxMediaRef[] = media.map((item) => ({ id: item.id, name: item.name }))
  return [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        contentTypesXml(media.map((item) => item.name.split('.').pop() ?? 'png')),
        'utf8'
      )
    },
    { name: '_rels/.rels', data: Buffer.from(relsRootXml(), 'utf8') },
    { name: 'docProps/core.xml', data: Buffer.from(coreXml(input.title), 'utf8') },
    { name: 'docProps/app.xml', data: Buffer.from(appXml(), 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml(input.bodyXml, input.options), 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(stylesXml(), 'utf8') },
    { name: 'word/numbering.xml', data: Buffer.from(numberingXml(), 'utf8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(documentRelsXml(input.links, mediaRels), 'utf8') },
    ...media.map<ZipEntry>((item) => ({ name: `word/${item.name}`, data: item.data }))
  ]
}

/**
 * 导出 Word：正文 XML 已由渲染进程生成，这里读图、替换占位、拼 OPC 包并落盘。
 * 图片读不到或超限时按缺图文字占位，不让导出失败。
 */
export async function exportDocx(input: DocxExportInput, parent: BrowserWindow | null): Promise<DocxExportResult> {
  const target = await pickFile(
    '导出 Word 文档',
    `${safeBase(input.baseName)}.docx`,
    startDir(input.docPath),
    DOCX_FILTERS,
    parent
  )

  const media: Array<{ data: Buffer; name: string; id: string }> = []
  const missing: string[] = []
  let bodyXml = input.bodyXml

  for (const [index, image] of input.images.entries()) {
    const placeholder = `<!--mdfimg:${image.id}-->`
    const display = path.basename(image.path)
    if (!bodyXml.includes(placeholder)) continue
    const absolute = path.resolve(image.path)
    let data: Buffer | null = null
    if (isUnderGrantedRoot(absolute)) {
      try {
        data = await fs.readFile(absolute)
      } catch {
        data = null
      }
    }
    if (data === null || data.length > MAX_EMBED_BYTES) {
      missing.push(display)
      bodyXml = bodyXml.split(placeholder).join(missingImageRun(display))
      continue
    }
    const rawExt = path.extname(absolute).slice(1).toLowerCase()
    const ext = MEDIA_EXT.has(rawExt) ? rawExt : 'png'
    const name = `media/image${index + 1}.${ext}`
    media.push({ data, name, id: image.id })

    const natural = imageSizeOf(data, absolute)
    const widthPx =
      image.widthPx !== null
        ? image.widthPx
        : natural === null
          ? MAX_DISPLAY_WIDTH
          : Math.min(natural.width, MAX_DISPLAY_WIDTH)
    const heightPx =
      natural === null ? Math.round(widthPx * 0.66) : Math.max(1, Math.round((natural.height * widthPx) / natural.width))
    bodyXml = bodyXml.split(placeholder).join(drawingXml(image.id, index + 1, display, { widthPx, heightPx }))
  }

  const entries = buildDocxEntries({ bodyXml, title: input.title, options: input.options, links: input.links }, media)
  grantPath(target)
  await fs.writeFile(target, createZip(entries))
  return { path: target, images: media.length, missing }
}
