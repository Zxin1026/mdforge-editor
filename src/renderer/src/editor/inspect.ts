import type { EditorState } from '@codemirror/state'
import type { ResourceState } from '../../../shared/ipc'
import { dirOf } from './assets'
import { collectLinks } from './links'
import { collectOutline, type OutlineItem } from './outline'

export type IssueKind = 'missing-image' | 'broken-link' | 'heading-jump' | 'unused-asset'

export interface Issue {
  kind: IssueKind
  /** 引用所在行；未引用的资源不在正文里，行号为 0 */
  line: number
  /** 行内列号，与手册要求的"文件 + 行 + 列"定位口径一致 */
  col: number
  pos: number
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
  probe(refs: string[]): Promise<{ states: ResourceState[]; assets: AssetEntry[] }>
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
  'unused-asset': '未引用资源'
}

const KIND_ORDER: IssueKind[] = ['missing-image', 'broken-link', 'heading-jump', 'unused-asset']

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

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/**
 * 文档检查：缺图、坏链、标题跳级、未引用资源。
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
  const issues: Issue[] = headingJumps(outline)
  const pending: { absolute: string; kind: IssueKind; label: string; line: number; col: number; pos: number }[] = []
  const referenced = new Set<string>()
  let external = 0

  for (const occurrence of occurrences) {
    const target = occurrence.target
    const row = state.doc.lineAt(occurrence.from)
    const line = row.number
    const col = occurrence.from - row.from + 1
    const pos = occurrence.from
    const label = `${target.kind === 'image' ? '图片' : '链接'} ${shorten(target.raw)}`

    if (target.kind === 'external') {
      external += 1
      continue
    }
    if (target.kind === 'anchor') {
      if (!anchors.has(target.url)) {
        issues.push({ kind: 'broken-link', line, col, pos, label, detail: `文内没有名为 #${target.url} 的标题锚点` })
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
    pending.push({
      absolute: target.localPath,
      kind: target.kind === 'image' ? 'missing-image' : 'broken-link',
      label,
      line,
      col,
      pos
    })
  }

  const probe = await source.probe(pending.map((item) => item.absolute))
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
    if (probe.assets.length > 0) note += `，扫描了 ${probe.assets.length} 个 assets/ 文件`
  }

  issues.sort((a, b) => {
    const byKind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    if (byKind !== 0) return byKind
    return a.line - b.line
  })
  return { issues, external, checked: pending.length, note }
}
