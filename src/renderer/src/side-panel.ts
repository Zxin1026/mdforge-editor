import { createAssetsView, type AssetsView, type AssetsViewDeps } from './side/assets-view'
import { createFilesView, type FilesViewDeps } from './side/files-view'
import { createSearchView, type SearchViewDeps } from './side/search-view'
import { aggregateTags, docsForTag, filterTags, type TagDoc } from './side/tags-logic'
import { ISSUE_TITLES, KIND_ORDER, type InspectReport, type Issue } from './editor/inspect'
import { activeIndex, outlineGuides, type OutlineItem } from './editor/outline'

export type SideMode = 'files' | 'outline' | 'search' | 'links' | 'tags' | 'assets' | 'issues'

/** 反向链接页的数据：当前文档 + 指向它的其他文档 */
export interface LinksView {
  dir: string | null
  docPath: string | null
  docName: string
  loading: boolean
  error: string | null
  /** 索引里一共有多少个文档、多少条链接 */
  totalDocs: number
  totalLinks: number
  backlinks: Array<{ path: string; name: string; line: number; text: string }>
}

/** 标签页的数据：文件夹里有标签的文档（计数与筛选在面板侧做） */
export interface TagsView {
  dir: string | null
  loading: boolean
  error: string | null
  docs: TagDoc[]
  /** 索引里一共扫描到多少个文档 */
  totalDocs: number
}

export interface SidePanel {
  mode(): SideMode
  /** 没有标签的模式（文档检查）从视图菜单切进来 */
  setMode(mode: SideMode): void
  /** 当前激活标签对应的文件：列表里给高亮，并展开到它 */
  setActiveFile(path: string | null): void
  renderOutline(items: readonly OutlineItem[], line: number): void
  /** 检查结果还没回来：列表位置显示"正在检查…" */
  showRunning(): void
  showReport(report: InspectReport): void
  /** 正文改过了，之前的结果不能再当成现状 */
  markStale(): void
  /** 打开/关闭文件夹：文件树与搜索页共用 */
  setFolderRoot(dir: string | null): void
  /** 重新读文件树（文件操作、外部改动后） */
  reloadFiles(): Promise<void>
  /** 收藏变化：重画星标 */
  syncFavorites(): void
  /** 反向链接页 */
  renderLinks(view: LinksView): void
  /** 标签页 */
  renderTags(view: TagsView): void
  /** 图片页：当前文档的缺图引用（定位用） */
  renderAssetIssues(issues: readonly Issue[]): void
  /** Ctrl+Shift+F：切到搜索页并聚焦输入框 */
  focusSearch(): void
}

interface Handlers {
  onPickOutline(pos: number): void
  onPickIssue(issue: Issue): void
  onRunCheck(): void
  onModeChange(mode: SideMode): void
  onPickFile(path: string): void
  onOpenFolder(): void
  files: Omit<FilesViewDeps, 'openFile' | 'openFolder'>
  search: SearchViewDeps
  assets: AssetsViewDeps
  onPickBacklink(path: string, line: number): void
  onRefreshLinks(): void
  onOpenGraph(): void
  /** 标签页：点开某个文档 */
  onPickTagDoc(path: string): void
  onRefreshTags(): void
}

/** 右侧面板：文件树、大纲、工作区搜索与反向链接共用一个栏位 */
export function createSidePanel(mount: HTMLElement, handlers: Handlers): SidePanel {
  let mode: SideMode = 'outline'
  let lastReport: InspectReport | null = null
  let lastLinks: LinksView | null = null
  let lastTags: TagsView | null = null
  /** 标签页的本地状态：选中的标签与过滤词 */
  let activeTag: string | null = null
  let tagFilter = ''
  let stale = false

  const filesView = createFilesView({
    ...handlers.files,
    openFile: (path) => handlers.onPickFile(path),
    openFolder: () => handlers.onOpenFolder()
  })
  const searchView = createSearchView(handlers.search)
  const assetsView: AssetsView = createAssetsView(handlers.assets)

  const tabs = document.createElement('div')
  tabs.className = 'side-tabs'
  const body = document.createElement('div')
  body.className = 'side-panel-body'
  mount.replaceChildren(tabs, body)

  const filesTab = tab('files', '文件')
  const outlineTab = tab('outline', '大纲')
  const searchTab = tab('search', '搜索')
  const linksTab = tab('links', '链接')
  const tagsTab = tab('tags', '标签')
  const assetsTab = tab('assets', '图片')
  tabs.append(filesTab, outlineTab, searchTab, linksTab, tagsTab, assetsTab)

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
      mountBody()
      handlers.onModeChange(which)
    })
    return button
  }

  function syncTabs(): void {
    for (const [which, tabEl] of [
      ['files', filesTab],
      ['outline', outlineTab],
      ['search', searchTab],
      ['links', linksTab],
      ['tags', tagsTab],
      ['assets', assetsTab]
    ] as const) {
      tabEl.classList.toggle('is-active', mode === which)
    }
    mount.dataset.sideMode = mode
  }

  /** 切换标签时把对应的视图挂进 body；大纲与检查的结果由工作区随后推来 */
  function mountBody(): void {
    if (mode === 'files') filesView.mount(body)
    else if (mode === 'search') searchView.mount(body)
    else if (mode === 'links') renderLinksBody()
    else if (mode === 'tags') renderTagsBody(false)
    else if (mode === 'assets') assetsView.mount(body)
    else if (mode === 'issues') renderIssuesBody(lastReport, false)
  }

  function renderLinksBody(): void {
    body.replaceChildren()
    const view = lastLinks
    if (view === null) {
      const note = document.createElement('div')
      note.className = 'files-note'
      note.textContent = '正在读取链接…'
      body.appendChild(note)
      return
    }

    const head = document.createElement('div')
    head.className = 'issues-head'
    const summary = document.createElement('span')
    summary.className = 'links-summary'
    summary.textContent = view.dir === null ? '反向链接' : `反向链接 ${view.backlinks.length}`
    const refresh = document.createElement('button')
    refresh.type = 'button'
    refresh.className = 'issues-run'
    refresh.textContent = '刷新'
    refresh.dataset.action = 'links-refresh'
    refresh.disabled = view.loading || view.dir === null
    refresh.addEventListener('click', handlers.onRefreshLinks)
    const graph = document.createElement('button')
    graph.type = 'button'
    graph.className = 'issues-run'
    graph.textContent = '关系图'
    graph.title = '查看整个文件夹的文档链接关系图'
    graph.dataset.action = 'links-graph'
    graph.disabled = view.dir === null
    graph.addEventListener('click', handlers.onOpenGraph)
    head.append(summary, refresh, graph)
    body.appendChild(head)

    if (view.dir === null) {
      const note = document.createElement('div')
      note.className = 'files-note'
      note.textContent = '打开文件夹后，这里会显示谁链接到了当前文档'
      body.appendChild(note)
      return
    }
    if (view.loading) {
      const note = document.createElement('div')
      note.className = 'files-note'
      note.textContent = '正在扫描文件夹里的链接…'
      body.appendChild(note)
      return
    }
    if (view.error !== null) {
      const note = document.createElement('div')
      note.className = 'files-note'
      note.textContent = view.error
      body.appendChild(note)
      return
    }

    const counts = document.createElement('div')
    counts.className = 'links-note'
    counts.textContent = `索引了 ${view.totalDocs} 个文档、${view.totalLinks} 条链接`
    body.appendChild(counts)

    if (view.docPath === null) {
      const note = document.createElement('div')
      note.className = 'files-note'
      note.textContent = '当前文档还没有保存，先落盘才能被链接识别'
      body.appendChild(note)
      return
    }
    if (view.backlinks.length === 0) {
      const note = document.createElement('div')
      note.className = 'files-note'
      note.textContent = `还没有其他文档链接到「${view.docName}」`
      body.appendChild(note)
      return
    }

    const list = document.createElement('div')
    list.className = 'link-list'
    for (const link of view.backlinks) {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'link-item'
      item.dataset.linkFrom = link.path
      item.dataset.linkLine = String(link.line)
      const name = document.createElement('div')
      name.className = 'link-name'
      name.textContent = link.name
      const detail = document.createElement('div')
      detail.className = 'link-detail'
      detail.textContent = `第 ${link.line} 行 · ${link.text}`
      detail.title = `${link.path}\n第 ${link.line} 行`
      item.append(name, detail)
      item.addEventListener('click', () => handlers.onPickBacklink(link.path, link.line))
      list.appendChild(item)
    }
    body.replaceChildren(head, counts, list)
  }

  function renderTagsBody(keepFilterFocus: boolean): void {
    const view = lastTags
    const nodes: HTMLElement[] = []

    const head = document.createElement('div')
    head.className = 'issues-head'
    const summary = document.createElement('span')
    summary.className = 'tags-summary'
    summary.dataset.role = 'tags-summary'
    const aggregate = aggregateTags(view?.docs ?? [])
    summary.textContent = view === null || view.dir === null ? '标签' : `${aggregate.length} 个标签 · ${view.docs.length} 篇文档`
    const refresh = document.createElement('button')
    refresh.type = 'button'
    refresh.className = 'issues-run'
    refresh.textContent = '刷新'
    refresh.dataset.action = 'tags-refresh'
    refresh.disabled = view === null || view.loading || view.dir === null
    refresh.addEventListener('click', handlers.onRefreshTags)
    head.append(summary, refresh)
    nodes.push(head)

    if (view === null || view.dir === null) {
      nodes.push(note('打开文件夹后，这里会按 front matter 的 tags / keywords 汇总标签'))
      body.replaceChildren(...nodes)
      return
    }
    if (view.loading) {
      nodes.push(note('正在扫描文件夹里的标签…'))
      body.replaceChildren(...nodes)
      return
    }
    if (view.error !== null) {
      nodes.push(note(view.error, true))
      body.replaceChildren(...nodes)
      return
    }
    if (view.docs.length === 0) {
      nodes.push(note('文件夹里还没有带标签的文档：在 front matter 里写 tags: [笔记, 教程]，或在「文档信息」里填写标签'))
      nodes.push(note(`本次扫描了 ${view.totalDocs} 个文档`))
      body.replaceChildren(...nodes)
      return
    }

    const filter = document.createElement('input')
    filter.type = 'text'
    filter.className = 'search-input'
    filter.placeholder = '按标签名过滤'
    filter.dataset.role = 'tags-filter'
    filter.spellcheck = false
    filter.value = tagFilter
    filter.addEventListener('input', () => {
      tagFilter = filter.value
      renderTagsBody(true)
    })
    nodes.push(filter)

    const visible = filterTags(aggregate, tagFilter)
    if (visible.length === 0) {
      nodes.push(note(`没有匹配「${tagFilter.trim()}」的标签`))
    } else {
      const cloud = document.createElement('div')
      cloud.className = 'tags-cloud'
      for (const item of visible) {
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.className = `tag-item${activeTag !== null && activeTag.toLowerCase() === item.tag.toLowerCase() ? ' is-active' : ''}`
        chip.dataset.tag = item.tag
        chip.title = `筛选带「${item.tag}」标签的文档`
        const name = document.createElement('span')
        name.className = 'tag-name'
        name.textContent = item.tag
        const count = document.createElement('span')
        count.className = 'tag-count'
        count.textContent = String(item.count)
        chip.append(name, count)
        chip.addEventListener('click', () => {
          const same = activeTag !== null && activeTag.toLowerCase() === item.tag.toLowerCase()
          activeTag = same ? null : item.tag
          renderTagsBody(false)
        })
        cloud.appendChild(chip)
      }
      nodes.push(cloud)
    }

    if (activeTag !== null) {
      const docs = docsForTag(view.docs, activeTag)
      const groupHead = document.createElement('div')
      groupHead.className = 'issue-group-head'
      groupHead.textContent = `「${activeTag}」的文档 ${docs.length}`
      groupHead.dataset.role = 'tags-doc-head'
      nodes.push(groupHead)
      const list = document.createElement('div')
      list.className = 'link-list'
      for (const doc of docs) {
        const item = document.createElement('button')
        item.type = 'button'
        item.className = 'link-item'
        item.dataset.tagDocPath = doc.path
        const name = document.createElement('div')
        name.className = 'link-name'
        name.textContent = doc.name
        const detail = document.createElement('div')
        detail.className = 'link-detail'
        detail.textContent = doc.tags.map((tag) => `#${tag}`).join(' ')
        detail.title = doc.path
        item.append(name, detail)
        item.addEventListener('click', () => handlers.onPickTagDoc(doc.path))
        list.appendChild(item)
      }
      nodes.push(list)
    } else {
      nodes.push(note('点一个标签，查看带它的文档'))
    }

    body.replaceChildren(...nodes)
    if (keepFilterFocus) {
      const again = body.querySelector<HTMLInputElement>('[data-role="tags-filter"]')
      again?.focus()
      again?.setSelectionRange(again.value.length, again.value.length)
    }
  }

  function note(text: string, isError = false): HTMLElement {
    const line = document.createElement('div')
    line.className = `files-note${isError ? ' is-error' : ''}`
    line.textContent = text
    return line
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
      ok.textContent = '没发现问题：引用都在、标题层级正常、front matter 与代码块也完整。'
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
        mountBody()
      }
      handlers.onModeChange(next)
    },
    setActiveFile(path) {
      filesView.setActive(path)
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
    },
    setFolderRoot(dir) {
      filesView.setRoot(dir)
      searchView.onFolderChanged()
      assetsView.setMissing([])
      if (mode === 'assets') assetsView.refresh()
    },
    reloadFiles() {
      return filesView.reload()
    },
    syncFavorites() {
      filesView.syncFavorites()
    },
    renderLinks(view) {
      lastLinks = view
      if (mode === 'links') renderLinksBody()
    },
    renderTags(view) {
      lastTags = view
      if (mode === 'tags') renderTagsBody(false)
    },
    renderAssetIssues(issues) {
      assetsView.setMissing(issues)
    },
    focusSearch() {
      if (mode !== 'search') {
        mode = 'search'
        syncTabs()
        mountBody()
        handlers.onModeChange('search')
      }
      searchView.focusInput()
    }
  }
}
