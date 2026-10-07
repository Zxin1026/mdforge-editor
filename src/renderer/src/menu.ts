/**
 * 轻量弹出菜单：编码/换行符切换、草稿恢复等操作入口用。
 * 带一层子页（进入子页而不是二级浮层），避免浅色界面上叠两层面板。
 */

export interface MenuEntry {
  label: string
  /** 同名条目归入同一组，组切换时自动插一行组标题 */
  group?: string
  /** 直落一条分隔线；菜单栏的下拉用线而不是组标题 */
  divider?: boolean
  /** 右侧弱化补充，例如"当前" */
  hint?: string
  checked?: boolean
  disabled?: boolean
  /** 有 children 时点击是进入子页，否则执行 run */
  children?: MenuEntry[] | (() => MenuEntry[])
  run?: () => void
  /** 设置类条目：执行后留在原页，勾选项能立刻反映新状态 */
  keepOpen?: boolean
}

export interface MenuHandle {
  close(): void
}

type MenuPage = () => MenuEntry[]

export function pageOf(source: MenuEntry[] | (() => MenuEntry[])): MenuPage {
  return typeof source === 'function' ? source : () => source
}

export function openMenu(
  anchor: HTMLElement,
  source: MenuEntry[] | (() => MenuEntry[]),
  onClose?: () => void
): MenuHandle {
  const pages: MenuPage[] = [pageOf(source)]

  const layer = document.createElement('div')
  layer.className = 'mdf-menu'
  layer.setAttribute('role', 'menu')
  document.body.appendChild(layer)

  function close(): void {
    if (!layer.isConnected) return
    layer.remove()
    window.removeEventListener('keydown', onWindowKey, true)
    window.removeEventListener('mousedown', onOutside, true)
    window.removeEventListener('resize', close)
    onClose?.()
  }

  function onOutside(event: MouseEvent): void {
    if (layer.contains(event.target as Node)) return
    // 点锚点本身是"再开一次"，关掉即可，不要让菜单在原地重开
    if (anchor.contains(event.target as Node)) return
    close()
  }

  function onWindowKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (pages.length > 1) back()
      else close()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const items = [...layer.querySelectorAll<HTMLElement>('.mdf-menu-item:not(.is-disabled)')]
    if (items.length === 0) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLElement)
    const step = event.key === 'ArrowDown' ? 1 : -1
    const next = current < 0 ? (step > 0 ? 0 : items.length - 1) : (current + step + items.length) % items.length
    items[next].focus()
  }

  function enter(entry: MenuEntry): void {
    if (entry.disabled) return
    if (entry.children) {
      const page = pageOf(entry.children)
      if (page().length === 0) return
      pages.push(page)
      render()
      return
    }
    const keep = entry.keepOpen === true
    if (!keep) close()
    entry.run?.()
    if (keep) render()
  }

  function back(): void {
    if (pages.length <= 1) return
    pages.pop()
    render()
  }

  function render(): void {
    const page = pages[pages.length - 1]()
    layer.replaceChildren()

    if (pages.length > 1) {
      const bar = document.createElement('button')
      bar.type = 'button'
      bar.className = 'mdf-menu-back'
      bar.textContent = `← ${page[0]?.group ?? '返回'}`
      bar.addEventListener('click', back)
      layer.appendChild(bar)
    }

    let group = ''
    for (const entry of page) {
      if ((entry.group ?? '') !== group) {
        group = entry.group ?? ''
        if (group) {
          const head = document.createElement('div')
          head.className = 'mdf-menu-group'
          head.textContent = group
          layer.appendChild(head)
        }
      }

      const item = document.createElement('button')
      item.type = 'button'
      item.className = `mdf-menu-item${entry.disabled ? ' is-disabled' : ''}`
      item.setAttribute('role', 'menuitem')
      item.dataset.menuLabel = entry.label
      item.tabIndex = 0

      const mark = document.createElement('span')
      mark.className = 'mdf-menu-mark'
      mark.textContent = entry.checked ? '✓' : ''
      const label = document.createElement('span')
      label.className = 'mdf-menu-label'
      label.textContent = entry.label
      const hint = document.createElement('span')
      hint.className = 'mdf-menu-hint'
      const hasChildren = entry.children !== undefined && pageOf(entry.children)().length > 0
      hint.textContent = hasChildren ? '▸' : (entry.hint ?? '')

      item.append(mark, label, hint)
      item.disabled = entry.disabled === true
      item.addEventListener('click', () => enter(entry))
      layer.appendChild(item)
    }

    place()
    layer.querySelector<HTMLElement>('.mdf-menu-item:not(.is-disabled)')?.focus()
  }

  function place(): void {
    const box = anchor.getBoundingClientRect()
    // 先量一次尺寸再定位：子页可能比根页宽
    layer.style.visibility = 'hidden'
    layer.style.left = '0px'
    layer.style.top = '0px'
    const size = layer.getBoundingClientRect()
    const gap = 6
    let left = box.left
    if (left + size.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - size.width - 8)
    let top = box.bottom + gap
    if (top + size.height > window.innerHeight - 8) {
      top = Math.max(8, box.top - size.height - gap)
    }
    layer.style.left = `${Math.round(left)}px`
    layer.style.top = `${Math.round(top)}px`
    layer.style.maxHeight = `${Math.max(160, window.innerHeight - top - 10)}px`
    layer.style.visibility = 'visible'
  }

  window.addEventListener('keydown', onWindowKey, true)
  window.addEventListener('mousedown', onOutside, true)
  window.addEventListener('resize', close)

  render()
  return { close }
}
