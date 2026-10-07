import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import { assetUrl, resolveLocalPath, stripTitle } from './assets'

export type LinkKind = 'anchor' | 'external' | 'relative-md' | 'relative-file' | 'image' | 'other'

export interface LinkTarget {
  kind: LinkKind
  /** 链接/图片的目标原文 */
  raw: string
  /** 外部链接的完整 URL，或锚点 id */
  url: string
  /** 相对路径解析后的本地绝对路径（可打开/预览时有值） */
  localPath: string | null
  /** 图片预览用的 asset 协议地址 */
  previewSrc: string | null
  /** 是否可 Ctrl+点击 */
  openable: boolean
}

const LINK_TYPES = new Set(['Link', 'Image', 'AutoLink', 'URL'])
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const MD_EXT = /\.(md|markdown|mdown|mkd|txt)$/i

function findLinkNode(state: EditorState, pos: number) {
  const tree = syntaxTree(state)
  if (tree.length === 0) return null
  let node = tree.resolveInner(Math.min(pos, state.doc.length), -1)
  while (node) {
    if (LINK_TYPES.has(node.type.name)) return { node, kind: node.type.name }
    node = node.parent!
  }
  return null
}

function destinationOf(state: EditorState, from: number, to: number): string | null {
  let raw: string | null = null
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (node.type.name === 'URL') {
        raw = state.sliceDoc(node.from, node.to)
        return false
      }
      return undefined
    }
  })
  return raw
}

function classify(kind: string, raw: string, docPath: string): LinkTarget {
  const trimmed = stripTitle(raw.trim())
  const clean = trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed

  if (kind === 'Image') {
    const local = resolveLocalPath(docPath, clean)
    return {
      kind: 'image',
      raw: clean,
      url: clean,
      localPath: local,
      previewSrc: assetUrl(docPath, clean),
      openable: false
    }
  }

  const hashIdx = clean.indexOf('#')
  const filePath = hashIdx >= 0 ? clean.slice(0, hashIdx) : clean

  if (hashIdx === 0)
    return { kind: 'anchor', raw: clean, url: clean.slice(1), localPath: null, previewSrc: null, openable: true }

  if (SCHEME.test(filePath)) {
    const external = /^(https?:|mailto:|tel:)/i.test(filePath)
    return {
      kind: external ? 'external' : 'other',
      raw: clean,
      url: filePath,
      localPath: null,
      previewSrc: null,
      openable: external
    }
  }

  const local = resolveLocalPath(docPath, filePath)
  const isMd = MD_EXT.test(filePath)
  return {
    kind: isMd ? 'relative-md' : 'relative-file',
    raw: clean,
    url: filePath,
    localPath: local,
    previewSrc: null,
    openable: isMd
  }
}

/** 光标/点击位置处的链接目标。方括号、圆括号、URL 本身命中都算。 */
export function linkAt(state: EditorState, pos: number, docPath: string): LinkTarget | null {
  const found = findLinkNode(state, pos)
  if (!found) return null
  const { node, kind } = found
  const raw = destinationOf(state, node.from, node.to)
  // 自动链接 / 裸 URL 的整段文本就是地址
  const value = raw ?? (kind === 'AutoLink' || kind === 'URL' ? state.sliceDoc(node.from, node.to) : null)
  if (value === null || value.trim() === '') return null
  return classify(kind, value, docPath)
}

export interface LinkOccurrence {
  target: LinkTarget
  /** 链接节点在文档中的范围，检查面板用它定位行号 */
  from: number
  to: number
}

/** 全文的链接与图片引用：文档检查的数据来源 */
export function collectLinks(state: EditorState, docPath: string): LinkOccurrence[] {
  const found: LinkOccurrence[] = []
  const tree = syntaxTree(state)
  if (tree.length === 0) return found

  tree.iterate({
    enter(node) {
      const kind = node.type.name
      if (!LINK_TYPES.has(kind)) return undefined
      const raw =
        kind === 'AutoLink' || kind === 'URL'
          ? state.sliceDoc(node.from, node.to)
          : destinationOf(state, node.from, node.to)
      if (raw === null || raw.trim() === '') return false
      found.push({ target: classify(kind, raw, docPath), from: node.from, to: node.to })
      // 图片里嵌的链接不单独再报一遍
      return false
    }
  })
  return found
}

export function hoverLabel(target: LinkTarget): string {
  switch (target.kind) {
    case 'external':
      return `${target.url}\nCtrl+点击：用系统浏览器打开`
    case 'relative-md':
      return `${target.localPath ?? target.url}\nCtrl+点击：在本应用打开`
    case 'relative-file':
      return target.localPath ?? target.url
    case 'anchor':
      return `跳转到文内锚点 #${target.url}`
    case 'image':
      return target.localPath ?? target.raw
    default:
      return target.raw
  }
}
