/**
 * 快捷键设置：列出全部可改命令，点组合键进入录制，按下新组合即生效。
 * Backspace/Delete 解绑；Esc 取消录制（再按一次 Esc 关窗）；「恢复」回到默认值。
 */

import {
  KEY_COMMANDS,
  KEY_GROUP_ORDER,
  effectiveKey,
  formatKey,
  keyFromEvent,
  onKeybindingChange,
  overrideOf,
  resetKeybinding,
  resetKeybindings,
  setKeybinding
} from './keybindings'

function isModifierCode(code: string): boolean {
  return /^(Control|Alt|Shift|Meta)(Left|Right)$/.test(code)
}

export function openKeybindingDialog(): void {
  let capturing: string | null = null
  let notice = ''
  let closed = false

  const backdrop = document.createElement('div')
  backdrop.className = 'mdf-dialog-backdrop'
  backdrop.dataset.dialog = 'keybindings'

  const panel = document.createElement('div')
  panel.className = 'mdf-dialog mdf-keymap-dialog'
  panel.tabIndex = -1
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-label', '快捷键设置')

  const title = document.createElement('div')
  title.className = 'mdf-dialog-title'
  title.textContent = '快捷键设置'

  const note = document.createElement('div')
  note.className = 'mdf-dialog-note'
  note.textContent =
    '点右侧的组合键开始录制：按下新的组合键即生效；Backspace 解绑、Esc 取消录制。「恢复」回到默认值。'

  const noticeLine = document.createElement('div')
  noticeLine.className = 'keymap-notice'
  noticeLine.dataset.role = 'keymap-notice'

  const list = document.createElement('div')
  list.className = 'keymap-list'

  const footer = document.createElement('div')
  footer.className = 'mdf-dialog-footer'
  const resetAll = document.createElement('button')
  resetAll.type = 'button'
  resetAll.className = 'mdf-dialog-button is-plain'
  resetAll.textContent = '全部恢复默认'
  resetAll.dataset.action = 'keymap-reset-all'
  resetAll.addEventListener('click', () => {
    capturing = null
    notice = ''
    resetKeybindings()
    render()
  })
  const done = document.createElement('button')
  done.type = 'button'
  done.className = 'mdf-dialog-button is-default'
  done.textContent = '完成'
  done.dataset.action = 'keymap-close'
  done.addEventListener('click', () => close())
  footer.append(resetAll, done)

  panel.append(title, note, noticeLine, list, footer)
  backdrop.appendChild(panel)

  function render(): void {
    noticeLine.textContent = notice
    noticeLine.classList.toggle('is-error', notice !== '')
    const groups: HTMLElement[] = []
    for (const group of KEY_GROUP_ORDER) {
      const commands = KEY_COMMANDS.filter((command) => command.group === group)
      if (commands.length === 0) continue
      const box = document.createElement('div')
      box.className = 'keymap-group'
      const head = document.createElement('div')
      head.className = 'keymap-group-head'
      head.textContent = group
      box.appendChild(head)
      for (const command of commands) {
        box.appendChild(row(command.id, command.label))
      }
      groups.push(box)
    }
    list.replaceChildren(...groups)
  }

  function row(id: string, label: string): HTMLElement {
    const line = document.createElement('div')
    line.className = 'keymap-row'
    line.dataset.command = id

    const name = document.createElement('span')
    name.className = 'keymap-label'
    name.textContent = label

    const key = document.createElement('button')
    key.type = 'button'
    key.className = `keymap-key${capturing === id ? ' is-capturing' : ''}`
    const current = effectiveKey(id)
    if (capturing === id) key.textContent = '按下组合键…'
    else if (current === null) {
      key.textContent = '未绑定'
      key.classList.add('is-unbound')
    } else key.textContent = formatKey(current)
    key.title = '点击后按下新的组合键'
    key.dataset.action = 'keymap-record'
    key.addEventListener('click', () => {
      capturing = id
      notice = ''
      render()
      panel.focus()
    })

    const reset = document.createElement('button')
    reset.type = 'button'
    reset.className = 'keymap-reset'
    reset.textContent = '恢复'
    reset.dataset.action = 'keymap-reset'
    reset.disabled = overrideOf(id) === undefined
    reset.addEventListener('click', () => {
      capturing = null
      notice = ''
      resetKeybinding(id)
      render()
    })

    line.append(name, key, reset)
    return line
  }

  function onKey(event: KeyboardEvent): void {
    if (closed) return
    if (capturing === null) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close()
      }
      return
    }
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    if (event.key === 'Escape') {
      capturing = null
      render()
      return
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      setKeybinding(capturing, null)
      capturing = null
      render()
      return
    }
    if (isModifierCode(event.code)) return
    const id = capturing
    const key = keyFromEvent(event)
    if (key === null) {
      notice = '这个键不能用作快捷键，请换一个组合'
      render()
      return
    }
    const problem = setKeybinding(id, key)
    if (problem) {
      notice = `${formatKey(key)} ${problem.reason}`
      render()
      return
    }
    capturing = null
    notice = ''
    render()
  }

  const offChange = onKeybindingChange(() => {
    if (!closed) render()
  })

  function close(): void {
    if (closed) return
    closed = true
    offChange()
    document.removeEventListener('keydown', onKey, true)
    backdrop.remove()
  }

  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close()
  })

  document.body.appendChild(backdrop)
  document.addEventListener('keydown', onKey, true)
  render()
  panel.focus()
}
