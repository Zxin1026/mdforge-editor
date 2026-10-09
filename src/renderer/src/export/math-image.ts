import katex from 'katex'

/**
 * 公式 → PNG：Word 没有可靠的 LaTeX 渲染（OMML 需要一整套转换器），
 * 导出时把公式画成图片嵌进文档，是保真度与改动面折中后的路线。
 * 输出用 2 倍像素画，Word 里按 css 尺寸摆放，缩放不失真。
 */

export interface MathImage {
  bytes: Uint8Array
  /** 版面上的显示宽度（css px） */
  width: number
}

const SCALE = 2
const PAD = 2
const CACHE_LIMIT = 64
const cache = new Map<string, MathImage | null>()

function measuredSize(html: string): { width: number; height: number } | null {
  // 探测节点挂在屏外量；katex 样式表应用里已经全局加载，量尺与最终出图一致
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden'
  host.innerHTML = html
  document.body.appendChild(host)
  const root = host.firstElementChild
  const width = root instanceof HTMLElement ? root.offsetWidth : 0
  const height = root instanceof HTMLElement ? root.offsetHeight : 0
  host.remove()
  return width > 0 && height > 0 ? { width, height } : null
}

function svgFor(html: string, css: string, width: number, height: number): string {
  const boxWidth = width + PAD * 2
  const boxHeight = height + PAD * 2
  // 样式只作用于 SVG 自己的文档；katex-display 的外边距在这里归零，间距交给图片尺寸
  const style = `<style>.katex-display{margin:0}${css}</style>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${boxWidth * SCALE}" height="${boxHeight * SCALE}" ` +
    `viewBox="0 0 ${boxWidth} ${boxHeight}">` +
    `<foreignObject width="${boxWidth}" height="${boxHeight}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="padding:${PAD}px">${style}${html}</div>` +
    `</foreignObject></svg>`
  )
}

async function drawPng(svg: string, width: number, height: number): Promise<Uint8Array | null> {
  const image = new Image()
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = width * SCALE
  canvas.height = height * SCALE
  const context = canvas.getContext('2d')
  if (context === null) return null
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (blob === null) return null
  return new Uint8Array(await blob.arrayBuffer())
}

/** 渲染失败与无 DOM 环境（单测）都返回 null，调用方退回公式源码文本 */
export async function rasterizeMath(source: string, displayMode: boolean): Promise<MathImage | null> {
  if (typeof document === 'undefined') return null
  const key = `${displayMode ? 'D' : 'I'}\n${source}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  let result: MathImage | null = null
  try {
    const { katexExportCss } = await import('./katex-css')
    const html = katex.renderToString(source, { displayMode, throwOnError: false, output: 'html' })
    const size = measuredSize(html)
    if (size !== null) {
      const svg = svgFor(html, katexExportCss(), size.width, size.height)
      const bytes = await drawPng(svg, size.width + PAD * 2, size.height + PAD * 2)
      if (bytes !== null) result = { bytes, width: size.width }
    }
  } catch {
    result = null
  }

  cache.set(key, result)
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return result
}
