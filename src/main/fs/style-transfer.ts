import { app, dialog, type BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  STYLE_CONTENT_MAX,
  type CustomStyleImport,
  type CustomStyleKind,
  type CustomTemplate,
  type CustomTheme
} from '../../shared/ipc'
import { FileOpError } from './error'
import { grantPath } from './file-store'
import { parseImportedStyle, parseKind, readStyleItem, saveStyle, styleProblem } from './style-store'

/**
 * 主题与模板的导入导出：都过系统对话框。
 * 导入认 .json（{name, css|html}）或原始 .css/.html，导出统一写原始扩展名。
 */

const IMPORT_FORMATS: Record<CustomStyleKind, Electron.FileFilter[]> = {
  theme: [
    { name: '导出主题', extensions: ['json', 'css'] },
    { name: '所有文件', extensions: ['*'] }
  ],
  template: [
    { name: '页面模板', extensions: ['json', 'html', 'htm'] },
    { name: '所有文件', extensions: ['*'] }
  ]
}

/** json 外壳与转义会放大文本，导入的读取上限比内容上限宽松一倍 */
const MAX_IMPORT_BYTES = STYLE_CONTENT_MAX * 2

export async function importStyle(kindRaw: unknown, parent: BrowserWindow | null): Promise<CustomStyleImport | null> {
  const kind = parseKind(kindRaw)
  const options: Electron.OpenDialogOptions = {
    title: kind === 'theme' ? '导入导出主题' : '导入页面模板',
    properties: ['openFile'],
    filters: IMPORT_FORMATS[kind]
  }
  const choice = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
  if (choice.canceled || choice.filePaths.length === 0) return null

  const file = choice.filePaths[0]
  const stat = await fs.stat(file)
  if (stat.size > MAX_IMPORT_BYTES) throw new FileOpError('invalid-path', '文件过大，无法作为主题导入')
  const parsed = parseImportedStyle(kind, file, await fs.readFile(file, 'utf-8'))
  const problem = styleProblem(kind, parsed.content)
  if (problem !== null) throw new FileOpError('invalid-path', `${path.basename(file)}：${problem}`)

  const saved = await saveStyle({ kind, id: null, name: parsed.name, content: parsed.content })
  const item = (kind === 'theme' ? saved.library.themes : saved.library.templates).find(
    (entry) => entry.id === saved.id
  )
  return { id: saved.id, name: item?.name ?? parsed.name, kind, library: saved.library }
}

const EXPORT_FORMATS: Record<CustomStyleKind, Electron.FileFilter[]> = {
  theme: [{ name: 'CSS 样式', extensions: ['css'] }],
  template: [{ name: 'HTML 模板', extensions: ['html'] }]
}

/** 导出：写原始 .css/.html，条目名交给文件名（再导入时文件名变回条目名） */
export async function exportStyle(
  kindRaw: unknown,
  idRaw: unknown,
  parent: BrowserWindow | null
): Promise<string | null> {
  const kind = parseKind(kindRaw)
  if (typeof idRaw !== 'string' || !idRaw) throw new FileOpError('invalid-path', '主题编号不合法')
  const item = await readStyleItem(kind, idRaw)
  const ext = kind === 'theme' ? 'css' : 'html'
  const fileName = `${item.name.replace(/[\\/:*?"<>|]/g, '_') || '导出'}.${ext}`
  const options: Electron.SaveDialogOptions = {
    title: kind === 'theme' ? '导出主题' : '导出页面模板',
    defaultPath: path.join(app.getPath('documents'), fileName),
    filters: EXPORT_FORMATS[kind]
  }
  const choice = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
  if (choice.canceled || !choice.filePath) return null

  const content = kind === 'theme' ? (item as CustomTheme).css : (item as CustomTemplate).html
  grantPath(choice.filePath)
  const temp = `${choice.filePath}.${process.pid}.tmp`
  try {
    await fs.writeFile(temp, content, 'utf-8')
    await fs.rename(temp, choice.filePath)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw error
  }
  return choice.filePath
}
