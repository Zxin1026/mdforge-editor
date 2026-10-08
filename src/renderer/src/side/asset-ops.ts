/** 图片资源管理器的纯逻辑：格式化、命名与格式换算，不碰 DOM 与磁盘 */

import { relativePosix } from '../paths'

export { relativePosix }

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

export function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

export function stemOf(name: string): string {
  const ext = extOf(name)
  return ext === '' ? name : name.slice(0, name.length - ext.length)
}

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

export function mimeOfExt(ext: string): string {
  return MIME[ext.toLowerCase()] ?? 'application/octet-stream'
}

/** 画布能作为输出格式的扩展名：其余格式建议转 WebP 或 JPEG */
export const CANVAS_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

/** 目标 MIME 对应的扩展名；同扩展名时返回 undefined 表示原地覆盖 */
export function targetNameFor(name: string, targetMime: string): string | undefined {
  const ext = targetMime === 'image/webp' ? '.webp' : targetMime === 'image/jpeg' ? '.jpg' : '.png'
  const current = extOf(name)
  if (current === ext) return undefined
  // .jpeg 与 .jpg 同义，不算换格式
  if (ext === '.jpg' && current === '.jpeg') return undefined
  return `${stemOf(name)}${ext}`
}

/**
 * 批量重命名计划：`前缀-序号.扩展名`，序号从 start 起、按数量自动补零；
 * 扩展名保持每张图片自己的，混合格式一起改也不会乱。
 */
export function renamePlan(names: readonly string[], prefix: string, start: number): string[] {
  const count = names.length
  const width = String(Math.max(0, Math.floor(start)) + Math.max(0, count - 1)).length
  return names.map((name, index) => {
    const number = String(Math.max(0, Math.floor(start)) + index).padStart(width, '0')
    const ext = extOf(name)
    return `${prefix}-${number}${ext}`
  })
}

export function shorten(text: string, limit = 46): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > limit ? `${one.slice(0, limit)}…` : one
}
