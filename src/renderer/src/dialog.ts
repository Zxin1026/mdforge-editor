/**
 * 应用内确认框：替代 window.confirm，让"保存 / 放弃 / 重新载入"这类选择用一致的中文化按钮表达，
 * 也让自动化验证能真的点按钮（原生对话框在测试里点不到）。
 */

export interface DialogOption<T> {
  label: string
  value: T
  /** default = 回车选它；danger = 会丢数据的红色按钮 */
  kind?: 'default' | 'danger' | 'plain'
}

export interface DialogSpec<T> {
  title: string
  body?: string
  /** 逐行列出的明细，例如冲突的文件路径、待恢复的草稿名 */
  lines?: string[]
  note?: string
  options: DialogOption<T>[]
  cancelValue: T
}

let seq = 0
/** 只有最上面那个框响应 Esc：确认后叠在下面的框不应一起被关掉 */
const stack: HTMLElement[] = []

export function askDialog<T>(spec: DialogSpec<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    seq += 1

    const backdrop = document.createElement('div')
    backdrop.className = 'mdf-dialog-backdrop'
    backdrop.dataset.dialogSeq = String(seq)

    const panel = document.createElement('div')
    panel.className = 'mdf-dialog'
    panel.tabIndex = -1
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-modal', 'true')
    panel.setAttribute('aria-label', spec.title)

    const title = document.createElement('div')
    title.className = 'mdf-dialog-title'
    title.textContent = spec.title
    panel.appendChild(title)

    if (spec.body) {
      const body = document.createElement('div')
      body.className = 'mdf-dialog-body'
      body.textContent = spec.body
      panel.appendChild(body)
    }

    if (spec.lines && spec.lines.length > 0) {
      const list = document.createElement('ul')
      list.className = 'mdf-dialog-lines'
      for (const line of spec.lines) {
        const item = document.createElement('li')
        item.textContent = line
        list.appendChild(item)
      }
      panel.appendChild(list)
    }

    if (spec.note) {
      const note = document.createElement('div')
      note.className = 'mdf-dialog-note'
      note.textContent = spec.note
      panel.appendChild(note)
    }

    const footer = document.createElement('div')
    footer.className = 'mdf-dialog-footer'

    let settled = false

    function finish(value: T): void {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKey, true)
      const index = stack.indexOf(backdrop)
      if (index >= 0) stack.splice(index, 1)
      backdrop.remove()
      resolve(value)
    }

    for (const option of spec.options) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `mdf-dialog-button is-${option.kind ?? 'plain'}`
      button.textContent = option.label
      // value 用序号传：绝对路径之类的值直接进 dataset 会让选择器没法写
      button.dataset.dialogValue = String(spec.options.indexOf(option))
      button.addEventListener('click', () => finish(option.value))
      footer.appendChild(button)
    }
    panel.appendChild(footer)

    function onKey(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      if (stack[stack.length - 1] !== backdrop) return
      event.preventDefault()
      event.stopPropagation()
      finish(spec.cancelValue)
    }

    // 焦点停在面板上时回车=默认按钮；已经 Tab 到某个按钮时交回浏览器原生点击
    panel.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.target !== panel) return
      event.preventDefault()
      const preferred = spec.options.find((option) => option.kind === 'default') ?? spec.options[0]
      finish(preferred.value)
    })

    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) finish(spec.cancelValue)
    })

    backdrop.appendChild(panel)
    document.body.appendChild(backdrop)
    stack.push(backdrop)
    document.addEventListener('keydown', onKey, true)
    panel.focus()
  })
}

/** 是否有确认框打开：全局快捷键要给它让路，别让 Ctrl+S 在框后面继续写盘 */
export function dialogOpen(): boolean {
  return document.querySelector('.mdf-dialog-backdrop') !== null
}
