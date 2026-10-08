import type { FileResult, WorkspaceSearchInput, WorkspaceSearchResult } from '../../../shared/ipc'

export interface ReplaceRequest {
  query: string
  replacement: string
  caseSensitive: boolean
  regex: boolean
  result: WorkspaceSearchResult
}

/** 搜索页依赖：检索/替换/打开命中都交给工作区，组件只管界面状态 */
export interface SearchViewDeps {
  folderRoot(): string | null
  openFolder(): void
  folderName(): string
  search(input: WorkspaceSearchInput): Promise<FileResult<WorkspaceSearchResult>>
  /** 弹确认框、排除脏文件、写盘并重载标签；返回是否真的执行了替换 */
  replaceAll(request: ReplaceRequest): Promise<boolean>
  /** line<=0 表示只打开文档不定位；length 为命中片段长度，用于选中 */
  openHit(path: string, line: number, col: number, length: number): void
}

export interface SearchView {
  mount(host: HTMLElement): void
  focusInput(): void
  /** 文件夹换了或关了：结果不再可信 */
  onFolderChanged(): void
}

export function createSearchView(deps: SearchViewDeps): SearchView {
  let host: HTMLElement | null = null
  let caseSensitive = false
  let regex = false
  let running = false
  let note = ''
  let noteError = false
  let result: WorkspaceSearchResult | null = null
  let lastQuery = ''
  /** 路径过滤串（逗号分隔的 glob，! 为排除），随输入即时生效 */
  let pathFilter = ''

  // 与文件树同理：渲染只动自己的容器，避免把面板里别的页抹掉
  let box: HTMLElement | null = null

  let queryInput: HTMLInputElement | null = null
  let replaceInput: HTMLInputElement | null = null
  let filterInput: HTMLInputElement | null = null

  function render(): void {
    if (box === null) return
    box.replaceChildren(panel())
  }

  function panel(): HTMLElement {
    const box = document.createElement('div')
    box.className = 'search-panel'

    const head = document.createElement('div')
    head.className = 'search-head'
    queryInput = document.createElement('input')
    queryInput.type = 'text'
    queryInput.className = 'search-input'
    queryInput.placeholder = deps.folderRoot() === null ? '先打开文件夹' : `在「${deps.folderName()}」中搜索`
    queryInput.spellcheck = false
    queryInput.value = lastQuery
    queryInput.disabled = deps.folderRoot() === null
    queryInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        void run()
      }
    })
    const caseBtn = optionButton('Aa', '区分大小写', caseSensitive, () => {
      caseSensitive = !caseSensitive
      render()
    })
    const regexBtn = optionButton('.*', '使用正则表达式', regex, () => {
      regex = !regex
      render()
    })
    head.append(queryInput, caseBtn, regexBtn)

    const replaceRow = document.createElement('div')
    replaceRow.className = 'search-head'
    replaceInput = document.createElement('input')
    replaceInput.type = 'text'
    replaceInput.className = 'search-input'
    replaceInput.placeholder = '替换为…'
    replaceInput.spellcheck = false
    replaceInput.disabled = deps.folderRoot() === null
    replaceInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        void runReplace()
      }
    })
    const runBtn = document.createElement('button')
    runBtn.type = 'button'
    runBtn.className = 'search-go'
    runBtn.textContent = running ? '…' : '查找'
    runBtn.disabled = running || deps.folderRoot() === null
    runBtn.dataset.action = 'search-run'
    runBtn.addEventListener('click', () => void run())
    const replaceBtn = document.createElement('button')
    replaceBtn.type = 'button'
    replaceBtn.className = 'search-go'
    replaceBtn.textContent = '全部替换'
    replaceBtn.disabled = running || result === null || result.totalMatches === 0
    replaceBtn.dataset.action = 'search-replace-all'
    replaceBtn.addEventListener('click', () => void runReplace())
    replaceRow.append(replaceInput, runBtn, replaceBtn)

    // 文件类型过滤：只扫匹配的文件，! 前缀排除；空串=不过滤
    const filterRow = document.createElement('div')
    filterRow.className = 'search-head'
    filterInput = document.createElement('input')
    filterInput.type = 'text'
    filterInput.className = 'search-input'
    filterInput.placeholder = '过滤：*.md, !draft/**'
    filterInput.title = '按路径过滤文件：逗号分隔的 glob，* 单层、** 跨目录，! 前缀表示排除'
    filterInput.spellcheck = false
    filterInput.value = pathFilter
    filterInput.disabled = deps.folderRoot() === null
    filterInput.addEventListener('input', () => {
      pathFilter = filterInput?.value ?? ''
    })
    filterInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        void run()
      }
    })
    filterRow.append(filterInput)

    box.append(head, replaceRow, filterRow)

    if (deps.folderRoot() === null) {
      const empty = document.createElement('div')
      empty.className = 'search-empty'
      const text = document.createElement('div')
      text.className = 'files-empty-text'
      text.textContent = '打开一个文件夹后，可以在这里搜索全部文档'
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'files-open'
      button.textContent = '打开文件夹…'
      button.addEventListener('click', () => deps.openFolder())
      empty.append(text, button)
      box.appendChild(empty)
      return box
    }

    if (note !== '') {
      const line = document.createElement('div')
      line.className = `search-note${noteError ? ' is-error' : ''}`
      line.dataset.note = 'search'
      line.textContent = note
      box.appendChild(line)
    }

    if (result !== null) box.appendChild(resultsBox(result))
    return box
  }

  function optionButton(label: string, title: string, on: boolean, run: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `search-opt${on ? ' is-on' : ''}`
    button.textContent = label
    button.title = title
    button.dataset.opt = label === 'Aa' ? 'case' : 'regex'
    button.addEventListener('click', run)
    return button
  }

  function resultsBox(data: WorkspaceSearchResult): HTMLElement {
    const box = document.createElement('div')
    box.className = 'search-results'

    const named = data.files.filter((file) => file.nameMatch)
    if (named.length > 0) {
      const group = document.createElement('div')
      group.className = 'search-group'
      const head = document.createElement('div')
      head.className = 'search-group-head'
      head.textContent = `文件名匹配 ${named.length}`
      group.appendChild(head)
      for (const file of named) {
        const row = document.createElement('button')
        row.type = 'button'
        row.className = 'search-name-hit'
        row.textContent = file.name
        row.title = file.path
        row.addEventListener('click', () => deps.openHit(file.path, 0, 0, 0))
        group.appendChild(row)
      }
      box.appendChild(group)
    }

    const withMatches = data.files.filter((file) => file.matches.length > 0)
    for (const file of withMatches) {
      const group = document.createElement('div')
      group.className = 'search-file'
      group.dataset.filePath = file.path
      const head = document.createElement('button')
      head.type = 'button'
      head.className = 'search-file-head'
      const name = document.createElement('span')
      name.className = 'search-file-name'
      name.textContent = file.name
      const count = document.createElement('span')
      count.className = 'search-file-count'
      count.textContent = `${file.matches.length}${file.truncated ? '+' : ''}`
      head.append(name, count)
      head.title = file.path
      head.addEventListener('click', () => deps.openHit(file.path, 0, 0, 0))
      group.appendChild(head)

      for (const match of file.matches) {
        const row = document.createElement('button')
        row.type = 'button'
        row.className = 'search-hit'
        row.dataset.line = String(match.line)
        row.dataset.col = String(match.col)
        const lineTag = document.createElement('span')
        lineTag.className = 'search-hit-line'
        lineTag.textContent = String(match.line)
        const text = document.createElement('span')
        text.className = 'search-hit-text'
        text.textContent = match.text
        if (match.length > 0) {
          // 把命中片段包进 <mark>：先占位再按原始下标切分，避免重排文本
          const start = Math.max(0, match.col - 1)
          const end = start + match.length
          text.textContent = ''
          const before = document.createElement('span')
          before.textContent = match.text.slice(0, start)
          const mark = document.createElement('mark')
          mark.textContent = match.text.slice(start, end)
          const after = document.createElement('span')
          after.textContent = match.text.slice(end)
          text.append(before, mark, after)
        }
        row.append(lineTag, text)
        row.title = `${file.path} · 第 ${match.line} 行`
        row.addEventListener('click', () => deps.openHit(file.path, match.line, match.col, match.length))
        group.appendChild(row)
      }
      box.appendChild(group)
    }
    return box
  }

  function currentQuery(): string {
    return (queryInput?.value ?? lastQuery).trim()
  }

  function currentReplacement(): string {
    return replaceInput?.value ?? ''
  }

  function summaryOf(data: WorkspaceSearchResult): { text: string; error: boolean } {
    if (data.files.length === 0) return { text: '没有找到匹配', error: false }
    const parts = [`${data.files.length} 个文件`, `${data.totalMatches} 处命中`]
    if (data.truncated) parts.push('结果过多，只显示了一部分')
    parts.push(`扫描 ${data.scanned} 个文件`)
    return { text: parts.join(' · '), error: false }
  }

  async function run(): Promise<void> {
    const dir = deps.folderRoot()
    if (dir === null || running) return
    const query = currentQuery()
    if (query === '') {
      result = null
      note = '请输入要查找的内容'
      noteError = true
      render()
      return
    }
    lastQuery = query
    running = true
    note = '正在搜索…'
    noteError = false
    render()
    const response = await deps.search({ dir, query, caseSensitive, regex, filter: pathFilter })
    running = false
    if (response.ok) {
      result = response.value
      const summary = summaryOf(response.value)
      note = summary.text
      noteError = summary.error
    } else {
      result = null
      note = response.error.message
      noteError = true
    }
    render()
    if (response.ok) queryInput?.focus()
  }

  async function runReplace(): Promise<void> {
    const dir = deps.folderRoot()
    if (dir === null || result === null || running) return
    const query = currentQuery()
    if (query === '') return
    const performed = await deps.replaceAll({
      query,
      replacement: currentReplacement(),
      caseSensitive,
      regex,
      result
    })
    if (!performed) return
    // 重新搜一遍：结果列表要反映替换后的磁盘内容
    await run()
  }

  return {
    mount(hostEl) {
      host = hostEl
      if (box === null) {
        box = document.createElement('div')
        box.className = 'search-panel-host'
      }
      host.replaceChildren(box)
      render()
    },
    focusInput() {
      queryInput?.focus()
      queryInput?.select()
    },
    onFolderChanged() {
      result = null
      note = ''
      noteError = false
      render()
    }
  }
}
