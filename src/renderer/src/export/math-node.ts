import { fromHtmlIsomorphic } from 'hast-util-from-html-isomorphic'
import katex from 'katex'
import type { HastNode, HastRoot } from './hast'

/**
 * 公式的导出侧渲染：remark-math 只负责把 `$…$` / `$$…$$` 解析成数学节点，
 * 这里用编辑期同一份 katex 把节点换成渲染结果（sanitize 之后执行，
 * katex 生成的内联样式不再过滤；sanitize 阶段为数学节点保留了 math-* 类名）。
 */

function classNames(node: HastNode): string[] {
  const value = node.properties?.className
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function katexChildren(source: string, displayMode: boolean): HastNode[] | null {
  try {
    // 与编辑期 MathBlockWidget / MathInlineWidget 同一组参数，渲染结果一致
    const html = katex.renderToString(source, { displayMode, throwOnError: false, output: 'html' })
    return fromHtmlIsomorphic(html, { fragment: true }).children as HastNode[]
  } catch {
    return null
  }
}

function sourceOf(node: HastNode): string {
  return (node.children ?? [])
    .map((child) => (child.type === 'text' ? (child.value ?? '') : ''))
    .join('')
}

/** 行内公式 → span.mdf-math-inline；行间公式 → div.mdf-math-block；渲染失败保留原样 */
function replacementFor(node: HastNode, display: boolean): HastNode | null {
  const rendered = katexChildren(sourceOf(node), display)
  if (rendered === null) return null
  return display
    ? { type: 'element', tagName: 'div', properties: { className: ['mdf-math-block'] }, children: rendered }
    : { type: 'element', tagName: 'span', properties: { className: ['mdf-math-inline'] }, children: rendered }
}

function walk(children: HastNode[]): void {
  for (let index = 0; index < children.length; index += 1) {
    let node = children[index]
    if (node.type !== 'element') continue

    // 行间公式是 pre > code.math-display：整块换掉，免得留下空的 pre 外壳
    if (node.tagName === 'pre' && node.children?.length === 1) {
      const inner = node.children[0]
      if (inner.type === 'element' && classNames(inner).includes('math-display')) {
        const replacement = replacementFor(inner, true)
        if (replacement !== null) {
          children[index] = replacement
          continue
        }
      }
    }

    const classes = classNames(node)
    if (node.tagName === 'code' && (classes.includes('math-display') || classes.includes('math-inline'))) {
      const replacement = replacementFor(node, classes.includes('math-display'))
      if (replacement !== null) {
        children[index] = replacement
        continue
      }
    }

    if (node.children) walk(node.children)
  }
}

export function rehypeKatex() {
  return (input: unknown): void => {
    walk((input as HastRoot).children)
  }
}
