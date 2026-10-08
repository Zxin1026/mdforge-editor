/**
 * 带输入控件的应用内对话框：重命名、压缩、front matter 表单这类需要填内容的场景。
 * 与 askDialog 共享对话框栈，Esc 只关栈顶，dialogOpen() 也会让全局快捷键让路。
 */

import { dialogStackPush, dialogStackRemove, dialogStackTop } from './dialog'

export interface FormField {
  key: string
  label: string
  kind?: 'text' | 'number' | 'select' | 'checkbox' | 'textarea'
  value?: string
  placeholder?: string
  /** select 的选项 */
  options?: Array<{ value: string; label: string }>
  min?: number
  max?: number
  step?: number
  hint?: string
}

export interface FormDialogSpec {
  title: string
  body?: string
  note?: string
  fields: FormField[]
  confirmLabel?: string
  cancelLabel?: string
  /** 确认按钮按危险色显示 */
  danger?: boolean
  /** 提交前校验：返回错误文本则留在框里并把错误显示在底部 */
  validate?: (values: Record<string, string>) => string | null
}

let seq = 0

export function askFormDialog(spec: FormDialogSpec): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    seq += 1

    const backdrop = document.createElement('div')
    backdrop.className = 'mdf-dialog-backdrop'
    backdrop.dataset.dialogSeq = String(seq)

    const panel = document.createElement('div')
    panel.className = 'mdf-dialog mdf-form-dialog'
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

    const controls = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>()

    if (spec.fields.length > 0) {
      const form = document.createElement('div')
      form.className = 'mdf-form-fields'
      for (const field of spec.fields) {
        const row = document.createElement('label')
        row.className = 'mdf-form-row'
        const label = document.createElement('span')
        label.className = 'mdf-form-label'
        label.textContent = field.label
        row.appendChild(label)

        let control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
        if (field.kind === 'select') {
          const select = document.createElement('select')
          select.className = 'mdf-form-input'
          for (const option of field.options ?? []) {
            const item = document.createElement('option')
            item.value = option.value
            item.textContent = option.label
            select.appendChild(item)
          }
          if (field.value !== undefined) select.value = field.value
          control = select
        } else if (field.kind === 'textarea') {
          const area = document.createElement('textarea')
          area.className = 'mdf-form-input mdf-form-area'
          area.spellcheck = false
          area.rows = 4
          area.value = field.value ?? ''
          if (field.placeholder) area.placeholder = field.placeholder
          control = area
        } else if (field.kind === 'checkbox') {
          const box = document.createElement('input')
          box.type = 'checkbox'
          box.className = 'mdf-form-check'
          box.checked = field.value === 'true'
          control = box
        } else {
          const input = document.createElement('input')
          input.type = field.kind === 'number' ? 'number' : 'text'
          input.className = 'mdf-form-input'
          input.spellcheck = false
          input.value = field.value ?? ''
          if (field.placeholder) input.placeholder = field.placeholder
          if (field.min !== undefined) input.min = String(field.min)
          if (field.max !== undefined) input.max = String(field.max)
          if (field.step !== undefined) input.step = String(field.step)
          control = input
        }
        control.dataset.field = field.key
        controls.set(field.key, control)
        row.appendChild(control)
        if (field.hint) {
          const hint = document.createElement('span')
          hint.className = 'mdf-form-hint'
          hint.textContent = field.hint
          row.appendChild(hint)
        }
        form.appendChild(row)
      }
      panel.appendChild(form)
    }

    if (spec.note) {
      const note = document.createElement('div')
      note.className = 'mdf-dialog-note'
      note.textContent = spec.note
      panel.appendChild(note)
    }

    const error = document.createElement('div')
    error.className = 'mdf-form-error'
    error.hidden = true
    panel.appendChild(error)

    const footer = document.createElement('div')
    footer.className = 'mdf-dialog-footer'

    let settled = false

    function finish(value: Record<string, string> | null): void {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKey, true)
      dialogStackRemove(backdrop)
      backdrop.remove()
      resolve(value)
    }

    function values(): Record<string, string> {
      const out: Record<string, string> = {}
      for (const [key, control] of controls) {
        out[key] = control instanceof HTMLInputElement && control.type === 'checkbox' ? String(control.checked) : control.value
      }
      return out
    }

    function submit(): void {
      const current = values()
      const problem = spec.validate?.(current) ?? null
      if (problem !== null) {
        error.textContent = problem
        error.hidden = false
        return
      }
      finish(current)
    }

    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'mdf-dialog-button is-plain'
    cancel.textContent = spec.cancelLabel ?? '取消'
    cancel.addEventListener('click', () => finish(null))
    footer.appendChild(cancel)

    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.className = `mdf-dialog-button is-${spec.danger === true ? 'danger' : 'default'}`
    confirm.textContent = spec.confirmLabel ?? '确定'
    confirm.dataset.action = 'form-confirm'
    confirm.addEventListener('click', submit)
    footer.appendChild(confirm)
    panel.appendChild(footer)

    function onKey(event: KeyboardEvent): void {
      if (dialogStackTop() !== backdrop) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        finish(null)
        return
      }
      // 输入框里回车直接提交；多行文本框里的回车是换行
      if (event.key === 'Enter' && !(event.target instanceof HTMLTextAreaElement)) {
        event.preventDefault()
        submit()
      }
    }

    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) finish(null)
    })

    backdrop.appendChild(panel)
    document.body.appendChild(backdrop)
    dialogStackPush(backdrop)
    document.addEventListener('keydown', onKey, true)

    const first = [...controls.values()][0]
    if (first) {
      first.focus()
      if (first instanceof HTMLInputElement && first.type === 'text') first.select()
    } else {
      panel.focus()
    }
  })
}
