import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { FolderEntry } from '../../shared/ipc'
import { decodeBuffer } from './encoding'
import { FileOpError } from './error'
import { cacheKeyOf, isUnderFolderRoot, mapFsError } from './file-store'

const OPENABLE = new Set(['.md', '.markdown', '.mdown', '.mkd', '.txt'])
/** 文件树里不展开这些目录（与搜索遍历同一份口径） */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', 'dist', 'out', 'build'])
/** 预览只读文件头，够放下 front matter 加几行正文 */
const PREVIEW_BYTES = 8192
const PREVIEW_CHARS = 80
/** 名称里的非法字符：Windows 上这些字符无法进文件名 */
const BAD_NAME = /[\\/:*?"<>|\0]/

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

/** 目录要先过授权与存在性检查才允许列出/写入 */
async function requireFolderDir(target: unknown): Promise<string> {
  if (typeof target !== 'string' || !target || target.includes('\0')) {
    throw new FileOpError('invalid-path', '非法目录路径', { path: String(target) })
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
  return absolute
}

/** 树操作的目标：必须是授权根下真实存在的文件或目录 */
async function requireEntry(target: unknown): Promise<string> {
  if (typeof target !== 'string' || !target || target.includes('\0')) {
    throw new FileOpError('invalid-path', '非法路径', { path: String(target) })
  }
  const absolute = path.resolve(target)
  if (!isUnderFolderRoot(absolute)) {
    throw new FileOpError('not-granted', '这个路径不在已打开的文件夹里', { path: absolute })
  }
  const stat = await fs.lstat(absolute).catch(() => null)
  if (!stat || stat.isSymbolicLink()) {
    throw new FileOpError('not-found', '条目不存在或不允许操作的链接', { path: absolute })
  }
  return absolute
}

function validName(raw: unknown): string {
  if (typeof raw !== 'string') throw new FileOpError('invalid-path', '名称不合法')
  const name = raw.trim()
  if (name === '' || name === '.' || name === '..') {
    throw new FileOpError('invalid-path', '名称不能为空或只含点号')
  }
  if (name.startsWith('.')) {
    throw new FileOpError('invalid-path', '名称不能以点开头（这类文件在文件树里不显示）')
  }
  if (name.length > 120) throw new FileOpError('invalid-path', '名称过长')
  if (BAD_NAME.test(name)) {
    throw new FileOpError('invalid-path', '名称里不能包含 \\ / : * ? " < > |')
  }
  return name
}

async function exists(target: string): Promise<boolean> {
  return fs
    .lstat(target)
    .then(() => true)
    .catch(() => false)
}

/** 在已授权文件夹里新建子目录 */
export async function createFolder(dir: string, name: string): Promise<string> {
  const parent = await requireFolderDir(dir)
  const clean = validName(name)
  const target = path.join(parent, clean)
  if (await exists(target)) {
    throw new FileOpError('invalid-path', `这里已有同名条目：${clean}`, { path: target })
  }
  try {
    await fs.mkdir(target)
  } catch (error) {
    throw mapFsError(error, target)
  }
  return target
}

/** 重命名文件或文件夹（位置不变） */
export async function renamePath(target: string, name: string): Promise<string> {
  const absolute = await requireEntry(target)
  const clean = validName(name)
  const dest = path.join(path.dirname(absolute), clean)

  const key = cacheKeyOf(absolute)
  const destKey = cacheKeyOf(dest)
  if (key === destKey) {
    // 只是大小写变化：同名直接不动，改大小写则继续走到 rename
    if (clean === path.basename(absolute)) return absolute
  } else if (await exists(dest)) {
    throw new FileOpError('invalid-path', `这里已有同名条目：${clean}`, { path: dest })
  }

  try {
    await fs.rename(absolute, dest)
  } catch (error) {
    throw mapFsError(error, absolute)
  }
  return dest
}

/** 把文件或文件夹移动到另一个目录下（拖拽移动） */
export async function movePath(target: string, destDir: string): Promise<string> {
  const absolute = await requireEntry(target)
  const parent = await requireFolderDir(destDir)

  const key = cacheKeyOf(absolute)
  const parentKey = cacheKeyOf(parent)
  if (parentKey === key || parentKey.startsWith(key + path.sep)) {
    throw new FileOpError('invalid-path', '不能把文件夹移动到它自己或它的子目录里', { path: absolute })
  }
  const dest = path.join(parent, path.basename(absolute))
  if (cacheKeyOf(dest) === key) return absolute
  if (await exists(dest)) {
    throw new FileOpError('invalid-path', `目标目录里已有同名条目：${path.basename(absolute)}`, { path: dest })
  }

  try {
    await fs.rename(absolute, dest)
  } catch (error) {
    throw mapFsError(error, absolute)
  }
  return dest
}

/** 列出已授权文件夹的直接子级：子目录在前、文件在后，文件带首行预览 */
export async function listFolder(target: string): Promise<FolderEntry[]> {
  const absolute = await requireFolderDir(target)

  let names: string[]
  try {
    names = await fs.readdir(absolute)
  } catch (error) {
    throw mapFsError(error, absolute)
  }

  const dirs: Array<{ name: string; path: string }> = []
  const files: Array<{ name: string; path: string; size: number }> = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    const full = path.join(absolute, name)
    const info = await fs.lstat(full).catch(() => null)
    if (!info || info.isSymbolicLink()) continue
    if (info.isDirectory()) {
      if (SKIP_DIRS.has(name.toLowerCase())) continue
      dirs.push({ name, path: full })
    } else if (info.isFile() && OPENABLE.has(path.extname(name).toLowerCase())) {
      files.push({ name, path: full, size: info.size })
    }
  }
  const byName = (a: { name: string }, b: { name: string }): number =>
    a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
  dirs.sort(byName)
  files.sort(byName)

  const entries: FolderEntry[] = dirs.map((dir) => ({ name: dir.name, path: dir.path, kind: 'dir', preview: '' }))
  for (const file of files) {
    entries.push({
      name: file.name,
      path: file.path,
      kind: 'file',
      preview: await readPreview(file.path, file.size)
    })
  }
  return entries
}
