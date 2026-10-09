import { fromHtmlIsomorphic } from 'hast-util-from-html-isomorphic'
import { renderMermaidWithTheme } from '../editor/mermaid'
import type { EditorTheme } from '../editor/theme-runtime'
import type { HastNode, HastRoot } from './hast'

/**
 * 图表的导出侧渲染：把 ```mermaid 代码块换成渲染好的 SVG 内联进页面。
 * 配色复用编辑期的那两套 themeVariables（深浅跟随导出主题），
 * 渲染失败时保留原始代码块——和编辑期"渲染失败显示错误"不同，导出宁可留住源码。
 */

export interface MermaidPluginOptions {
  theme: EditorTheme
}

async function svgChildren(code: string, theme: EditorTheme): Promise<HastNode[] | null> {
  // 无 DOM（单测等非浏览器环境）时 mermaid 画不了图，直接留源码，也省下大包的加载
  if (typeof document === 'undefined') return null
  try {
    const svg = await renderMermaidWithTheme(code, theme)
    return fromHtmlIsomorphic(svg, { fragment: true }).children as HastNode[]
  } catch {
    return null
  }
}

/** 逐个渲染，避免多张图同时改 mermaid 的全局配置 */
async function walk(children: HastNode[], theme: EditorTheme): Promise<void> {
  for (let index = 0; index < children.length; index += 1) {
    const node = children[index]
    if (node.type !== 'element') continue

    if (node.tagName === 'pre' && node.children?.length === 1) {
      const inner = node.children[0]
      const classes = inner.type === 'element' ? classNamesOf(inner) : []
      if (inner.type === 'element' && inner.tagName === 'code' && classes.includes('language-mermaid')) {
        const source = (inner.children ?? [])
          .map((child) => (child.type === 'text' ? (child.value ?? '') : ''))
          .join('')
        const rendered = await svgChildren(source, theme)
        if (rendered !== null) {
          children[index] = {
            type: 'element',
            tagName: 'div',
            properties: { className: ['mdf-mermaid'] },
            children: rendered
          }
          continue
        }
      }
    }

    if (node.children) await walk(node.children, theme)
  }
}

function classNamesOf(node: HastNode): string[] {
  const value = node.properties?.className
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

export function rehypeMermaid(options: MermaidPluginOptions) {
  return async (input: unknown): Promise<void> => {
    await walk((input as HastRoot).children, options.theme)
  }
}
