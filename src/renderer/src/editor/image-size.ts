import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { titleWithWidth } from './assets'

export interface ImageTarget {
  /** 链接目标原文，可能带尖括号或编码 */
  url: string
  urlFrom: number
  urlTo: number
  /** title 内容（不含引号）；没有 title 时为 null */
  title: string | null
  titleFrom: number | null
  titleTo: number | null
}

/** 在 Image 节点里定位链接目标与可选的 title */
export function imageTargetOf(state: EditorState, from: number, to: number): ImageTarget | null {
  let url: string | null = null
  let urlFrom = -1
  let urlTo = -1
  let title: string | null = null
  let titleFrom = -1
  let titleTo = -1

  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (node.type.name === 'URL') {
        url = state.sliceDoc(node.from, node.to)
        urlFrom = node.from
        urlTo = node.to
      } else if (node.type.name === 'LinkTitle') {
        title = state.sliceDoc(node.from + 1, node.to - 1)
        titleFrom = node.from
        titleTo = node.to
      }
      return undefined
    }
  })

  if (url === null || urlFrom < 0) return null
  return {
    url,
    urlFrom,
    urlTo,
    title,
    titleFrom: titleFrom < 0 ? null : titleFrom,
    titleTo: titleTo < 0 ? null : titleTo
  }
}

/**
 * 把宽度写回源文本的 title 槽。位置每次重新解析，
 * 因为拖拽期间文档可能被其它操作改动，缓存的下标会写错位置。
 */
export function writeImageWidth(view: EditorView, from: number, to: number, width: number): boolean {
  const target = imageTargetOf(view.state, from, to)
  if (!target) return false

  const change =
    target.titleFrom !== null && target.titleTo !== null
      ? { from: target.titleFrom, to: target.titleTo, insert: titleWithWidth(target.title, width) }
      : { from: target.urlTo, to: target.urlTo, insert: ` ${titleWithWidth(null, width)}` }

  view.dispatch({ changes: change, userEvent: 'input', scrollIntoView: false })
  return true
}
