/**
 * 资源改名后的引用改写（渲染进程侧）：主进程负责磁盘，这里负责把
 * "有未保存修改"的文档在内存缓冲里改成同样的引用，保存时自然写对。
 */

import { dirOfPath, relativeBetween } from './paths'

export interface RefMove {
  from: string
  to: string
}

export interface RefEdit {
  from: number
  to: number
  insert: string
}

/** 相对路径计算在 paths.ts；这里转出给测试与调用方沿用 */
export { relativeBetween }

/**
 * 引用可能写成 `assets/a.png`、`./assets/a.png`，或对空格与中文做过百分号编码的形态；
 * 对同一个位置不做重复替换，避免 `./x` 被替换后又撞上二次匹配。
 */
export function refSpellings(docDir: string, move: RefMove): Array<[string, string]> {
  const fromRel = relativeBetween(docDir, move.from)
  const toRel = relativeBetween(docDir, move.to)
  if (fromRel === null || toRel === null || fromRel === '') return []
  const pairs: Array<[string, string]> = [[fromRel, toRel]]
  const encodedFrom = encodeURI(fromRel)
  const encodedTo = encodeURI(toRel)
  if (encodedFrom !== fromRel) pairs.push([encodedFrom, encodedTo])
  const all: Array<[string, string]> = []
  for (const [a, b] of pairs) all.push([a, b], [`./${a}`, `./${b}`])
  return all
}

/**
 * 正文里所有指向旧路径的字面引用 → 一次性可 dispatch 的改动列表。
 * 位置按原文坐标给出、互不重叠。
 */
export function refRewriteEdits(text: string, docPath: string, moves: readonly RefMove[]): RefEdit[] {
  const docDir = dirOfPath(docPath)
  const found: RefEdit[] = []
  for (const move of moves) {
    for (const [oldSpelling, newSpelling] of refSpellings(docDir, move)) {
      if (oldSpelling === newSpelling || oldSpelling === '') continue
      let index = text.indexOf(oldSpelling)
      while (index >= 0) {
        found.push({ from: index, to: index + oldSpelling.length, insert: newSpelling })
        index = text.indexOf(oldSpelling, index + oldSpelling.length)
      }
    }
  }
  found.sort((a, b) => a.from - b.from || b.to - a.to)
  const out: RefEdit[] = []
  let last = -1
  for (const edit of found) {
    if (edit.from < last) continue
    out.push(edit)
    last = edit.to
  }
  return out
}
