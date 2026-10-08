import { BrowserWindow, dialog } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AssetReport, BatchExportInput, BatchExportResult } from '../../shared/ipc'
import { FileOpError } from './error'
import { processHtmlAssets, safeRelative } from './export-assets'
import { grantFolder } from './file-store'

const MAX_FILES = 1000

/** 静态站点/批量导出的输出位置：目录选择框（允许现场新建） */
export async function chooseExportFolder(parent: BrowserWindow | null): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: '选择导出位置',
    properties: ['openDirectory', 'createDirectory']
  }
  const choice = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
  if (choice.canceled || choice.filePaths.length === 0) return null
  const dir = choice.filePaths[0]
  // 用户现场选过的目录登记为可读根：导出结果的"在文件夹中显示"与预览都要用它
  grantFolder(dir)
  return dir
}

/**
 * 批量导出：按相对结构写页面，图片经 processHtmlAssets 统一处理，
 * 单个页面失败不打断整批（失败原因逐条回给界面）。
 */
export async function exportBatch(input: BatchExportInput): Promise<BatchExportResult> {
  if (typeof input.outDir !== 'string' || input.outDir === '' || input.outDir.includes('\0')) {
    throw new FileOpError('invalid-path', '导出位置不合法')
  }
  const outDir = path.resolve(input.outDir)
  await fs.mkdir(outDir, { recursive: true }).catch(() => {})

  const assets: AssetReport = { copied: 0, inlined: 0, missing: [], skipped: [] }
  const failed: Array<{ relative: string; detail: string }> = []
  let written = 0

  const writeOne = async (rel: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run()
      written += 1
    } catch (error) {
      failed.push({ relative: rel, detail: error instanceof Error ? error.message : String(error) })
    }
  }

  for (const file of input.files.slice(0, MAX_FILES)) {
    const rel = safeRelative(file.relative)
    if (rel === null) {
      failed.push({ relative: String(file.relative), detail: '路径不合法' })
      continue
    }
    const target = path.join(outDir, rel)
    await writeOne(rel, async () => {
      const prepared = await processHtmlAssets(file.html, {
        docDir: file.docPath ? path.dirname(path.resolve(file.docPath)) : null,
        mode: input.options.assets,
        targetDir: path.dirname(target),
        assetDirName: `${path.basename(target, path.extname(target))}.assets`
      })
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, prepared.html, 'utf8')
      assets.copied += prepared.report.copied
      assets.inlined += prepared.report.inlined
      for (const item of prepared.report.missing) if (!assets.missing.includes(item)) assets.missing.push(item)
      for (const item of prepared.report.skipped) if (!assets.skipped.includes(item)) assets.skipped.push(item)
    })
  }

  for (const extra of input.extras ?? []) {
    const rel = safeRelative(extra.relative)
    if (rel === null) continue
    const target = path.join(outDir, rel)
    await writeOne(rel, async () => {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, extra.content, 'utf8')
    })
  }

  return { outDir, written, failed, assets }
}
