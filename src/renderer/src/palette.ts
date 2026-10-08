/**
 * 命令面板（Ctrl+Shift+P）：把菜单树拍平成一个可模糊搜索的列表，
 * 给菜单栏之外的第二条发现路径。菜单里的动态项（最近打开、导出设置、字体大小等）同样会进来。
 */

import { appMenus, type AppMenuContext } from './app-menu'
import { effectiveKey, keyFromEvent } from './keybindings'
import type { MenuEntry } from './menu'

interface PaletteCommand {
  /** 条目本身的名字，如「另存为…」 */
  label: string
  /** 从哪个菜单来，如「文件」或「文件 › 最近打开」 */
  path: string
  /** 右侧补充：键位或路径说明 */
  detail: string
  run: () => void
}

interface PaletteInstance {
  close(): void
}

let current: PaletteInstance | null = null

export function toggleCommandPalette(ctx: AppMenuContext): void {
  if (current !== null) {
    current.close()
    return
  }
  openPalette(ctx)
}

function collectCommands(ctx: AppMenuContext): PaletteCommand[] {
  const out: PaletteCommand[] = []
  const push = (path: string, entry: MenuEntry): void => {
    if (entry.divider === true || entry.disabled === true) return
    if (entry.group === '说明') return
    const label = entry.label.trim()
    if (label === '') return
    if (entry.children !== undefined) {
      const children = typeof entry.children === 'function' ? entry.children() : entry.children
      for (const child of children) push(`${path} › ${label}`, child)
      return
    }
    if (entry.run === undefined) return
    out.push({ label, path, detail: entry.hint ?? '', run: entry.run })
  }
  for (const menu of appMenus(ctx)) {
    for (const entry of menu.build()) push(menu.label, entry)
  }
  return out
}

/** 子序列匹配：返回分数（越大越优），不匹配返回 null */
function subsequenceScore(query: string, text: string): number | null {
  let index = 0
  let score = 0
  let streak = 0
  for (let i = 0; i < text.length && index < query.length; i += 1) {
    if (text[i] !== query[index]) {
      streak = 0
      continue
    }
    streak += 1
    score += 1 + streak * 2
    const prev = text[i - 1] ?? ''
    if (i === 0 || ' ›·-_. /：:'.includes(prev)) score += 4
    index += 1
  }
  return index === query.length ? score : null
}

function matchScore(query: string, command: PaletteCommand): number | null {
  const tokens = query.toLowerCase().split(/\s+/).filter((token) => token !== '')
  if (tokens.length === 0) return 0
  const text = `${command.label} ${command.path}`.toLowerCase()
  let total = 0
  for (const token of tokens) {
    const score = subsequenceScore(token, text)
    if (score === null) return null
    total += score
  }
  if (command.label.toLowerCase().startsWith(tokens[0])) total += 30
  return total
}

const MAX_RESULTS = 60

function openPalette(ctx: AppMenuContext): void {
  let commands = collectCommands(ctx)
  let filtered: PaletteCommand[] = commands.slice(0, MAX_RESULTS)
  let active = 0
  let closed = false

  const backdrop = document.createElement('div')
  backdrop.className = 'mdf-palette-backdrop'

  const panel = document.createElement('div')
  panel.className = 'mdf-palette'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-label', '命令面板')

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'mdf-palette-input'
  input.placeholder = '输入命令名称…'
  input.spellcheck = false

  const list = document.createElement('div')
  list.className = 'mdf-palette-list'
  list.setAttribute('role', 'listbox')

  const foot = document.createElement('div')
  foot.className = 'mdf-palette-foot'
  foot.textContent = '↑↓ 选择 · Enter 执行 · Esc 关闭'

  panel.append(input, list, foot)
  backdrop.appendChild(panel)

  function close(): void {
    if (closed) return
    closed = true
    document.removeEventListener('mousedown', onOutside, true)
    backdrop.remove()
    if (current?.close === close) current = null
  }

  function onOutside(event: MouseEvent): void {
    if (!backdrop.contains(event.target as Node)) close()
  }

  function render(): void {
    list.replaceChildren()
    if (filtered.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'mdf-palette-empty'
      empty.textContent = commands.length === 0 ? '没有可执行的命令' : '没有匹配的命令'
      list.appendChild(empty)
      return
    }
    filtered.forEach((command, index) => {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = `mdf-palette-item${index === active ? ' is-active' : ''}`
      item.setAttribute('role', 'option')
      item.dataset.index = String(index)
      const label = document.createElement('span')
      label.className = 'mdf-palette-label'
      label.textContent = command.label
      const path = document.createElement('span')
      path.className = 'mdf-palette-path'
      path.textContent = command.path
      const hint = document.createElement('span')
      hint.className = 'mdf-palette-hint'
      hint.textContent = command.detail
      item.append(label, path, hint)
      item.addEventListener('mousemove', () => {
        if (active === index) return
        active = index
        applyActive()
      })
      item.addEventListener('click', () => run(command))
      list.appendChild(item)
    })
  }

  /** 只改选中态不高亮：鼠标扫过时不用整表重画 */
  function applyActive(): void {
    list.querySelectorAll<HTMLElement>('.mdf-palette-item').forEach((element, index) => {
      element.classList.toggle('is-active', index === active)
    })
  }

  function refresh(): void {
    const query = input.value.trim()
    commands = collectCommands(ctx)
    if (query === '') {
      filtered = commands.slice(0, MAX_RESULTS)
    } else {
      filtered = commands
        .map((command) => ({ command, score: matchScore(query, command) }))
        .filter((entry): entry is { command: PaletteCommand; score: number } => entry.score !== null)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_RESULTS)
        .map((entry) => entry.command)
    }
    active = 0
    render()
  }

  function move(step: number): void {
    if (filtered.length === 0) return
    active = (active + step + filtered.length) % filtered.length
    applyActive()
    list.querySelector('.mdf-palette-item.is-active')?.scrollIntoView({ block: 'nearest' })
  }

  function run(command: PaletteCommand): void {
    close()
    command.run()
  }

  input.addEventListener('input', () => refresh())
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(-1)
    } else if (event.key === 'PageDown') {
      event.preventDefault()
      move(8)
    } else if (event.key === 'PageUp') {
      event.preventDefault()
      move(-8)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const command = filtered[active]
      if (command !== undefined) run(command)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close()
    } else {
      // 面板打开时再按一次呼出键（可自定义）就收起来
      const again = keyFromEvent(event)
      if (again !== null && again === effectiveKey('palette')) {
        event.preventDefault()
        close()
      }
    }
  })

  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close()
  })

  document.addEventListener('mousedown', onOutside, true)
  document.body.appendChild(backdrop)
  refresh()
  input.focus()

  current = { close }
}
