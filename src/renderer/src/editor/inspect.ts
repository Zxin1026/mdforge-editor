import type { EditorState } from '@codemirror/state'
import { scanFences, type FenceScan } from '../../../shared/fences'
import type { AnchorState, ResourceState } from '../../../shared/ipc'
import { slugOnce } from '../../../shared/slug'
import { dirOf } from './assets'
import { frontMatterOf } from './frontmatter'
import { collectLinks } from './links'
import { collectOutline, type OutlineItem } from './outline'

export type IssueKind =
  | 'missing-image'
  | 'broken-link'
  | 'heading-jump'
  | 'unused-asset'
  | 'duplicate-heading'
  | 'empty-image-alt'
  | 'todo-placeholder'
  | 'unclosed-fence'
  | 'invalid-frontmatter'
  | 'long-line'

export interface Issue {
  kind: IssueKind
  /** 引用所在行；未引用的资源不在正文里，行号为 0 */
  line: number
  /** 行内列号，与手册要求的"文件 + 行 + 列"定位口径一致 */
  col: number
  pos: number
  /** 命中片段结束位置；编辑器内联标记用它画下划线，缺省只标行 */
  end?: number
  label: string
  detail: string
  /** 未引用资源的绝对路径，给“在文件夹中显示”用 */
  path?: string
}

export interface AssetEntry {
  relative: string
  absolute: string
  size: number
}

/** 磁盘访问由调用方注入：检查逻辑本身不碰 fs，方便单测 */
export interface InspectSource {
  probe(
    refs: string[],
    /** 跨文档锚点：目标文档读不出来时对应状态为 unknown（无法判定，不当问题报） */
    anchors?: ReadonlyArray<{ path: string; anchor: string }>
  ): Promise<{ states: ResourceState[]; assets: AssetEntry[]; anchorStates?: readonly AnchorState[] }>
}

/** 链接目标里 # 之后的锚点：%E6%96%87 这类编码还原成文本 */
function decodeAnchor(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export interface InspectReport {
  issues: Issue[]
  /** 联网与否：外部链接只计数，不发请求 */
  external: number
  /** 实际查过存在性的本地引用数 */
  checked: number
  note: string
}

export const ISSUE_TITLES: Record<IssueKind, string> = {
  'missing-image': '缺图',
  'broken-link': '坏链',
  'heading-jump': '标题跳级',
  'unused-asset': '未引用资源',
  'duplicate-heading': '重复标题',
  'empty-image-alt': '空图片描述',
  'todo-placeholder': '待办占位符',
  'unclosed-fence': '未闭合代码块',
  'invalid-frontmatter': 'Front Matter 问题',
  'long-line': '超长行'
}

/** 编辑器内联标记的严重度：错引用/语法问题算 error，风格类算 warning */
export const ISSUE_SEVERITY: Record<IssueKind, 'error' | 'warning'> = {
  'missing-image': 'error',
  'broken-link': 'error',
  'unclosed-fence': 'error',
  'invalid-frontmatter': 'error',
  'heading-jump': 'warning',
  'unused-asset': 'warning',
  'duplicate-heading': 'warning',
  'empty-image-alt': 'warning',
  'todo-placeholder': 'warning',
  'long-line': 'warning'
}

/** 面板与内联标记共用的排序口径：先按类别，再按行号 */
export const KIND_ORDER: IssueKind[] = [
  'missing-image',
  'broken-link',
  'unclosed-fence',
  'invalid-frontmatter',
  'duplicate-heading',
  'empty-image-alt',
  'todo-placeholder',
  'heading-jump',
  'long-line',
  'unused-asset'
]

/** 超过这个长度的行会被点名（代码块内跳过） */
const LONG_LINE_LIMIT = 200
const MAX_LONG_LINE_ISSUES = 50

function toPosix(value: string): string {
  return value.replace(/\\/g, '/')
}

function shorten(value: string, limit = 46): string {
  const one = value.replace(/\s+/g, ' ').trim()
  return one.length > limit ? `${one.slice(0, limit)}…` : one
}

/** 标题层级只能一级一级往下走：H2 直接跳到 H4 读起来会断层级 */
export function headingJumps(items: readonly OutlineItem[]): Issue[] {
  const issues: Issue[] = []
  let previous = 0
  items.forEach((item, index) => {
    if (index > 0 && item.level - previous > 1) {
      issues.push({
        kind: 'heading-jump',
        line: item.line,
        col: 1,
        pos: item.pos,
        label: `第 ${item.line} 行 · ${shorten(item.text === '' ? '（无标题）' : item.text, 30)}`,
        detail: `上一节是 H${previous}，这里是 H${item.level}，中间空了 ${item.level - previous - 1} 级`
      })
    }
    previous = item.level
  })
  return issues
}

function stateDetail(state: ResourceState): string {
  if (state === 'missing') return '文件不存在'
  if (state === 'directory') return '指向的是目录，不是文件'
  if (state === 'outside') return '路径不是完整位置'
  return '超出授权范围，本应用无法确认它是否存在'
}

/** 重复标题：同名标题会生成 #name-1 这类锚点，链接指向容易串位 */
export function duplicateHeadings(items: readonly OutlineItem[]): Issue[] {
  const firstSeen = new Map<string, number>()
  const issues: Issue[] = []
  for (const item of items) {
    if (item.text === '') continue
    const base = slugOnce(item.text)
    const previous = firstSeen.get(base)
    if (previous === undefined) {
      firstSeen.set(base, item.line)
      continue
    }
    issues.push({
      kind: 'duplicate-heading',
      line: item.line,
      col: 1,
      pos: item.pos,
      label: `第 ${item.line} 行 · ${shorten(item.text, 30)}`,
      detail: `与第 ${previous} 行的标题重复，锚点会变成 #${base}-1 之类的形式`
    })
  }
  return issues
}

/** 到文末都没闭合的围栏代码块 */
function fenceIssues(state: EditorState, fences: FenceScan): Issue[] {
  if (fences.unclosed === null) return []
  const line = state.doc.line(Math.min(fences.unclosed.line, state.doc.lines))
  return [
    {
      kind: 'unclosed-fence',
      line: line.number,
      col: 1,
      pos: line.from,
      end: line.to,
      label: `第 ${line.number} 行 · 代码块`,
      detail: `这个代码块没有闭合（缺少 ${fences.unclosed.marker} 收尾），后面的内容都会被当成代码`
    }
  ]
}

const META_OPEN = /^---[ \t]*$/

/**
 * front matter 结构检查：只做形态判断（没闭合、不是 键: 值、字段重复），
 * 不引入 YAML 解析器——有缩进的续行、注释和列表项都按合法处理。
 */
export function frontMatterIssues(state: EditorState): Issue[] {
  const first = state.doc.line(1)
  if (!META_OPEN.test(first.text)) return []
  const span = frontMatterOf(state.doc)
  if (span === null) {
    return [
      {
        kind: 'invalid-frontmatter',
        line: 1,
        col: 1,
        pos: first.from,
        end: first.to,
        label: 'front matter 没有结束标记',
        detail: '开头的 --- 之后一直没等到配对的 --- 或 ...，整块会被当成普通正文'
      }
    ]
  }

  const issues: Issue[] = []
  const keys = new Map<string, number>()
  for (const from of span.lines.slice(1, -1)) {
    const line = state.doc.lineAt(from)
    const trimmed = line.text.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    // 带缩进的行、列表项都算前面字段的续行
    if (/^\s/.test(line.text) || trimmed.startsWith('- ')) continue
    const colon = line.text.indexOf(':')
    const key = colon > 0 ? line.text.slice(0, colon).trim().toLowerCase() : ''
    if (key === '') {
      issues.push({
        kind: 'invalid-frontmatter',
        line: line.number,
        col: 1,
        pos: line.from,
        end: line.to,
        label: `第 ${line.number} 行`,
        detail: `“${shorten(trimmed, 20)}” 不是 键: 值 形式`
      })
      continue
    }
    const seen = keys.get(key)
    if (seen === undefined) keys.set(key, line.number)
    else {
      issues.push({
        kind: 'invalid-frontmatter',
        line: line.number,
        col: 1,
        pos: line.from,
        end: line.to,
        label: `第 ${line.number} 行`,
        detail: `字段 ${key} 与第 ${seen} 行重复，后者会覆盖前者`
      })
    }
  }
  return issues
}

/** 超长行：超过 LONG_LINE_LIMIT 字符的正文行，代码块里跳过 */
export function longLineIssues(state: EditorState, fences: FenceScan): Issue[] {
  const issues: Issue[] = []
  for (let number = 1; number <= state.doc.lines; number += 1) {
    if (fences.fenced.has(number)) continue
    const line = state.doc.line(number)
    if (line.length <= LONG_LINE_LIMIT) continue
    issues.push({
      kind: 'long-line',
      line: number,
      col: 1,
      pos: line.from,
      label: `第 ${number} 行`,
      detail: `这一行有 ${line.length} 个字符（超过 ${LONG_LINE_LIMIT}），换行分段会更好读`
    })
    if (issues.length >= MAX_LONG_LINE_ISSUES) break
  }
  return issues
}

/** 占位符：写完文档前最容易忘的记号，大小写敏感（小写 todo 多在正常行文里） */
const TODO_MARK = /\bTODO\b|\bFIXME\b|待补充/
const MAX_TODO_ISSUES = 50

/** 待办占位符扫描：TODO / FIXME / 待补充，每行最多点一次名 */
export function todoMarkerIssues(state: EditorState): Issue[] {
  const issues: Issue[] = []
  for (let number = 1; number <= state.doc.lines; number += 1) {
    const line = state.doc.line(number)
    const match = TODO_MARK.exec(line.text)
    if (match === null) continue
    issues.push({
      kind: 'todo-placeholder',
      line: number,
      col: match.index + 1,
      pos: line.from + match.index,
      end: line.from + match.index + match[0].length,
      label: `第 ${number} 行 · ${match[0]}`,
      detail: '这一处还留着占位符，发布前记得处理'
    })
    if (issues.length >= MAX_TODO_ISSUES) break
  }
  return issues
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/**
 * 文档检查：缺图、坏链、标题跳级、未引用资源、重复标题、空图片描述、
 * 待办占位符、未闭合代码块、front matter 异常、超长行，另核对跨文档锚点。
 * 存在性判断走主进程的授权模型，外部链接不联网所以只报数量。
 */
export async function inspectDocument(
  state: EditorState,
  docPath: string,
  source: InspectSource
): Promise<InspectReport> {
  const occurrences = collectLinks(state, docPath)
  const outline = collectOutline(state)
  const anchors = new Set(outline.map((item) => item.anchor))
  const fences = scanFences(state.doc.toString())
  const issues: Issue[] = [
    ...headingJumps(outline),
    ...duplicateHeadings(outline),
    ...fenceIssues(state, fences),
    ...frontMatterIssues(state),
    ...todoMarkerIssues(state),
    ...longLineIssues(state, fences)
  ]
  const pending: { absolute: string; kind: IssueKind; label: string; line: number; col: number; pos: number }[] = []
  /** 指向文档的链接如果带 #锚点：引用本文件按内存大纲核对，其余交给主进程 */
  const pendingAnchors: Array<{
    absolute: string
    anchor: string
    sameDoc: boolean
    line: number
    col: number
    pos: number
    label: string
  }> = []
  const referenced = new Set<string>()
  let external = 0

  for (const occurrence of occurrences) {
    const target = occurrence.target
    const row = state.doc.lineAt(occurrence.from)
    const line = row.number
    const col = occurrence.from - row.from + 1
    const pos = occurrence.from
    const label = `${target.kind === 'image' ? '图片' : '链接'} ${shorten(target.raw)}`

    if (target.kind === 'image') {
      const alt = /^!\[([^\]]*)\]/.exec(state.sliceDoc(occurrence.from, occurrence.to))?.[1]
      if (alt !== undefined && alt.trim() === '') {
        issues.push({
          kind: 'empty-image-alt',
          line,
          col,
          pos,
          end: occurrence.to,
          label,
          detail: '图片没有替代文字（方括号里是空的），补一句描述方便搜索和无障碍阅读'
        })
      }
    }

    if (target.kind === 'external') {
      external += 1
      continue
    }
    if (target.kind === 'anchor') {
      const anchor = decodeAnchor(target.url)
      if (!anchors.has(anchor)) {
        issues.push({ kind: 'broken-link', line, col, pos, label, detail: `文内没有名为 #${anchor} 的标题锚点` })
      }
      continue
    }
    if (target.localPath === null) {
      if (target.kind !== 'other') {
        issues.push({
          kind: target.kind === 'image' ? 'missing-image' : 'broken-link',
          line,
          col,
          pos,
          label,
          detail: docPath === '' ? '文档还没保存，相对路径无法解析' : '无法解析成本地路径'
        })
      }
      continue
    }

    referenced.add(toPosix(target.localPath).toLowerCase())

    if (target.kind === 'relative-md') {
      const hashIndex = target.raw.indexOf('#')
      const anchor = hashIndex >= 0 ? decodeAnchor(target.raw.slice(hashIndex + 1)) : ''
      if (anchor !== '') {
        pendingAnchors.push({
          absolute: target.localPath,
          anchor,
          // 指向自己：按内存里的大纲核对，磁盘上的版本可能已经过时
          sameDoc: docPath !== '' && toPosix(target.localPath).toLowerCase() === toPosix(docPath).toLowerCase(),
          line,
          col,
          pos,
          label
        })
      }
    }
    pending.push({
      absolute: target.localPath,
      kind: target.kind === 'image' ? 'missing-image' : 'broken-link',
      label,
      line,
      col,
      pos
    })
  }

  const remoteAnchors = pendingAnchors.filter((item) => !item.sameDoc)
  const probe = await source.probe(
    pending.map((item) => item.absolute),
    remoteAnchors.map((item) => ({ path: item.absolute, anchor: item.anchor }))
  )
  pending.forEach((item, order) => {
    const status = probe.states[order]
    if (status === 'ok') return
    issues.push({
      kind: item.kind,
      line: item.line,
      col: item.col,
      pos: item.pos,
      label: item.label,
      detail: stateDetail(status ?? 'unknown')
    })
  })

  // 跨文档锚点：文件读不出来（unknown）不算问题，确认没有这个标题才报
  const anchorStates = probe.anchorStates ?? []
  let anchorOrder = 0
  for (const item of pendingAnchors) {
    if (item.sameDoc) {
      if (!anchors.has(item.anchor)) {
        issues.push({
          kind: 'broken-link',
          line: item.line,
          col: item.col,
          pos: item.pos,
          label: item.label,
          detail: `文内没有名为 #${item.anchor} 的标题锚点`
        })
      }
      continue
    }
    const status = anchorStates[anchorOrder]
    anchorOrder += 1
    if (status !== 'missing') continue
    issues.push({
      kind: 'broken-link',
      line: item.line,
      col: item.col,
      pos: item.pos,
      label: item.label,
      detail: `目标文档里没有名为 #${item.anchor} 的标题锚点`
    })
  }

  let note = `检查了 ${pending.length} 个本地引用，${external} 个外部链接未联网核对`
  if (docPath !== '') {
    const dir = toPosix(dirOf(docPath)).replace(/\/+$/, '')
    const unused = probe.assets.filter((asset) => !referenced.has(`${dir}/${asset.relative}`.toLowerCase()))
    for (const asset of unused) {
      issues.push({
        kind: 'unused-asset',
        line: 0,
        col: 0,
        pos: 0,
        label: shorten(asset.relative, 40),
        detail: `正文里没有引用（${formatSize(asset.size)}）`,
        path: asset.absolute
      })
    }
    if (probe.assets.length > 0) note += `，扫描了 ${probe.assets.length} 个资源文件`
  }

  issues.sort((a, b) => {
    const byKind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    if (byKind !== 0) return byKind
    return a.line - b.line
  })
  return { issues, external, checked: pending.length, note }
}
