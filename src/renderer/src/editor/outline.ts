import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import { createSlugger, headingTitle } from '../../../shared/slug'
import { frontMatterOf } from './frontmatter'

const HEADING = /^(?:ATXHeading|SetextHeading)([1-6])$/

export interface OutlineItem {
  level: number
  text: string
  /** 标题所在行的行首位置 */
  pos: number
  line: number
  anchor: string
}

export interface OutlineGuides {
  /** 第 1..level-1 级祖先的竖线是否向下延续（该级后面还有条目） */
  spans: boolean[]
  /** 自己是同级的最后一个（折角画成 └ 而不是 ├） */
  last: boolean
}

/** 同级的后续条目是否存在（跨父级不算）：往后扫，遇到更浅的层级说明自己这一支结束了 */
function hasLaterSibling(items: readonly OutlineItem[], index: number, level: number): boolean {
  for (let j = index + 1; j < items.length; j++) {
    if (items[j].level < level) return false
    if (items[j].level === level) return true
  }
  return false
}

/**
 * 树形缩进线：为每个标题算出「哪几级要画竖线、自己的折角是不是收尾」。
 * 第 l 级的竖线能画，前提是存在第 l 级的祖先，且它在本支内还有同级标题（线要连到下一个条目）。
 */
export function outlineGuides(items: readonly OutlineItem[]): OutlineGuides[] {
  return items.map((item, index) => {
    const spans: boolean[] = []
    for (let level = 1; level < item.level; level++) {
      const hasAncestor = items.some((other, i) => i < index && other.level === level)
      spans.push(hasAncestor && hasLaterSibling(items, index, level))
    }
    return { spans, last: !hasLaterSibling(items, index, item.level) }
  })
}

export function collectOutline(state: EditorState): OutlineItem[] {
  const items: OutlineItem[] = []
  const slugger = createSlugger()
  const tree = syntaxTree(state)
  if (tree.length === 0) return items

  // front matter 的收尾 `---` 会被当成 setext 下划线，YAML 首行因此变成标题，大纲要跳过整块
  const matter = frontMatterOf(state.doc)

  tree.iterate({
    enter(node) {
      const match = HEADING.exec(node.type.name)
      if (!match) return
      const line = state.doc.lineAt(node.from)
      if (matter !== null && line.from <= matter.to) return
      const text = headingTitle(state.sliceDoc(line.from, line.to))
      items.push({
        level: Number(match[1]),
        text,
        pos: line.from,
        line: line.number,
        anchor: slugger.slug(text)
      })
    }
  })

  return items
}

/** 光标所在标题块对应的大纲项：取行号不超过光标的最后一项 */
export function activeIndex(items: readonly OutlineItem[], line: number): number {
  let index = -1
  for (let i = 0; i < items.length; i++) {
    if (items[i].line <= line) index = i
    else break
  }
  return index
}
