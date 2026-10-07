/**
 * 编辑器区的右键菜单：一层扁平条目，位置跟着指针走。
 * 不复用 menu.ts——那边是锚在芯片上的子页式菜单；也不复用应用菜单栏——那边按锚点定位。
 * 样式类（.mdf-menu / .mdf-menu-item / …）与两者共用，深浅主题自动一致。
 */

import { pageOf, type MenuEntry, type MenuHandle } from './menu'

export interface ContextPoint {
  x: number
  y: number
}

const EDGE = 8

export function openContextMenu(
  point: ContextPoint,
  source: MenuEntry[] | (() => MenuEntry[]),
  onClose?: () => void
): MenuHandle {
  const layer = document.createElement('div')
  layer.className = 'mdf-menu'
  layer.setAttribute('role', 'menu')
  layer.dataset.context = '1'
  document.body.appendChild(layer)

  function close(): void {
    if (!layer.isConnected) return
    layer.remove()
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('mousedown', onOutside, true)
    window.removeEventListener('blur', close)
    window.removeEventListener('resize', close)
    document.removeEventListener('wheel', onScroll, true)
    onClose?.()
  }

  function onOutside(event: MouseEvent): void {
    if (layer.contains(event.target as Node)) return
    close()
  }

  /** 滚动编辑器时菜单要跟着收起，否则会悬在原地指错行 */
  function onScroll(event: WheelEvent): void {
    if (layer.contains(event.target as Node)) return
    close()
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
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

  function render(): void {
    layer.replaceChildren()
    let group = ''
    for (const entry of pageOf(source)()) {
      if (entry.divider) {
        group = ''
        const sep = document.createElement('div')
        sep.className = 'mdf-menu-sep'
        layer.appendChild(sep)
        continue
      }

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
      item.tabIndex = entry.disabled ? -1 : 0

      const mark = document.createElement('span')
      mark.className = 'mdf-menu-mark'
      mark.textContent = entry.checked ? '✓' : ''
      const label = document.createElement('span')
      label.className = 'mdf-menu-label'
      label.textContent = entry.label
      item.append(mark, label)

      if (entry.hint) {
        const hint = document.createElement('span')
        hint.className = 'mdf-menu-hint'
        hint.textContent = entry.hint
        item.appendChild(hint)
      }

      item.disabled = entry.disabled === true
      item.addEventListener('click', () => {
        close()
        entry.run?.()
      })
      layer.appendChild(item)
    }

    place()
    layer.querySelector<HTMLElement>('.mdf-menu-item:not(.is-disabled)')?.focus()
  }

  function place(): void {
    // 先量尺寸再定位：放不下就往左上翻
    layer.style.visibility = 'hidden'
    layer.style.left = '0px'
    layer.style.top = '0px'
    const size = layer.getBoundingClientRect()
    let left = point.x
    let top = point.y
    if (left + size.width > window.innerWidth - EDGE) left = Math.max(EDGE, window.innerWidth - size.width - EDGE)
    if (top + size.height > window.innerHeight - EDGE) top = Math.max(EDGE, window.innerHeight - size.height - EDGE)
    layer.style.left = `${Math.round(left)}px`
    layer.style.top = `${Math.round(top)}px`
    layer.style.maxHeight = `${Math.max(160, window.innerHeight - top - EDGE)}px`
    layer.style.visibility = 'visible'
  }

  window.addEventListener('keydown', onKey, true)
  window.addEventListener('mousedown', onOutside, true)
  window.addEventListener('blur', close)
  window.addEventListener('resize', close)
  document.addEventListener('wheel', onScroll, true)

  render()
  return { close }
}
