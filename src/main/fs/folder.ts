import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { FolderEntry } from '../../shared/ipc'
import { decodeBuffer } from './encoding'
import { FileOpError } from './error'
import { isUnderFolderRoot, mapFsError } from './file-store'

const OPENABLE = new Set(['.md', '.markdown', '.mdown', '.mkd', '.txt'])
/** 预览只读文件头，够放下 front matter 加几行正文 */
const PREVIEW_BYTES = 8192
const PREVIEW_CHARS = 80

/** 列表里的首行预览：跳过 front matter，剥掉行首标记 */
function previewOf(text: string): string {
  const lines = text.split('\n')
  let start = 0
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
    if (end > 0) start = end + 1
  }
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === '') continue
    const image = /^!?\[([^\]]*)\]\([^)]*\)$/.exec(line)
    if (image) {
      if (image[1].trim() !== '') return image[1].trim().slice(0, PREVIEW_CHARS)
      continue
    }
    const cleaned = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/^([-*+]|\d+[.)])\s+/, '')
      .replace(/^```/, '')
      .trim()
    if (cleaned === '') continue
    return cleaned.slice(0, PREVIEW_CHARS)
  }
  return ''
}

/** 读文件头做预览：解不出来（编码怪、被占用）就退回空串，绝不因此弄挂列表 */
async function readPreview(absolute: string, size: number): Promise<string> {
  try {
    const length = Math.min(size, PREVIEW_BYTES)
    if (length <= 0) return ''
    const handle = await fs.open(absolute, 'r')
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, 0)
      const head = buffer.subarray(0, bytesRead)
      let text: string
      try {
        text = decodeBuffer(head).text
      } catch {
        text = head.toString('utf8')
      }
      return previewOf(text)
    } finally {
      await handle.close()
    }
  } catch {
    return ''
  }
}

/** 列出已授权文件夹里的可打开文件：只列直接子级，按名称排序，带上首行预览 */
export async function listFolder(target: string): Promise<FolderEntry[]> {
  if (!target || target.includes('\0')) {
    throw new FileOpError('invalid-path', '非法目录路径', { path: target })
  }
  const absolute = path.resolve(target)
  if (!isUnderFolderRoot(absolute)) {
    throw new FileOpError('not-granted', '这个文件夹还没有通过“打开文件夹”授权', {
      path: absolute,
      hint: '请先用「文件 → 打开文件夹…」选择它'
    })
  }
  const stat = await fs.stat(absolute).catch(() => null)
  if (!stat || !stat.isDirectory()) {
    throw new FileOpError('not-found', '文件夹不存在', { path: absolute })
  }

  let names: string[]
  try {
    names = await fs.readdir(absolute)
  } catch (error) {
    throw mapFsError(error, absolute)
  }

  const files: Array<{ name: string; path: string; size: number }> = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    if (!OPENABLE.has(path.extname(name).toLowerCase())) continue
    const full = path.join(absolute, name)
    const info = await fs.stat(full).catch(() => null)
    if (!info || !info.isFile()) continue
    files.push({ name, path: full, size: info.size })
  }
  files.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }))

  const entries: FolderEntry[] = []
  for (const file of files) {
    entries.push({ name: file.name, path: file.path, preview: await readPreview(file.path, file.size) })
  }
  return entries
}
