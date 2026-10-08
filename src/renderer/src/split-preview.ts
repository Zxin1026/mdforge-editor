import { DEFAULT_EXPORT_OPTIONS, type ExportTheme } from '../../shared/ipc'
import { assetUrlForPath, resolveLocalPath } from './editor/assets'
import { currentTheme, type EditorTheme } from './editor/theme-runtime'
import { buildHtml, deriveTitle } from './export/html'
import { bindSplitResizer } from './panes'

export interface SplitPreviewOptions {
  /** 拖动分隔条：给出新的右栏占比（0–1），final 表示松手，可以落盘 */
  onRatio?(ratio: number, final: boolean): void
}

export interface SplitPreview {
  element: HTMLElement
  setVisible(on: boolean): void
  setTheme(theme: ExportTheme): void
  theme(): ExportTheme
  /** 正文改了：防抖后重绘 */
  schedule(text: string, docPath: string | null): void
  /** 立即重绘（进入分屏、切换标签、改主题时） */
  update(text: string, docPath: string | null): void
  destroy(): void
}

const IMG_ATTR = /(<img\b[^>]*?\bsrc\s*=\s*")([^"]*)(")/gi

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

/**
 * 预览里的相对图片换成本地可读的 mdasset 地址：
 * iframe 用 srcdoc 装载，没有文档目录，相对路径一概取不到图。
 */
export function rewritePreviewImages(html: string, docPath: string | null): string {
  if (docPath === null) return html
  return html.replace(IMG_ATTR, (all, pre: string, src: string, post: string) => {
    const local = resolveLocalPath(docPath, decodeAttr(src))
    if (local === null) return all
    return pre + encodeAttr(assetUrlForPath(local)) + post
  })
}

/** 应用深浅色 → 导出主题：浅色用 mdmdt（与编辑器同族观感），深色用 dark */
export function themeForApp(appTheme: EditorTheme): ExportTheme {
  return appTheme === 'dark' ? 'dark' : 'mdmdt'
}

export function createSplitPreview(host: HTMLElement, options: SplitPreviewOptions = {}): SplitPreview {
  const element = document.createElement('div')
  element.className = 'split-preview'
  element.dataset.role = 'split-preview'
  element.hidden = true

  const frame = document.createElement('iframe')
  frame.className = 'split-preview-frame'
  frame.setAttribute('title', '渲染预览')
  element.appendChild(frame)

  // 左缘的分隔条：拖动改写左右占比，双击回到一半
  const resizer = document.createElement('div')
  resizer.className = 'split-resizer'
  resizer.dataset.resizer = 'split'
  resizer.title = '拖动调整左右宽度（双击恢复一半）'
  element.appendChild(resizer)
  bindSplitResizer(resizer, host, {
    onRatio: (ratio, final) => options.onRatio?.(ratio, final)
  })

  host.appendChild(element)

  let theme: ExportTheme = themeForApp(currentTheme())
  let timer: number | undefined
  let seq = 0

  async function render(text: string, docPath: string | null): Promise<void> {
    const current = ++seq
    try {
      const html = await buildHtml(text, deriveTitle(text, '预览'), { ...DEFAULT_EXPORT_OPTIONS, theme })
      if (current !== seq) return
      frame.srcdoc = rewritePreviewImages(html, docPath)
    } catch {
      if (current !== seq) return
      frame.srcdoc =
        '<!doctype html><meta charset="utf-8"><body style="margin:0;padding:16px;font:13px \'Microsoft YaHei\',sans-serif;color:#888">预览渲染失败，正文仍可正常编辑。</body>'
    }
  }

  return {
    element,
    setVisible(on) {
      element.hidden = !on
    },
    setTheme(next) {
      theme = next
    },
    theme: () => theme,
    schedule(text, docPath) {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = undefined
        void render(text, docPath)
      }, 260)
    },
    update(text, docPath) {
      if (timer !== undefined) {
        window.clearTimeout(timer)
        timer = undefined
      }
      void render(text, docPath)
    },
    destroy() {
      if (timer !== undefined) window.clearTimeout(timer)
      element.remove()
    }
  }
}
