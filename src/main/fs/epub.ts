import { BrowserWindow, dialog } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { EpubExportInput, EpubExportResult } from '../../shared/ipc'
import { buildEpubEntries, toXhtml } from './epub-build'
import { FileOpError } from './error'
import { processHtmlAssets } from './export-assets'
import { grantPath, mapFsError } from './file-store'
import { createZip } from './zip'

function safeBase(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || '未命名'
}

async function pickTarget(title: string, startDir: string, parent: BrowserWindow | null): Promise<string> {
  const options = {
    title: '导出 EPUB',
    defaultPath: path.join(startDir, `${safeBase(title)}.epub`),
    filters: [{ name: 'EPUB', extensions: ['epub'] }]
  }
  const choice = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
  if (choice.canceled || !choice.filePath) throw new FileOpError('invalid-path', '已取消导出')
  return choice.filePath
}

/** 每章图片一律内联成 base64：电子书是单文件，外链图片在阅读器里取不到 */
export async function exportEpub(input: EpubExportInput, parent: BrowserWindow | null): Promise<EpubExportResult> {
  if (!Array.isArray(input.chapters) || input.chapters.length === 0) {
    throw new FileOpError('invalid-path', '没有可导出的章节')
  }

  const title = input.title.trim() === '' ? '未命名' : input.title
  const firstDoc = input.chapters.find((chapter) => chapter.docPath !== null)?.docPath ?? null
  const target = await pickTarget(title, firstDoc ? path.dirname(path.resolve(firstDoc)) : process.cwd(), parent)

  const chapters: Array<{ title: string; body: string }> = []
  let images = 0
  for (const chapter of input.chapters) {
    const prepared = await processHtmlAssets(chapter.html, {
      docDir: chapter.docPath ? path.dirname(path.resolve(chapter.docPath)) : null,
      mode: 'inline'
    })
    images += prepared.report.inlined
    chapters.push({ title: chapter.title, body: toXhtml(prepared.html) })
  }

  const zip = createZip(
    buildEpubEntries({
      title,
      author: input.author,
      css: input.css ?? '',
      chapters
    })
  )

  try {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, zip)
  } catch (error) {
    throw mapFsError(error, target)
  }
  grantPath(target)
  return { path: target, chapters: chapters.length, images }
}
