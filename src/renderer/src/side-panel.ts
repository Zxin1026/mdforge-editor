import type { FolderEntry } from '../../shared/ipc'
import { ISSUE_TITLES, type InspectReport, type Issue } from './editor/inspect'
import { activeIndex, outlineGuides, type OutlineItem } from './editor/outline'

export type SideMode = 'files' | 'outline' | 'issues'

/** 文件页的整帧状态：工作区推给面板渲染 */
export interface FilesView {
  dir: string | null
  entries: FolderEntry[]
  loading: boolean
  error: string | null
}

export interface SidePanel {
  mode(): SideMode
  /** 没有标签的模式（文档检查）从视图菜单切进来 */
  setMode(mode: SideMode): void
  renderFiles(view: FilesView): void
  /** 当前激活标签对应的文件：列表里给高亮 */
  setActiveFile(path: string | null): void
  renderOutline(items: readonly OutlineItem[], line: number): void
  /** 检查结果还没回来：列表位置显示"正在检查…" */
  showRunning(): void
  showReport(report: InspectReport): void
  /** 正文改过了，之前的结果不能再当成现状 */
  markStale(): void
}

interface Handlers {
  onPickOutline(pos: number): void
  onPickIssue(issue: Issue): void
  onRunCheck(): void
  onModeChange(mode: SideMode): void
  onPickFile(path: string): void
  onOpenFolder(): void
}

const KIND_ORDER = ['missing-image', 'broken-link', 'heading-jump', 'unused-asset'] as const

/** 右侧面板：文件列表、大纲与文档检查共用一个栏位，避免再占一列宽度 */
export function createSidePanel(mount: HTMLElement, handlers: Handlers): SidePanel {
  let mode: SideMode = 'outline'
  let lastReport: InspectReport | null = null
  let stale = false
  let activeFile: string | null = null

  const tabs = document.createElement('div')
  tabs.className = 'side-tabs'
  const body = document.createElement('div')
  body.className = 'side-panel-body'
  mount.replaceChildren(tabs, body)

  const filesTab = tab('files', '文件')
  const outlineTab = tab('outline', '大纲')
  tabs.append(filesTab, outlineTab)

  function tab(which: SideMode, label: string): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'side-tab'
    button.dataset.sideTab = which
    button.textContent = label
    button.addEventListener('click', () => {
      if (mode === which) return
      mode = which
      syncTabs()
      handlers.onModeChange(which)
    })
    return button
  }

  function syncTabs(): void {
    filesTab.classList.toggle('is-active', mode === 'files')
    outlineTab.classList.toggle('is-active', mode === 'outline')
    mount.dataset.sideMode = mode
  }

  function samePath(a: string, b: string): boolean {
    return a.toLowerCase() === b.toLowerCase()
  }

  function renderFilesBody(view: FilesView): void {
    if (view.loading) {
      body.innerHTML = '<div class="files-note">正在读取文件夹…</div>'
      return
    }
    if (view.error !== null) {
      const note = document.createElement('div')
      note.className = 'files-note'
      note.textContent = view.error
      body.replaceChildren(note)
      return
    }
    if (view.dir === null) {
      const empty = document.createElement('div')
      empty.className = 'files-empty'
      const text = document.createElement('div')
      text.className = 'files-empty-text'
      text.textContent = '还没有打开文件夹'
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'files-open'
      button.textContent = '打开文件夹…'
      button.addEventListener('click', handlers.onOpenFolder)
      empty.append(text, button)
      body.replaceChildren(empty)
      return
    }
    if (view.entries.length === 0) {
      const note = document.createElement('div')
      note.className = 'files-note'
      note.textContent = '这个文件夹里没有 Markdown 文件'
      body.replaceChildren(note)
      return
    }
    const list = document.createElement('div')
    list.className = 'file-list'
    for (const entry of view.entries) {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'file-item'
      item.dataset.filePath = entry.path
      if (activeFile !== null && samePath(entry.path, activeFile)) item.classList.add('is-active')
      const name = document.createElement('div')
      name.className = 'file-name'
      const stem = entry.name.replace(/\.[^.]+$/, '')
      const stemSpan = document.createElement('span')
      stemSpan.className = 'file-stem'
      stemSpan.textContent = stem
      const extSpan = document.createElement('span')
      extSpan.className = 'file-ext'
      extSpan.textContent = entry.name.slice(stem.length)
      name.append(stemSpan, extSpan)
      const preview = document.createElement('div')
      preview.className = 'file-preview'
      preview.textContent = entry.preview
      item.append(name, preview)
      item.title = entry.path
      item.addEventListener('click', () => handlers.onPickFile(entry.path))
      list.appendChild(item)
    }
    body.replaceChildren(list)
  }

  function renderOutlineBody(items: readonly OutlineItem[], line: number): void {
    if (items.length === 0) {
      body.innerHTML = '<div class="outline-empty">没有标题</div>'
      return
    }
    const list = document.createElement('nav')
    list.className = 'outline-list'
    const active = activeIndex(items, line)
    const guides = outlineGuides(items)
    list.replaceChildren(
      ...items.map((item, index) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = `outline-item level-${item.level}${index === active ? ' is-active' : ''}`
        for (const draw of guides[index].spans) {
          const rail = document.createElement('span')
          rail.className = `outline-rail${draw ? ' is-line' : ''}`
          button.appendChild(rail)
        }
        if (item.level > 1) {
          const elbow = document.createElement('span')
          elbow.className = `outline-elbow${guides[index].last ? ' is-last' : ''}`
          button.appendChild(elbow)
        }
        const label = document.createElement('span')
        label.className = 'outline-label'
        label.textContent = item.text === '' ? '（无标题）' : item.text
        button.appendChild(label)
        button.title = `#${item.anchor}`
        button.addEventListener('click', () => handlers.onPickOutline(item.pos))
        return button
      })
    )
    body.replaceChildren(list)
  }

  function renderIssuesBody(report: InspectReport | null, running: boolean): void {
    const head = document.createElement('div')
    head.className = 'issues-head'
    const summary = document.createElement('span')
    summary.className = 'issues-summary'
    summary.textContent = running ? '正在检查…' : report === null ? '还没检查' : `${report.issues.length} 个问题`
    const run = document.createElement('button')
    run.type = 'button'
    run.className = 'issues-run'
    run.textContent = '重新检查'
    run.disabled = running
    run.addEventListener('click', handlers.onRunCheck)
    head.append(summary, run)

    const note = document.createElement('div')
    note.className = 'issues-note'
    note.textContent = running ? '' : `${report?.note ?? ''}${stale ? '（正文已改动，建议重新检查）' : ''}`

    if (!running && report !== null && report.issues.length === 0) {
      const ok = document.createElement('div')
      ok.className = 'issues-clean'
      ok.textContent = '没发现问题：本地引用都在，标题层级也没跳。'
      body.replaceChildren(head, note, ok)
      return
    }

    const groups: HTMLElement[] = []
    if (report !== null) {
      for (const kind of KIND_ORDER) {
        const items = report.issues.filter((issue) => issue.kind === kind)
        if (items.length === 0) continue
        const group = document.createElement('div')
        group.className = 'issue-group'
        const groupHead = document.createElement('div')
        groupHead.className = 'issue-group-head'
        groupHead.textContent = `${ISSUE_TITLES[kind]} ${items.length}`
        const list = document.createElement('div')
        list.className = 'issue-list'
        for (const issue of items) {
          const button = document.createElement('button')
          button.type = 'button'
          button.className = 'issue-item'
          button.dataset.issueKind = kind
          button.dataset.issueLine = String(issue.line)
          const label = document.createElement('div')
          label.className = 'issue-label'
          label.textContent = issue.label
          label.title = issue.label
          const detail = document.createElement('div')
          detail.className = 'issue-detail'
          detail.textContent = issue.line > 0 ? `第 ${issue.line} 行 ${issue.col} 列 · ${issue.detail}` : issue.detail
          button.append(label, detail)
          button.addEventListener('click', () => handlers.onPickIssue(issue))
          list.appendChild(button)
        }
        group.append(groupHead, list)
        groups.push(group)
      }
    }

    body.replaceChildren(head, note, ...groups)
  }

  syncTabs()

  return {
    mode: () => mode,
    setMode(next) {
      if (mode !== next) {
        mode = next
        syncTabs()
      }
      handlers.onModeChange(next)
    },
    renderFiles(view) {
      if (mode === 'files') renderFilesBody(view)
    },
    setActiveFile(path) {
      activeFile = path
      if (mode !== 'files') return
      for (const item of body.querySelectorAll<HTMLElement>('.file-item')) {
        const target = item.dataset.filePath ?? ''
        item.classList.toggle('is-active', path !== null && samePath(target, path))
      }
    },
    renderOutline(items, line) {
      if (mode === 'outline') renderOutlineBody(items, line)
    },
    showRunning() {
      if (mode !== 'issues') return
      stale = false
      renderIssuesBody(null, true)
    },
    showReport(report) {
      lastReport = report
      stale = false
      if (mode === 'issues') renderIssuesBody(report, false)
      syncTabs()
    },
    markStale() {
      if (mode !== 'issues' || stale || lastReport === null) return
      stale = true
      renderIssuesBody(lastReport, false)
    }
  }
}
