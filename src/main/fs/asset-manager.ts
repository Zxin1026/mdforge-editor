import { promises as fs } from 'node:fs'
import path from 'node:path'
import { scanFences } from '../../shared/fences'
import type {
  AssetListResult,
  AssetRenameInput,
  AssetRenameResult,
  AssetReplaceInput,
  AssetReplaceResult,
  ManagedAsset
} from '../../shared/ipc'
import { MAX_ASSET_BYTES } from './asset-store'
import { decodeBuffer, encodeText } from './encoding'
import { FileOpError } from './error'
import { cacheKeyOf, isUnderGrantedRoot, mapFsError, writeFileAtomic } from './file-store'
import { imageSizeOf, isImagePath } from './image-meta'
import { walkMarkdownFiles } from './walk'

/** 与文件树、搜索遍历同一份跳表口径 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', 'dist', 'out', 'build'])
const MAX_DEPTH = 12
const MAX_ASSETS = 500
const MAX_REFS_PER_ASSET = 24
const MAX_BATCH = 200
/** 尺寸解析只读文件头，够覆盖大图里的 EXIF 与元数据段 */
const HEADER_BYTES = 256 * 1024
/** 应用内压缩要整图进内存，超出的直接劝退 */
const MAX_READ_BYTES = 64 * 1024 * 1024

const IMG_LINK = /!\[[^\]]*\]\(\s*([^)]*)\)/g
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const BAD_NAME = /[\\/:*?"<>|\0]/
/** 结尾的引号段是 title（如 "w=640"），剥掉后剩下的才是地址 */
const TRAILING_TITLE = /^(.*?)\s+(?:"[^"]*"|'[^']*')$/

/**
 * 图片链接的括号内容 → 地址原文。
 * 粘贴来的图片名可能带空格（`assets/my pic.png`）或整体包在尖括号里，
 * 这两种写法都要认，title（含编辑器写的 w=640）要剥掉。
 */
export function parseImageTarget(inner: string): string | null {
  let value = inner.trim()
  const title = TRAILING_TITLE.exec(value)
  if (title) value = title[1].trim()
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim()
  return value === '' ? null : value
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

function keyOf(target: string): string {
  return cacheKeyOf(path.resolve(target))
}

async function exists(target: string): Promise<boolean> {
  return fs
    .lstat(target)
    .then(() => true)
    .catch(() => false)
}

/** 扫描根：已打开的文件夹，或某个已打开文档所在目录 */
async function requireRoot(target: unknown): Promise<string> {
  if (typeof target !== 'string' || !target || target.includes('\0')) {
    throw new FileOpError('invalid-path', '非法目录路径', { path: String(target) })
  }
  const absolute = path.resolve(target)
  if (!isUnderGrantedRoot(absolute)) {
    throw new FileOpError('not-granted', '这个文件夹还没有被授权访问', {
      path: absolute,
      hint: '请先用「文件 → 打开文件夹…」选择它，或先打开其中的文档'
    })
  }
  const stat = await fs.stat(absolute).catch(() => null)
  if (!stat || !stat.isDirectory()) {
    throw new FileOpError('not-found', '文件夹不存在', { path: absolute })
  }
  return absolute
}

/** 操作目标：必须是扫描根下真实存在的图片文件（符号链接一律不动） */
async function requireImage(root: string, target: unknown): Promise<string> {
  if (typeof target !== 'string' || !target || target.includes('\0')) {
    throw new FileOpError('invalid-path', '非法图片路径', { path: String(target) })
  }
  const absolute = path.resolve(target)
  const key = cacheKeyOf(absolute)
  const rootKey = cacheKeyOf(root)
  if (key !== rootKey && !key.startsWith(rootKey + path.sep)) {
    throw new FileOpError('invalid-path', '图片不在当前文件夹里', { path: absolute })
  }
  const stat = await fs.lstat(absolute).catch(() => null)
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
    throw new FileOpError('not-found', '图片不存在或不允许操作的链接', { path: absolute })
  }
  if (!isImagePath(absolute)) {
    throw new FileOpError('invalid-path', '不是可管理的图片格式', { path: absolute })
  }
  return absolute
}

/** 新文件名必须是不带路径的纯文件名，且扩展名还是图片 */
function validImageName(raw: unknown): string {
  if (typeof raw !== 'string') throw new FileOpError('invalid-path', '名称不合法')
  const name = raw.trim()
  if (name === '' || name === '.' || name === '..') {
    throw new FileOpError('invalid-path', '名称不能为空或只含点号')
  }
  if (name.startsWith('.')) throw new FileOpError('invalid-path', '名称不能以点开头')
  if (name.length > 120) throw new FileOpError('invalid-path', '名称过长')
  if (BAD_NAME.test(name)) throw new FileOpError('invalid-path', '名称里不能包含 \\ / : * ? " < > |')
  if (!isImagePath(name)) throw new FileOpError('invalid-path', '扩展名必须是图片格式')
  return name
}

async function readHead(absolute: string): Promise<Buffer | null> {
  try {
    const handle = await fs.open(absolute, 'r')
    try {
      const buffer = Buffer.alloc(HEADER_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0)
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

function decodeRef(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** 文档正文里的图片引用 → 绝对路径键；解析不出的（远程、非图片扩展）返回 null */
function refKeyOf(docDir: string, raw: string): string | null {
  const clean = decodeRef(raw.trim()).split('#')[0]
  if (clean === '' || SCHEME.test(clean)) return null
  const absolute = path.resolve(docDir, clean)
  if (!isImagePath(absolute)) return null
  return cacheKeyOf(absolute)
}

/** 扫描根下的所有图片文件 */
async function walkImages(root: string, out: Array<{ path: string; size: number }>): Promise<void> {
  async function visit(dir: string, depth: number): Promise<void> {
    if (out.length >= MAX_ASSETS || depth > MAX_DEPTH) return
    const names = await fs.readdir(dir).catch(() => [] as string[])
    for (const name of names) {
      if (out.length >= MAX_ASSETS) return
      if (name.startsWith('.')) continue
      const full = path.join(dir, name)
      const stat = await fs.lstat(full).catch(() => null)
      if (stat === null || stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(name.toLowerCase())) continue
        await visit(full, depth + 1)
      } else if (stat.isFile() && isImagePath(name)) {
        out.push({ path: full, size: stat.size })
      }
    }
  }
  await visit(root, 0)
}

/**
 * 图片资源管理器：列出扫描根下的图片（尺寸、大小），
 * 并顺着正文里的图片引用标注每张图被哪些文档用到。
 */
export async function listAssets(rootInput: string): Promise<AssetListResult> {
  const root = await requireRoot(rootInput)

  const images: Array<{ path: string; size: number }> = []
  await walkImages(root, images)

  const byKey = new Map<string, ManagedAsset>()
  for (const image of images) {
    byKey.set(cacheKeyOf(image.path), {
      path: image.path,
      relative: toPosix(path.relative(root, image.path)),
      name: path.basename(image.path),
      size: image.size,
      width: null,
      height: null,
      refs: []
    })
  }

  const { files: docs } = await walkMarkdownFiles(root)
  for (const doc of docs) {
    let text: string
    try {
      const buffer = await fs.readFile(doc.path)
      text = decodeBuffer(buffer).text
    } catch {
      continue
    }
    const { fenced } = scanFences(text)
    const docDir = path.dirname(doc.path)
    const docRelative = toPosix(path.relative(root, doc.path))
    const rows = text.split('\n')
    for (let index = 0; index < rows.length; index += 1) {
      if (fenced.has(index + 1) || !rows[index].includes('![')) continue
      IMG_LINK.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = IMG_LINK.exec(rows[index])) !== null) {
        const raw = parseImageTarget(match[1])
        if (raw === null) continue
        const key = refKeyOf(docDir, raw)
        if (key === null) continue
        const asset = byKey.get(key)
        if (!asset || asset.refs.length >= MAX_REFS_PER_ASSET) continue
        const line = index + 1
        if (!asset.refs.some((ref) => ref.doc === docRelative && ref.line === line)) {
          asset.refs.push({ doc: docRelative, line })
        }
      }
    }
  }

  const assets: ManagedAsset[] = []
  for (const asset of byKey.values()) {
    const head = await readHead(asset.path)
    if (head !== null) {
      const size = imageSizeOf(head, asset.path)
      if (size !== null) {
        asset.width = size.width
        asset.height = size.height
      }
    }
    assets.push(asset)
  }
  assets.sort((a, b) => a.relative.localeCompare(b.relative, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }))

  return { root, assets, docs: docs.length, truncated: images.length >= MAX_ASSETS }
}

/**
 * 引用路径的替换写法：相对引用可能写成 `assets/a.png`、`./assets/a.png`，
 * 或对 CJK 与空格做过百分号编码的形态，这些都要跟着改名一起换。
 */
export function refSpellings(docDir: string, from: string, to: string): Array<[string, string]> {
  const fromRel = toPosix(path.relative(docDir, from))
  const toRel = toPosix(path.relative(docDir, to))
  // 空相对路径与跨盘符（结果里带冒号）都无法写成合法引用
  if (fromRel === '' || fromRel.includes(':')) return []
  const pairs: Array<[string, string]> = [[fromRel, toRel]]
  const encodedFrom = encodeURI(fromRel)
  const encodedTo = encodeURI(toRel)
  if (encodedFrom !== fromRel) pairs.push([encodedFrom, encodedTo])
  const all: Array<[string, string]> = []
  for (const [a, b] of pairs) {
    all.push([a, b], [`./${a}`, `./${b}`])
  }
  return all
}

/** 按改名清单改写扫描根下所有文档里的引用；skip 里的文档留给渲染进程改内存缓冲 */
async function rewriteRefs(
  root: string,
  changes: Array<{ from: string; to: string }>,
  skip: Set<string>
): Promise<{ touched: string[]; refs: number }> {
  const touched: string[] = []
  let refs = 0
  if (changes.length === 0) return { touched, refs }

  const { files: docs } = await walkMarkdownFiles(root)
  for (const doc of docs) {
    if (skip.has(cacheKeyOf(doc.path))) continue
    let decoded
    try {
      decoded = decodeBuffer(await fs.readFile(doc.path))
    } catch {
      continue
    }
    const docDir = path.dirname(doc.path)
    let next = decoded.text
    let count = 0
    for (const change of changes) {
      for (const [fromSpelling, toSpelling] of refSpellings(docDir, change.from, change.to)) {
        const parts = next.split(fromSpelling)
        if (parts.length > 1) {
          count += parts.length - 1
          next = parts.join(toSpelling)
        }
      }
    }
    if (count === 0) continue
    try {
      await writeFileAtomic(doc.path, encodeText(next, decoded.meta, doc.path))
      touched.push(doc.path)
      refs += count
    } catch {
      // 单个文档写不进去不影响其余文档与改名结果本身
    }
  }
  return { touched, refs }
}

/** 批量重命名：逐个改名，随后统一改写所有文档里的引用 */
export async function renameAssets(input: AssetRenameInput): Promise<AssetRenameResult> {
  const root = await requireRoot(input.root)
  const skip = new Set((input.skip ?? []).map((item) => keyOf(item)))
  const files: AssetRenameResult['files'] = []
  const changes: Array<{ from: string; to: string }> = []

  for (const item of (input.renames ?? []).slice(0, MAX_BATCH)) {
    try {
      const from = await requireImage(root, item?.from)
      const name = validImageName(item?.to)
      const dest = path.join(path.dirname(from), name)
      if (cacheKeyOf(dest) === cacheKeyOf(from)) {
        files.push({ from, path: from, kind: 'ok' })
        continue
      }
      if (await exists(dest)) {
        throw new FileOpError('invalid-path', `目标已存在：${name}`, { path: dest })
      }
      try {
        await fs.rename(from, dest)
      } catch (error) {
        throw mapFsError(error, from)
      }
      changes.push({ from, to: dest })
      files.push({ from, path: dest, kind: 'ok' })
    } catch (error) {
      files.push({
        from: typeof item?.from === 'string' ? item.from : '',
        path: typeof item?.from === 'string' ? item.from : '',
        kind: 'error',
        detail: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const { touched, refs } = await rewriteRefs(root, changes, skip)
  return { files, touched, refs }
}

/** 覆盖图片内容（压缩后写回）；换扩展名时写新文件、删旧文件，并改写引用 */
export async function replaceAsset(input: AssetReplaceInput): Promise<AssetReplaceResult> {
  const root = await requireRoot(input.root)
  const skip = new Set((input.skip ?? []).map((item) => keyOf(item)))
  const original = await requireImage(root, input.path)

  const buffer = Buffer.from(input.bytes ?? new Uint8Array(0))
  if (buffer.length === 0) {
    throw new FileOpError('invalid-path', '压缩结果为空，未写入', { path: original })
  }
  if (buffer.length > MAX_ASSET_BYTES) {
    throw new FileOpError('invalid-path', `压缩结果超过 ${Math.round(MAX_ASSET_BYTES / 1024 / 1024)} MiB，未写入`, {
      path: original
    })
  }

  const name = input.newName === undefined ? path.basename(original) : validImageName(input.newName)
  const dest = path.join(path.dirname(original), name)
  const changes: Array<{ from: string; to: string }> = []

  try {
    if (cacheKeyOf(dest) === cacheKeyOf(original)) {
      await fs.writeFile(original, buffer)
    } else {
      if (await exists(dest)) {
        throw new FileOpError('invalid-path', `目标已存在：${name}`, { path: dest })
      }
      await fs.writeFile(dest, buffer)
      changes.push({ from: original, to: dest })
    }
  } catch (error) {
    throw mapFsError(error, dest)
  }

  const { touched, refs } = await rewriteRefs(root, changes, skip)
  if (changes.length > 0) await fs.rm(original, { force: true }).catch(() => {})
  return { path: dest, size: buffer.length, touched, refs }
}

/** 压缩前取原始字节：canvas 需要同源 blob，不能直接画 mdasset:// 的图 */
export async function readAssetBytes(target: unknown): Promise<Uint8Array> {
  if (typeof target !== 'string' || !target || target.includes('\0')) {
    throw new FileOpError('invalid-path', '非法图片路径')
  }
  const absolute = path.resolve(target)
  if (!isUnderGrantedRoot(absolute) || !isImagePath(absolute)) {
    throw new FileOpError('not-granted', '这张图片还没有被授权访问', { path: absolute })
  }
  try {
    const stat = await fs.stat(absolute)
    if (stat.size > MAX_READ_BYTES) {
      throw new FileOpError('invalid-path', `图片超过 ${Math.round(MAX_READ_BYTES / 1024 / 1024)} MiB，不适合在应用内压缩`, {
        path: absolute,
        hint: '可以用外部工具压缩后再放回原位'
      })
    }
    return new Uint8Array(await fs.readFile(absolute))
  } catch (error) {
    throw mapFsError(error, absolute)
  }
}
