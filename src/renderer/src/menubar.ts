/**
 * 应用菜单栏：顶栏一排菜单按钮，点开下拉面板；带子级的条目悬停或点击展开右侧浮层。
 * 与 menu.ts 的"子页式"弹出菜单不同——那边点进下一页带返回条，这里要的是 Typora 式浮层。
 */

import { dialogOpen } from './dialog'
import { pageOf, type MenuEntry } from './menu'

export interface MenuBarMenu {
  key: string
  label: string
  /** Alt+助记字母（小写），例如 'f' 对应 Alt+F */
  mnemonic: string
  build: () => MenuEntry[]
}

export interface MenuBarOptions {
  /** Esc 收起菜单后交回焦点，让用户接着打字 */
  onEscape?: () => void
}

export interface MenuBarHandle {
  close(): void
  /** 面板开着时按当前状态重画并重新定位（勾选、缩放变化后用） */
  refresh(): void
  isOpen(): boolean
  destroy(): void
}

/** 悬停多久才展开子级：太快会在划过时误开 */
const HOVER_DELAY_MS = 130

interface Level {
  el: HTMLElement
  source: () => MenuEntry[]
  /** 子级浮层挂在哪条菜单项上；根级为 null */
  item: HTMLElement | null
  /** 根级对应的菜单按钮 */
  button: HTMLButtonElement | null
  parent: Level | null
  sub: Level | null
  hoverTimer: number | undefined
}

export function createMenuBar(host: HTMLElement, menus: MenuBarMenu[], options: MenuBarOptions = {}): MenuBarHandle {
  const buttons = new Map<string, HTMLButtonElement>()
  let stack: Level[] = []

  function panel(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'mdf-menu'
    el.setAttribute('role', 'menu')
    el.dataset.menubar = '1'
    document.body.appendChild(el)
    return el
  }

  function placeLevel(level: Level): void {
    const anchor = level.item ?? level.button
    if (!anchor) return
    const box = anchor.getBoundingClientRect()
    const el = level.el
    // 先量一次尺寸再定位：深处浮层可能比上一级宽
    el.style.visibility = 'hidden'
    el.style.left = '0px'
    el.style.top = '0px'
    const size = el.getBoundingClientRect()
    const edge = 8
    let left: number
    let top: number
    if (level.item) {
      left = box.right + 2
      // 右边放不下就翻到条目左侧
      if (left + size.width > window.innerWidth - edge) left = box.left - size.width - 2
      top = box.top - 5
    } else {
      left = box.left
      top = box.bottom + 4
    }
    left = Math.min(Math.max(edge, left), Math.max(edge, window.innerWidth - size.width - edge))
    top = Math.min(Math.max(edge, top), Math.max(edge, window.innerHeight - size.height - edge))
    el.style.left = `${Math.round(left)}px`
    el.style.top = `${Math.round(top)}px`
    el.style.maxHeight = `${Math.max(160, window.innerHeight - top - edge)}px`
    el.style.visibility = 'visible'
  }

  function placeStack(): void {
    for (const level of stack) placeLevel(level)
  }

  function closeLevel(level: Level): void {
    window.clearTimeout(level.hoverTimer)
    if (level.sub) {
      const sub = level.sub
      level.sub = null
      closeLevel(sub)
    }
    level.item?.classList.remove('is-open')
    level.el.remove()
    stack = stack.filter((entry) => entry !== level)
  }

  function closeBelow(level: Level): void {
    if (!level.sub) return
    const sub = level.sub
    level.sub = null
    closeLevel(sub)
  }

  function closeAll(): void {
    for (const level of [...stack]) {
      window.clearTimeout(level.hoverTimer)
      level.item?.classList.remove('is-open')
      level.button?.classList.remove('is-open')
      level.el.remove()
    }
    stack = []
  }

  function focusedLabel(level: Level): string | null {
    const active = document.activeElement as HTMLElement | null
    if (active && level.el.contains(active) && active.dataset.menuLabel) return active.dataset.menuLabel
    return null
  }

  function firstItem(level: Level): HTMLElement | null {
    return level.el.querySelector<HTMLElement>('.mdf-menu-item:not(.is-disabled)')
  }

  function renderLevel(level: Level, focusFirst = false): void {
    const keepLabel = focusFirst ? null : focusedLabel(level)
    // 条目 DOM 会被整体换掉，挂在旧条目上的深处浮层必须一起收掉
    closeBelow(level)
    level.el.replaceChildren()
    renderEntries(level, level.source())

    if (focusFirst) firstItem(level)?.focus()
    else if (keepLabel) {
      const same = [...level.el.querySelectorAll<HTMLElement>('.mdf-menu-item')].find(
        (item) => item.dataset.menuLabel === keepLabel
      )
      ;(same ?? firstItem(level))?.focus()
    }
    placeStack()
  }

  function openSub(level: Level, item: HTMLElement, entry: MenuEntry, focusFirst: boolean): void {
    // 悬停计时器和点击可能先后到：已经展开的同一层不再重建，免得把刚点开的面板换掉
    if (level.sub && level.sub.item === item) return
    closeBelow(level)
    const source = pageOf(entry.children!)
    if (source().length === 0) return

    const el = panel()
    el.className = 'mdf-menu mdf-menu--sub'
    const sub: Level = { el, source, item, button: null, parent: level, sub: null, hoverTimer: undefined }
    level.sub = sub
    stack.push(sub)
    item.classList.add('is-open')
    bindLevelKeys(sub)
    renderLevel(sub, focusFirst)
  }

  function runEntry(level: Level, entry: MenuEntry): void {
    const keep = entry.keepOpen === true
    if (!keep) closeAll()
    entry.run?.()
    if (keep) {
      // 设置类条目留在原处：勾选与提示立刻反映新状态
      renderLevel(level)
    }
  }

  function renderEntries(level: Level, entries: MenuEntry[]): void {
    let group = ''
    for (const entry of entries) {
      if (entry.divider) {
        group = ''
        const sep = document.createElement('div')
        sep.className = 'mdf-menu-sep'
        level.el.appendChild(sep)
        continue
      }

      if ((entry.group ?? '') !== group) {
        group = entry.group ?? ''
        if (group) {
          const head = document.createElement('div')
          head.className = 'mdf-menu-group'
          head.textContent = group
          level.el.appendChild(head)
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

      const hasChildren = entry.children !== undefined && pageOf(entry.children)().length > 0
      if (hasChildren) {
        const arrow = document.createElement('span')
        arrow.className = 'mdf-menu-arrow'
        arrow.textContent = '▸'
        item.appendChild(arrow)
        item.setAttribute('aria-haspopup', 'menu')
      } else if (entry.hint) {
        const hint = document.createElement('span')
        hint.className = 'mdf-menu-hint'
        hint.textContent = entry.hint
        item.appendChild(hint)
      }

      item.disabled = entry.disabled === true

      item.addEventListener('mouseenter', () => {
        window.clearTimeout(level.hoverTimer)
        // 焦点跟着鼠标走，避免悬停项和焦点项同时高亮
        if (document.activeElement && stack.some((entry) => entry.el.contains(document.activeElement))) item.focus()
        if (entry.disabled) return
        if (hasChildren) {
          level.hoverTimer = window.setTimeout(() => openSub(level, item, entry, false), HOVER_DELAY_MS)
        } else {
          // 稍等一拍再收浮层：斜向划过去时不会把刚展开的子级误关
          level.hoverTimer = window.setTimeout(() => closeBelow(level), HOVER_DELAY_MS)
        }
      })
      item.addEventListener('mouseleave', () => window.clearTimeout(level.hoverTimer))
      item.addEventListener('click', () => {
        if (entry.disabled) return
        if (hasChildren) {
          // 悬停已经展开的就保持展开：悬停后再点击不该把它收起来
          if (level.sub && level.sub.item === item) return
          openSub(level, item, entry, true)
          return
        }
        runEntry(level, entry)
      })
      item.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowRight' && hasChildren) {
          event.preventDefault()
          openSub(level, item, entry, true)
        } else if (event.key === 'ArrowLeft' && level.item && level.parent) {
          event.preventDefault()
          const anchor = level.item
          closeBelow(level.parent)
          anchor.focus()
        }
      })

      level.el.appendChild(item)
    }
  }

  function bindLevelKeys(level: Level): void {
    level.el.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const items = [...level.el.querySelectorAll<HTMLElement>('.mdf-menu-item:not(.is-disabled)')]
      if (items.length === 0) return
      event.preventDefault()
      const current = items.indexOf(document.activeElement as HTMLElement)
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = current < 0 ? (step > 0 ? 0 : items.length - 1) : (current + step + items.length) % items.length
      items[next].focus()
    })
  }

  function openRoot(menu: MenuBarMenu, button: HTMLButtonElement, focusFirst: boolean): void {
    closeAll()
    const el = panel()
    el.className = 'mdf-menu mdf-menu--bar'
    const level: Level = { el, source: menu.build, item: null, button, parent: null, sub: null, hoverTimer: undefined }
    stack = [level]
    button.classList.add('is-open')
    bindLevelKeys(level)
    renderLevel(level, focusFirst)
  }

  for (const menu of menus) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'mdf-menubar-button'
    button.dataset.menu = menu.key
    button.textContent = menu.label
    button.addEventListener('click', () => {
      if (stack.length > 0 && stack[0].button === button) closeAll()
      else openRoot(menu, button, true)
    })
    // 已经摊开一个菜单时，划过其他菜单直接换过去
    button.addEventListener('mouseenter', () => {
      if (stack.length > 0 && stack[0].button !== button) openRoot(menu, button, true)
    })
    host.appendChild(button)
    buttons.set(menu.key, button)
  }

  function onOutside(event: MouseEvent): void {
    if (stack.length === 0) return
    const target = event.target as Node
    if (host.contains(target)) return
    if (stack.some((level) => level.el.contains(target))) return
    closeAll()
  }

  function onEscapeKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || stack.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    closeAll()
    options.onEscape?.()
  }

  function onAltKey(event: KeyboardEvent): void {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (stack.length === 0 && dialogOpen()) return
    // 芯片菜单（menu.ts）自己管自己的开合，别叠上去
    if (document.querySelector('.mdf-menu:not([data-menubar])') !== null) return
    const menu = menus.find((entry) => entry.mnemonic === event.key.toLowerCase())
    if (!menu) return
    event.preventDefault()
    const button = buttons.get(menu.key)
    if (button) openRoot(menu, button, true)
  }

  window.addEventListener('mousedown', onOutside, true)
  window.addEventListener('keydown', onEscapeKey, true)
  window.addEventListener('keydown', onAltKey)

  return {
    close: closeAll,
    refresh: () => {
      if (stack.length > 0) renderLevel(stack[0], false)
    },
    isOpen: () => stack.length > 0,
    destroy: () => {
      closeAll()
      window.removeEventListener('mousedown', onOutside, true)
      window.removeEventListener('keydown', onEscapeKey, true)
      window.removeEventListener('keydown', onAltKey)
      for (const button of buttons.values()) button.remove()
      buttons.clear()
    }
  }
}
