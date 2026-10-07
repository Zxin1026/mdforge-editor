import { BrowserWindow, dialog } from 'electron'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  MARGIN_MM,
  type ExportInput,
  type ExportOutcome,
  type PageMargin,
  type TextExportInput,
  type WriteRequest
} from '../shared/ipc'
import { FileOpError } from './fs/error'
import { processHtmlAssets } from './fs/export-assets'
import { grantPath, writeFile as writeDoc } from './fs/file-store'

const FILTERS: Record<'html' | 'pdf', Electron.FileFilter[]> = {
  html: [{ name: 'HTML', extensions: ['html'] }],
  pdf: [{ name: 'PDF', extensions: ['pdf'] }]
}

const TEXT_FILTERS: Record<'md' | 'txt', Electron.FileFilter[]> = {
  md: [{ name: 'Markdown', extensions: ['md'] }],
  txt: [{ name: '纯文本', extensions: ['txt'] }]
}

function safeBase(baseName: string): string {
  return baseName.replace(/[\\/:*?"<>|]/g, '_') || '未命名'
}

function startDir(docPath: string | null): string {
  return docPath ? path.dirname(path.resolve(docPath)) : process.cwd()
}

function docDirOf(input: ExportInput): string | null {
  return input.docPath ? path.dirname(path.resolve(input.docPath)) : null
}

function marginsOf(margin: PageMargin): { top: number; bottom: number; left: number; right: number } {
  // printToPDF 的量纲是英寸，@page 用的是毫米，两边共用一张毫米表
  const inches = MARGIN_MM[margin] / 25.4
  return { top: inches, bottom: inches, left: inches, right: inches }
}

async function chooseTarget(kind: 'html' | 'pdf', input: ExportInput, parent: BrowserWindow | null): Promise<string> {
  const title = kind === 'html' ? '导出 HTML' : '导出 PDF'
  return pickFile(title, `${safeBase(input.baseName)}.${kind}`, startDir(input.docPath), FILTERS[kind], parent)
}

async function pickFile(
  title: string,
  fileName: string,
  dir: string,
  filters: Electron.FileFilter[],
  parent: BrowserWindow | null
): Promise<string> {
  const options = { title, defaultPath: path.join(dir, fileName), filters }
  const choice = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
  if (choice.canceled || !choice.filePath) {
    throw new FileOpError('invalid-path', '已取消导出')
  }
  return choice.filePath
}

export async function exportHtml(input: ExportInput, parent: BrowserWindow | null): Promise<ExportOutcome> {
  const target = await chooseTarget('html', input, parent)
  const prepared = await processHtmlAssets(input.html, {
    docDir: docDirOf(input),
    mode: input.options.assets,
    targetDir: path.dirname(target),
    // 导出目录里可能已经有作者自己的 assets/，单独开一个 <文件名>.assets 免得混在一起
    assetDirName: `${path.basename(target, path.extname(target))}.assets`
  })

  grantPath(target)
  await writeFile(target, prepared.html, 'utf8')
  return { path: target, assets: prepared.report }
}

/**
 * PDF 由隐藏窗口打印：临时目录里的 HTML 读不到文档目录的相对图片，
 * 所以不管用户选了哪种资源处理，打印前一律内联。
 * 内容已经过 rehype-sanitize，该窗口仍关掉 Node 能力并保持上下文隔离。
 */
export async function exportPdf(input: ExportInput, parent: BrowserWindow | null): Promise<ExportOutcome> {
  const target = await chooseTarget('pdf', input, parent)
  const prepared = await processHtmlAssets(input.html, { docDir: docDirOf(input), mode: 'inline' })

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'mdforge-export-'))
  const tempHtml = path.join(tempDir, 'index.html')

  try {
    await writeFile(tempHtml, prepared.html, 'utf8')
    const win = new BrowserWindow({
      show: false,
      width: 900,
      height: 1200,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    })

    try {
      await win.loadFile(tempHtml)
      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: input.options.paper,
        margins: marginsOf(input.options.margin)
      })
      grantPath(target)
      await writeFile(target, Buffer.from(pdf))
    } finally {
      win.destroy()
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }

  return { path: target, assets: prepared.report }
}

/** 导出纯文本 / Markdown 源副本：按文档自身的编码与换行符写回 */
export async function exportText(input: TextExportInput, parent: BrowserWindow | null): Promise<string> {
  const target = await pickFile(
    input.extension === 'md' ? '导出 Markdown' : '导出纯文本',
    `${safeBase(input.baseName)}.${input.extension}`,
    startDir(input.docPath),
    TEXT_FILTERS[input.extension],
    parent
  )

  grantPath(target)
  const request: WriteRequest = { path: target, text: input.text, meta: input.meta, baseHash: '', force: true }
  const snapshot = await writeDoc(request)
  return snapshot.path
}
