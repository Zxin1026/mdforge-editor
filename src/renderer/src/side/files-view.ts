import type { FolderEntry } from '../../../shared/ipc'
import { openContextMenu } from '../context-menu'
import type { MenuEntry, MenuHandle } from '../menu'

/** 文件夹树：懒加载子目录，展开状态与已读数据都留在本组件里 */
export interface FilesViewDeps {
  listDir(dir: string): Promise<{ entries: FolderEntry[] } | { error: string }>
  openFile(path: string): void
  openFolder(): void
  /** 文件操作由工作区执行（要同步标签路径），返回是否成功 */
  rename(target: string, name: string): Promise<boolean>
  createFolder(dir: string, name: string): Promise<boolean>
  move(target: string, destDir: string): Promise<boolean>
  favorites(): readonly string[]
  toggleFavorite(path: string): void
  reveal(path: string): void
}

export interface FilesView {
  mount(host: HTMLElement): void
  setRoot(dir: string | null): void
  reload(): Promise<void>
  /** 收藏列表变了：只重画收藏区 */
  syncFavorites(): void
  setActive(path: string | null): void
}

function keyOf(path: string): string {
  return path.toLowerCase()
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function parentOf(path: string): string {
  const index = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return index > 0 ? path.slice(0, index) : path
}

export function createFilesView(deps: FilesViewDeps): FilesView {
  let host: HTMLElement | null = null
  let root: string | null = null
  let loading = false
  let error: string | null = null
  let activeFile: string | null = null

  // 自己的容器：面板切到别的页时 host 会把我们换下去，之后重渲染只动自己的容器，
  // 不能再去 replaceChildren(host) 把邻页的内容抹掉
  const box = document.createElement('div')
  box.className = 'files-panel'

  /** 目录键 -> 子级；展开过且读到过就有值 */
  const cache = new Map<string, FolderEntry[]>()
  const expanded = new Set<string>()
  const loadingDirs = new Set<string>()
  /** 正在就地编辑的条目：{ dir, mode } —— dir 为新条目挂载的目录 */
  let editing: { dir: string; mode: 'rename' | 'new'; target: string } | null = null
  let menu: MenuHandle | null = null

  function panel(): HTMLElement {
    return box
  }

  function ensureLoaded(dir: string): Promise<void> {
    const key = keyOf(dir)
    if (cache.has(key) || loadingDirs.has(key)) return Promise.resolve()
    loadingDirs.add(key)
    return deps
      .listDir(dir)
      .then((result) => {
        if ('entries' in result) cache.set(key, result.entries)
        else if (keyOf(dir) === keyOf(root ?? '')) error = result.error
      })
      .finally(() => {
        loadingDirs.delete(key)
      })
  }

  async function reload(): Promise<void> {
    if (root === null) {
      render()
      return
    }
    const dirs = [root, ...expanded]
    cache.clear()
    loading = true
    render()
    await Promise.all(dirs.map((dir) => ensureLoaded(dir)))
    loading = false
    render()
  }

  // ---- 渲染 ----

  function render(): void {
    if (host === null) return
    const body = panel()
    const scroll = host.scrollTop
    body.replaceChildren()

    if (root === null) {
      body.appendChild(emptyState())
      host.scrollTop = scroll
      return
    }

    body.appendChild(toolbar())

    const favs = deps
      .favorites()
      .filter((path) => keyOf(path).startsWith(keyOf(root!) + sep()) || keyOf(path) === keyOf(root!))
    if (favs.length > 0) body.appendChild(favoritesBlock(favs))

    if (loading && !cache.has(keyOf(root))) {
      body.appendChild(note('正在读取文件夹…'))
      host.scrollTop = scroll
      return
    }
    if (error !== null) {
      body.appendChild(note(error))
      host.scrollTop = scroll
      return
    }

    const entries = cache.get(keyOf(root)) ?? []
    if (entries.length === 0 && editing === null) {
      const blank = note('这个文件夹里还没有 Markdown 文件')
      body.appendChild(blank)
    }
    body.appendChild(treeBlock(root, 0, entries))
    host.scrollTop = scroll
  }

  function sep(): string {
    return root !== null && root.includes('/') ? '/' : '\\'
  }

  function emptyState(): HTMLElement {
    const empty = document.createElement('div')
    empty.className = 'files-empty'
    const text = document.createElement('div')
    text.className = 'files-empty-text'
    text.textContent = '还没有打开文件夹'
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'files-open'
    button.textContent = '打开文件夹…'
    button.addEventListener('click', () => deps.openFolder())
    empty.append(text, button)
    return empty
  }

  function note(message: string): HTMLElement {
    const el = document.createElement('div')
    el.className = 'files-note'
    el.textContent = message
    return el
  }

  function toolbar(): HTMLElement {
    const head = document.createElement('div')
    head.className = 'files-head'
    const name = document.createElement('div')
    name.className = 'files-root-name'
    name.textContent = root === null ? '' : baseName(root)
    name.title = root ?? ''
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'files-tool'
    add.textContent = '＋'
    add.title = '新建文件夹'
    add.dataset.tool = 'new-folder'
    add.addEventListener('click', () => {
      if (root === null) return
      editing = { dir: root, mode: 'new', target: '' }
      if (!expanded.has(keyOf(root))) expanded.add(keyOf(root))
      render()
    })
    const refresh = document.createElement('button')
    refresh.type = 'button'
    refresh.className = 'files-tool'
    refresh.textContent = '⟳'
    refresh.title = '刷新'
    refresh.dataset.tool = 'refresh'
    refresh.addEventListener('click', () => void reload())
    head.append(name, add, refresh)

    // 根行同时是"拖到最外层"的落点
    head.classList.add('is-drop-root')
    bindDropTarget(head, () => root)
    return head
  }

  function favoritesBlock(paths: readonly string[]): HTMLElement {
    const block = document.createElement('div')
    block.className = 'files-favs'
    const head = document.createElement('div')
    head.className = 'files-fav-head'
    head.textContent = '收藏'
    block.appendChild(head)
    for (const path of paths) {
      const row = document.createElement('div')
      row.className = 'files-fav'
      row.dataset.favPath = path
      const star = document.createElement('button')
      star.type = 'button'
      star.className = 'file-star is-on'
      star.textContent = '★'
      star.title = '取消收藏'
      star.addEventListener('click', (event) => {
        event.stopPropagation()
        deps.toggleFavorite(path)
      })
      const label = document.createElement('button')
      label.type = 'button'
      label.className = 'files-fav-name'
      label.textContent = baseName(path)
      label.title = path
      label.addEventListener('click', () => {
        void (async () => {
          const entry = await entryOf(path)
          if (entry === null || entry.kind === 'file') deps.openFile(path)
          else {
            const key = keyOf(path)
            if (expanded.has(key)) expanded.delete(key)
            else {
              expanded.add(key)
              await ensureLoaded(path)
            }
            render()
          }
        })()
      })
      row.append(star, label)
      block.appendChild(row)
    }
    return block
  }

  /** 收藏项可能是没展开到的文件：问一层父目录拿 kind 与预览 */
  async function entryOf(path: string): Promise<FolderEntry | null> {
    const parent = parentOf(path)
    const list = cache.get(keyOf(parent))
    const cached = list?.find((entry) => keyOf(entry.path) === keyOf(path))
    if (cached) return cached
    const result = await deps.listDir(parent)
    if ('error' in result) return null
    cache.set(keyOf(parent), result.entries)
    return result.entries.find((entry) => keyOf(entry.path) === keyOf(path)) ?? null
  }

  function treeBlock(dir: string, depth: number, entries: FolderEntry[]): HTMLElement {
    const box = document.createElement('div')
    box.className = depth === 0 ? 'file-list' : 'file-children'
    box.dataset.dir = dir

    if (editing !== null && editing.mode === 'new' && keyOf(editing.dir) === keyOf(dir)) {
      box.appendChild(nameInput(depth, editing.dir, ''))
    }

    for (const entry of entries) {
      box.appendChild(entryRow(entry, depth))
      if (entry.kind === 'dir') {
        const key = keyOf(entry.path)
        if (!expanded.has(key)) continue
        const children = cache.get(key)
        if (children === undefined) {
          const loadingRow = document.createElement('div')
          loadingRow.className = 'files-note is-child'
          loadingRow.style.paddingLeft = `${indentFor(depth + 1)}px`
          loadingRow.textContent = loadingDirs.has(key) ? '正在读取…' : '空文件夹'
          box.appendChild(loadingRow)
          if (!loadingDirs.has(key)) void ensureLoaded(entry.path).then(() => render())
          continue
        }
        if (children.length === 0 && !(editing !== null && editing.mode === 'new' && keyOf(editing.dir) === key)) {
          const blankRow = document.createElement('div')
          blankRow.className = 'files-note is-child'
          blankRow.style.paddingLeft = `${indentFor(depth + 1)}px`
          blankRow.textContent = '空文件夹'
          box.appendChild(blankRow)
          continue
        }
        box.appendChild(treeBlock(entry.path, depth + 1, children))
      }
    }
    return box
  }

  function indentFor(depth: number): number {
    return 6 + depth * 12
  }

  function entryRow(entry: FolderEntry, depth: number): HTMLElement {
    if (editing !== null && editing.mode === 'rename' && keyOf(editing.target) === keyOf(entry.path)) {
      return nameInput(depth, editing.dir, entry.name)
    }

    const row = document.createElement('div')
    row.className = 'file-item'
    row.dataset.filePath = entry.path
    row.dataset.kind = entry.kind
    if (entry.kind === 'dir') {
      row.classList.add('is-dir')
      if (expanded.has(keyOf(entry.path))) row.classList.add('is-expanded')
    }
    if (entry.kind === 'file' && activeFile !== null && keyOf(entry.path) === keyOf(activeFile))
      row.classList.add('is-active')
    row.style.paddingLeft = `${indentFor(depth)}px`
    row.title = entry.path
    row.draggable = true
    row.tabIndex = 0

    const chevron = document.createElement('span')
    chevron.className = 'file-chevron'
    chevron.textContent = entry.kind === 'dir' ? (expanded.has(keyOf(entry.path)) ? '▾' : '▸') : ''

    const name = document.createElement('div')
    name.className = 'file-name'
    if (entry.kind === 'dir') {
      const stem = document.createElement('span')
      stem.className = 'file-stem is-dir-name'
      stem.textContent = entry.name
      name.appendChild(stem)
    } else {
      const stem = entry.name.replace(/\.[^.]+$/, '')
      const stemSpan = document.createElement('span')
      stemSpan.className = 'file-stem'
      stemSpan.textContent = stem
      const extSpan = document.createElement('span')
      extSpan.className = 'file-ext'
      extSpan.textContent = entry.name.slice(stem.length)
      name.append(stemSpan, extSpan)
    }

    const star = document.createElement('button')
    star.type = 'button'
    const starred = deps.favorites().some((path) => keyOf(path) === keyOf(entry.path))
    star.className = `file-star${starred ? ' is-on' : ''}`
    star.textContent = starred ? '★' : '☆'
    star.title = starred ? '取消收藏' : '收藏'
    star.addEventListener('mousedown', (event) => event.stopPropagation())
    star.addEventListener('click', (event) => {
      event.stopPropagation()
      deps.toggleFavorite(entry.path)
    })

    const head = document.createElement('div')
    head.className = 'file-row-head'
    head.append(chevron, name, star)
    row.appendChild(head)

    if (entry.kind === 'file') {
      const preview = document.createElement('div')
      preview.className = 'file-preview'
      preview.textContent = entry.preview
      row.appendChild(preview)
    }

    row.addEventListener('click', () => {
      if (entry.kind === 'file') {
        deps.openFile(entry.path)
        return
      }
      const key = keyOf(entry.path)
      if (expanded.has(key)) expanded.delete(key)
      else {
        expanded.add(key)
        void ensureLoaded(entry.path).then(() => render())
      }
      render()
    })
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      event.stopPropagation()
      openRowMenu(event, entry)
    })
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      if (entry.kind === 'file') deps.openFile(entry.path)
    })

    if (entry.kind === 'dir') bindDropTarget(row, () => entry.path)
    bindDragSource(row, entry)
    return row
  }

  // ---- 就地改名 / 新建 ----

  function nameInput(depth: number, dir: string, initial: string): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'file-item is-editing'
    wrap.style.paddingLeft = `${indentFor(depth)}px`
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'file-rename-input'
    input.value = initial
    input.placeholder = '名称'
    input.spellcheck = false
    wrap.appendChild(input)

    let done = false
    const finish = (commit: boolean): void => {
      if (done) return
      done = true
      const value = input.value.trim()
      const mode = editing?.mode
      const target = editing?.target ?? ''
      editing = null
      if (!commit || value === '' || value === initial) {
        render()
        return
      }
      void (async () => {
        const ok = mode === 'new' ? await deps.createFolder(dir, value) : await deps.rename(target, value)
        if (ok) {
          if (mode === 'new') expanded.add(keyOf(dir))
          await reload()
        } else render()
      })()
    }

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        finish(true)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        finish(false)
      }
    })
    input.addEventListener('blur', () => finish(true))
    // 输入框出现后立刻聚焦并全选，重命名可以直接开打
    queueMicrotask(() => {
      input.focus()
      input.select()
    })
    return wrap
  }

  // ---- 右键菜单 ----

  function openRowMenu(event: MouseEvent, entry: FolderEntry): void {
    menu?.close()
    const starred = deps.favorites().some((path) => keyOf(path) === keyOf(entry.path))
    const entries: MenuEntry[] =
      entry.kind === 'dir'
        ? [
            {
              label: '新建文件夹',
              run: () => {
                editing = { dir: entry.path, mode: 'new', target: '' }
                expanded.add(keyOf(entry.path))
                void ensureLoaded(entry.path).then(() => render())
                render()
              }
            },
            {
              label: '重命名',
              run: () => {
                editing = { dir: parentOf(entry.path), mode: 'rename', target: entry.path }
                render()
              }
            },
            { divider: true, label: '' },
            {
              label: starred ? '取消收藏' : '收藏',
              run: () => deps.toggleFavorite(entry.path)
            },
            { label: '在文件夹中显示', run: () => deps.reveal(entry.path) }
          ]
        : [
            { label: '打开', run: () => deps.openFile(entry.path) },
            {
              label: '重命名',
              run: () => {
                editing = { dir: parentOf(entry.path), mode: 'rename', target: entry.path }
                render()
              }
            },
            { divider: true, label: '' },
            {
              label: starred ? '取消收藏' : '收藏',
              run: () => deps.toggleFavorite(entry.path)
            },
            { label: '在文件夹中显示', run: () => deps.reveal(entry.path) }
          ]
    menu = openContextMenu({ x: event.clientX, y: event.clientY }, entries, () => {
      menu = null
    })
  }

  // ---- 拖拽移动 ----

  let dragPath: string | null = null
  let dropRow: HTMLElement | null = null

  function bindDragSource(row: HTMLElement, entry: FolderEntry): void {
    row.addEventListener('dragstart', (event) => {
      dragPath = entry.path
      event.dataTransfer?.setData('text/plain', entry.path)
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
      row.classList.add('is-dragging')
    })
    row.addEventListener('dragend', () => {
      dragPath = null
      row.classList.remove('is-dragging')
      clearDropMark()
    })
  }

  function clearDropMark(): void {
    dropRow?.classList.remove('is-drop')
    dropRow = null
  }

  function bindDropTarget(row: HTMLElement, dirOf: () => string | null): void {
    row.addEventListener('dragover', (event) => {
      const dest = dirOf()
      if (dragPath === null || dest === null || keyOf(dest) === keyOf(dragPath)) return
      // 目标在拖动条目自己内部：不允许
      if (keyOf(dest).startsWith(keyOf(dragPath) + sep())) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
      if (dropRow !== row) {
        clearDropMark()
        dropRow = row
        row.classList.add('is-drop')
      }
    })
    row.addEventListener('dragleave', () => {
      if (dropRow === row) clearDropMark()
    })
    row.addEventListener('drop', (event) => {
      const dest = dirOf()
      clearDropMark()
      if (dest === null) return
      event.preventDefault()
      event.stopPropagation()
      const source = dragPath ?? event.dataTransfer?.getData('text/plain') ?? ''
      dragPath = null
      if (source === '' || keyOf(source) === keyOf(dest)) return
      // 拖进目录后把它展开，能看到结果
      void (async () => {
        if (await deps.move(source, dest)) {
          expanded.add(keyOf(dest))
          await reload()
        }
      })()
    })
  }

  // ---- 对外接口 ----

  return {
    mount(hostEl) {
      host = hostEl
      host.replaceChildren(box)
      render()
    },
    setRoot(dir) {
      root = dir
      cache.clear()
      expanded.clear()
      editing = null
      error = null
      render()
      if (dir !== null) void reload()
    },
    reload,
    syncFavorites() {
      render()
    },
    setActive(path) {
      activeFile = path
      const target = path !== null && root !== null && keyOf(path).startsWith(keyOf(root)) ? path : null
      if (target !== null) void expandTo(target).then(() => render())
      render()
    }
  }

  /** 让活动文件的祖先目录都展开（只发必要的 listDir 请求） */
  async function expandTo(path: string): Promise<void> {
    if (root === null) return
    const rel = path
      .slice(root.length)
      .split(/[\\/]+/)
      .filter((part) => part !== '')
    let current = root
    for (const part of rel.slice(0, -1)) {
      current = `${current}${sep()}${part}`
      const key = keyOf(current)
      if (!expanded.has(key)) {
        expanded.add(key)
        await ensureLoaded(current)
      }
    }
  }
}
