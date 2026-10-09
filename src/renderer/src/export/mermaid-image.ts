import { renderMermaidWithTheme } from '../editor/mermaid'

/**
 * 图表 → PNG（DOCX 用）：mermaid 直接给 SVG，画面本身经 canvas 就能转位图，
 * 不像公式要过 foreignObject。Word 页面按白底摆图，固定用浅色配色。
 */

export interface MermaidImage {
  bytes: Uint8Array
  /** 版面上的显示宽度（css px） */
  width: number
}

const SCALE = 2
const CACHE_LIMIT = 16
const cache = new Map<string, MermaidImage | null>()

/** 取 svg 的自带尺寸；mermaid 配了 useMaxWidth:false 会给宽高，兜底再看 viewBox */
function svgSize(root: Element): { width: number; height: number } | null {
  const px = (value: string | null): number => {
    const parsed = Number.parseFloat(value ?? '')
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }
  let width = px(root.getAttribute('width'))
  let height = px(root.getAttribute('height'))
  if (width === 0 || height === 0) {
    const box = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number)
    if (box.length === 4 && box[2] > 0 && box[3] > 0) {
      width = width === 0 ? box[2] : width
      height = height === 0 ? box[3] : height
    }
  }
  return width > 0 && height > 0 ? { width, height } : null
}

async function drawPng(svg: string, width: number, height: number): Promise<Uint8Array | null> {
  const image = new Image()
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(width * SCALE)
  canvas.height = Math.round(height * SCALE)
  const context = canvas.getContext('2d')
  if (context === null) return null
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (blob === null) return null
  return new Uint8Array(await blob.arrayBuffer())
}

/** 渲染失败与无 DOM 环境（单测）都返回 null，调用方退回原始代码块 */
export async function rasterizeMermaid(source: string): Promise<MermaidImage | null> {
  if (typeof document === 'undefined') return null
  const cached = cache.get(source)
  if (cached !== undefined) return cached

  let result: MermaidImage | null = null
  try {
    const svg = await renderMermaidWithTheme(source, 'light')
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const root = parsed.documentElement
    const size = svgSize(root)
    if (size !== null) {
      // 显式宽高再序列化：<img> 对只有 viewBox 的 SVG 会按 300×150 兜底
      root.setAttribute('width', String(size.width))
      root.setAttribute('height', String(size.height))
      const bytes = await drawPng(new XMLSerializer().serializeToString(root), size.width, size.height)
      if (bytes !== null) result = { bytes, width: size.width }
    }
  } catch {
    result = null
  }

  cache.set(source, result)
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return result
}
