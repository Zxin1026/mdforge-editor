import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AssetExportMode, AssetReport } from '../../shared/ipc'
import { isUnderGrantedRoot, mapFsError } from './file-store'

const IMG_ATTR = /(<img\b[^>]*?\bsrc\s*=\s*")([^"]*)(")/gi
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const NAME_CAP = 96

const MAX_INLINE_BYTES = 8 * 1024 * 1024
const MAX_INLINE_TOTAL_BYTES = 48 * 1024 * 1024

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon'
}

export interface AssetPlan {
  docDir: string | null
  mode: AssetExportMode
  /** copy 模式必填：导出 HTML 所在目录 */
  targetDir?: string
  /** copy 模式的资源目录名，如 README.assets */
  assetDirName?: string
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&lt;': '<',
  '&gt;': '>'
}

function decodeAttr(value: string): string {
  return value.replace(/&(?:amp|quot|#39|lt|gt);/g, (entity) => ENTITIES[entity] ?? entity)
}

function encodeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

function decodePercent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function mimeOf(absolute: string): string {
  return MIME[path.extname(absolute).toLowerCase()] ?? 'application/octet-stream'
}

/** 相对引用落到绝对路径；远程地址与授权范围之外（../ 逃出文档目录）返回 null */
function localTarget(docDir: string, src: string): string | null {
  const clean = decodePercent(decodeAttr(src).split('#')[0])
  if (clean === '' || clean.startsWith('//') || SCHEME.test(clean)) return null
  const absolute = path.resolve(docDir, clean)
  if (!isUnderGrantedRoot(absolute)) return null
  return absolute
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

function baseNameOf(absolute: string): string {
  const ext = path.extname(absolute)
  const stem = path
    .basename(absolute, ext)
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, NAME_CAP)
  return `${stem || 'image'}${ext || '.png'}`
}

export function collectImageRefs(html: string): string[] {
  const seen: string[] = []
  for (const match of html.matchAll(IMG_ATTR)) {
    if (!seen.includes(match[2])) seen.push(match[2])
  }
  return seen
}

async function statFile(absolute: string): Promise<{ size: number } | null> {
  try {
    const stat = await fs.stat(absolute)
    return stat.isFile() ? { size: stat.size } : null
  } catch {
    return null
  }
}

async function guard<T>(run: () => Promise<T>, target: string): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw mapFsError(error, target)
  }
}

/**
 * 导出前的资源处理：把相对图片复制到导出文件旁边或内联成 base64。
 * 不做这一步，导出的 HTML 一旦挪到别的目录，图片就全断了。
 */
export async function processHtmlAssets(html: string, plan: AssetPlan): Promise<{ html: string; report: AssetReport }> {
  const report: AssetReport = { copied: 0, inlined: 0, missing: [], skipped: [] }
  if (plan.mode === 'keep') return { html, report }

  const refs = collectImageRefs(html)
  // 未保存的文档没有基准目录，相对引用只能原样写出
  if (refs.length === 0 || plan.docDir === null) {
    report.skipped.push(...refs)
    return { html, report }
  }

  const docDir = plan.docDir
  const targetDir = plan.targetDir ?? docDir
  const assetDir = path.join(targetDir, plan.assetDirName ?? 'assets')
  const replacements = new Map<string, string>()
  const bySource = new Map<string, string>()
  const usedNames = new Set<string>()
  let assetDirReady = false
  let inlinedTotal = 0

  for (const ref of refs) {
    const absolute = localTarget(docDir, ref)
    if (absolute === null) {
      report.skipped.push(ref)
      continue
    }
    const stat = await statFile(absolute)
    if (stat === null) {
      report.missing.push(ref)
      continue
    }

    if (plan.mode === 'inline') {
      if (stat.size > MAX_INLINE_BYTES || inlinedTotal + stat.size > MAX_INLINE_TOTAL_BYTES) {
        report.skipped.push(ref)
        continue
      }
      const buffer = await guard(() => fs.readFile(absolute), absolute)
      inlinedTotal += buffer.length
      replacements.set(ref, encodeAttr(`data:${mimeOf(absolute)};base64,${buffer.toString('base64')}`))
      report.inlined += 1
      continue
    }

    let dest = bySource.get(absolute)
    if (dest === undefined) {
      if (!assetDirReady) {
        await guard(() => fs.mkdir(assetDir, { recursive: true }), assetDir)
        assetDirReady = true
      }
      const base = baseNameOf(absolute)
      const ext = path.extname(base)
      let index = 1
      let candidate = base
      // 同名不同图各落一个文件，后一次导出不会顶掉前一次
      while (usedNames.has(candidate.toLowerCase())) {
        candidate = `${base.slice(0, base.length - ext.length)}-${index}${ext}`
        index += 1
      }
      usedNames.add(candidate.toLowerCase())
      dest = path.join(assetDir, candidate)
      bySource.set(absolute, dest)
    }
    if ((await statFile(dest)) === null) {
      await guard(() => fs.copyFile(absolute, dest), dest)
      report.copied += 1
    }
    replacements.set(ref, encodeAttr(toPosix(path.relative(targetDir, dest))))
  }

  if (replacements.size === 0) return { html, report }
  const rewritten = html.replace(IMG_ATTR, (_all, pre: string, src: string, post: string) => {
    return pre + (replacements.get(src) ?? src) + post
  })
  return { html: rewritten, report }
}
