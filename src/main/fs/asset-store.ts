import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AssetWriteInput, AssetWriteResult } from '../../shared/ipc'
import { FileOpError } from './error'
import { grantPath, mapFsError, requireGranted } from './file-store'

const ASSET_DIR = 'assets'
const FALLBACK_STEM = 'image'
const MAX_STEM = 64
const MAX_INDEX = 999
export const MAX_ASSET_BYTES = 32 * 1024 * 1024

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif', '.ico'])

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/pjpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/x-bmp': '.bmp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico'
}

// Windows 下这些名字即使带扩展名也不能落盘，命中就退回默认名
const RESERVED = new Set(['con', 'prn', 'aux', 'nul'])

function isReserved(stem: string): boolean {
  const lower = stem.toLowerCase()
  return RESERVED.has(lower) || /^(com|lpt)[1-9]$/.test(lower)
}

function tidy(stem: string): string {
  return stem
    .replace(/-{2,}/g, '-')
    .replace(/^[._ -]+/, '')
    .replace(/[._ -]+$/, '')
}

function extOf(base: string, mime?: string): string {
  const ext = path.extname(base).toLowerCase()
  if (IMAGE_EXT.has(ext)) return ext
  if (mime) {
    const mapped = MIME_EXT[mime.toLowerCase().trim()]
    if (mapped) return mapped
  }
  return '.png'
}

/**
 * 把渲染进程给来的文件名压成一个纯文件名。
 * name 完全来自剪贴板（可能是 ../../x.png 或 C:\Windows\x.png），
 * 清洗后只剩文件名本体，拼接进 assets/ 才不可能跳出目录。
 */
export function sanitizeAssetName(name: string, mime?: string): string {
  const raw = typeof name === 'string' ? name : ''
  const base =
    raw
      .split(/[\\/]/)
      .filter((part) => part.length > 0)
      .pop() ?? ''
  const ext = extOf(base, mime)
  const dot = base.lastIndexOf('.')
  const source = dot > 0 ? base.slice(0, dot) : base
  let stem = tidy(source.replace(/[^A-Za-z0-9._ -]/g, '-'))
  if (stem.length > MAX_STEM) stem = tidy(stem.slice(0, MAX_STEM))
  if (stem.length === 0 || isReserved(stem)) stem = FALLBACK_STEM
  return `${stem}${ext}`
}

function indexedName(base: string, index: number): string {
  if (index <= 0) return base
  const ext = path.extname(base)
  return `${base.slice(0, base.length - ext.length)}-${index}${ext}`
}

function requireGrantedDoc(docPath: string): string {
  if (typeof docPath !== 'string' || docPath.includes('\0')) {
    throw new FileOpError('invalid-path', '非法文档路径', { path: docPath })
  }
  // 未保存的文档没有目录可落脚，只能拒绝；已授权判定沿用 file-store 的模型
  if (!path.isAbsolute(docPath)) {
    throw new FileOpError('not-granted', '文档尚未保存，无法确定图片落盘位置', {
      path: docPath,
      hint: '请先保存文档，再粘贴图片'
    })
  }
  const absolute = path.resolve(docPath)
  requireGranted(absolute)
  return absolute
}

function toPosixRelative(docDir: string, target: string): string {
  return path.relative(docDir, target).split(path.sep).join('/')
}

/** 粘贴图片落盘：写到文档同级的 assets/，写完立刻授权，让 mdasset:// 能马上显示 */
export async function saveAsset(input: AssetWriteInput): Promise<AssetWriteResult> {
  const doc = requireGrantedDoc(input.docPath)
  const buffer = Buffer.from(input.bytes ?? new Uint8Array(0))

  if (buffer.length === 0) {
    throw new FileOpError('invalid-path', '图片内容为空，未保存', { path: doc })
  }
  if (buffer.length > MAX_ASSET_BYTES) {
    throw new FileOpError('invalid-path', `图片超过 ${Math.round(MAX_ASSET_BYTES / 1024 / 1024)} MiB，未保存`, {
      path: doc,
      hint: '请先压缩图片或手动放入 assets/ 目录后引用'
    })
  }

  const dir = path.join(path.dirname(doc), ASSET_DIR)
  const base = sanitizeAssetName(input.name)
  let written = ''

  try {
    await fs.mkdir(dir, { recursive: true })
    for (let index = 0; index <= MAX_INDEX; index += 1) {
      const candidate = path.join(dir, indexedName(base, index))
      try {
        // wx：已存在就换下一个序号，绝不覆盖用户的旧图
        await fs.writeFile(candidate, buffer, { flag: 'wx' })
        written = candidate
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw mapFsError(error, candidate)
      }
    }
  } catch (error) {
    throw mapFsError(error, dir)
  }

  if (!written) {
    throw new FileOpError('invalid-path', `assets/ 下同名图片过多，未保存 ${base}`, {
      path: dir,
      hint: '请清理 assets/ 目录后重试'
    })
  }

  grantPath(written)
  return {
    absolute: written,
    relative: toPosixRelative(path.dirname(doc), written),
    name: path.basename(written)
  }
}
