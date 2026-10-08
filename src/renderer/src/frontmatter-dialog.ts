/**
 * front matter 的可视化编辑：表单（标题/作者/日期/标签/摘要）+ 原始 YAML 双模式，
 * 表单只增量改写已知字段，未知字段与注释原样保留。
 */

import type { EditorView } from '@codemirror/view'
import { dialogStackPush, dialogStackRemove, dialogStackTop } from './dialog'
import { frontMatterOf } from './editor/frontmatter'
import {
  buildFrontMatter,
  FRONT_MATTER_FIELDS,
  parseFrontMatter,
  readFields
} from './editor/frontmatter-yaml'

function normalizeBlock(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines.join('\n')
}

/**
 * 返回新的 YAML 块正文（不含首尾的 --- 标记）；空串表示删除 front matter；
 * null 表示取消。
 */
export function openFrontMatterDialog(initialBlock: string, exists: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    let model = parseFrontMatter(initialBlock)
    let values = readFields(model)
    let mode: 'form' | 'raw' = 'form'
    let settled = false

    const backdrop = document.createElement('div')
    backdrop.className = 'mdf-dialog-backdrop'

    const panel = document.createElement('div')
    panel.className = 'mdf-dialog mdf-form-dialog'
    panel.tabIndex = -1
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-modal', 'true')
    panel.setAttribute('aria-label', '文档信息（Front Matter）')

    const title = document.createElement('div')
    title.className = 'mdf-dialog-title'
    title.textContent = '文档信息（Front Matter）'
    panel.appendChild(title)

    const lead = document.createElement('div')
    lead.className = 'mdf-dialog-body'
    lead.textContent = exists
      ? '这些字段保存在文档开头的元信息块里。'
      : '当前文档还没有 front matter，保存后会插入到文档开头。'
    panel.appendChild(lead)

    const body = document.createElement('div')
    body.className = 'mdf-form-fields'
    panel.appendChild(body)

    const controls = new Map<string, HTMLInputElement | HTMLTextAreaElement>()
    const rawArea = document.createElement('textarea')
    rawArea.className = 'mdf-form-input mdf-form-area mdf-fm-raw'
    rawArea.rows = 10
    rawArea.spellcheck = false

    const hint = document.createElement('div')
    hint.className = 'mdf-dialog-note'
    panel.appendChild(hint)

    const error = document.createElement('div')
    error.className = 'mdf-form-error'
    error.hidden = true
    panel.appendChild(error)

    function renderBody(): void {
      body.replaceChildren()
      controls.clear()
      hint.textContent =
        mode === 'form'
          ? '未列出的字段与注释会原样保留；清空某个字段等于删掉它。'
          : '这里是完整 YAML；改动会整体替换原内容，清空后保存＝删除 front matter。'
      if (mode === 'form') {
        for (const field of FRONT_MATTER_FIELDS) {
          const row = document.createElement('label')
          row.className = `mdf-form-row${field.kind === 'textarea' ? ' is-block' : ''}`
          const label = document.createElement('span')
          label.className = 'mdf-form-label'
          label.textContent = field.label
          row.appendChild(label)

          let control: HTMLInputElement | HTMLTextAreaElement
          if (field.kind === 'textarea') {
            const area = document.createElement('textarea')
            area.className = 'mdf-form-input mdf-form-area'
            area.rows = 3
            area.spellcheck = false
            control = area
          } else {
            const input = document.createElement('input')
            input.type = 'text'
            input.className = 'mdf-form-input'
            input.spellcheck = false
            input.dataset.field = field.key
            control = input
          }
          control.value = values[field.key] ?? ''
          if (field.placeholder) control.placeholder = field.placeholder
          controls.set(field.key, control)
          row.appendChild(control)
          body.appendChild(row)
        }
      } else {
        const row = document.createElement('label')
        row.className = 'mdf-form-row is-block'
        const label = document.createElement('span')
        label.className = 'mdf-form-label'
        label.textContent = '原始 YAML'
        row.appendChild(label)
        rawArea.value = buildFrontMatter(model, values)
        row.appendChild(rawArea)
        body.appendChild(row)
      }
    }

    function collectValues(): void {
      for (const [key, control] of controls) values[key] = control.value
    }

    /** 当前模式下的 YAML：表单模式先吸值再重建，原始模式直接用文本 */
    function currentYaml(): string {
      if (mode === 'raw') return normalizeBlock(rawArea.value)
      collectValues()
      return normalizeBlock(buildFrontMatter(model, values))
    }

    function switchMode(): void {
      if (mode === 'form') {
        collectValues()
        mode = 'raw'
      } else {
        const text = normalizeBlock(rawArea.value)
        model = parseFrontMatter(text)
        values = readFields(model)
        mode = 'form'
      }
      renderBody()
      const first = [...controls.values()][0]
      if (first) first.focus()
      else rawArea.focus()
    }

    function finish(result: string | null): void {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKey, true)
      dialogStackRemove(backdrop)
      backdrop.remove()
      resolve(result)
    }

    function save(): void {
      finish(currentYaml())
    }

    const footer = document.createElement('div')
    footer.className = 'mdf-dialog-footer'

    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'mdf-dialog-button is-plain mdf-fm-toggle-btn'
    toggle.dataset.action = 'fm-toggle-mode'
    toggle.textContent = '查看/编辑原始 YAML'
    toggle.addEventListener('click', () => {
      switchMode()
      toggle.textContent = mode === 'raw' ? '返回表单填写' : '查看/编辑原始 YAML'
    })

    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'mdf-dialog-button is-plain'
    cancel.textContent = '取消'
    cancel.addEventListener('click', () => finish(null))

    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.className = 'mdf-dialog-button is-default'
    confirm.dataset.action = 'fm-save'
    confirm.textContent = '保存到文档'
    confirm.addEventListener('click', save)

    footer.append(toggle, cancel, confirm)
    panel.appendChild(footer)

    function onKey(event: KeyboardEvent): void {
      if (dialogStackTop() !== backdrop) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        finish(null)
        return
      }
      if (event.key === 'Enter' && !(event.target instanceof HTMLTextAreaElement)) {
        event.preventDefault()
        save()
      }
    }

    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) finish(null)
    })
    backdrop.appendChild(panel)
    document.body.appendChild(backdrop)
    dialogStackPush(backdrop)
    document.addEventListener('keydown', onKey, true)

    renderBody()
    const first = [...controls.values()][0]
    if (first) {
      first.focus()
      if (first instanceof HTMLInputElement) first.select()
    }
  })
}

/** 编辑器入口：把结果写回文档（作为一次可撤销的编辑） */
export async function openFrontMatterEditor(view: EditorView): Promise<void> {
  const doc = view.state.doc
  const span = frontMatterOf(doc)

  let initial = ''
  if (span !== null) {
    const lastLine = doc.lineAt(span.to).number
    initial = lastLine >= 3 ? doc.sliceString(doc.line(2).from, doc.line(lastLine).from - 1) : ''
  }

  const block = await openFrontMatterDialog(initial, span !== null)
  if (block === null || !view.dom.isConnected) return

  if (span === null) {
    if (block === '') return
    view.dispatch({ changes: { from: 0, insert: `---\n${block}\n---\n\n` }, userEvent: 'input' })
    view.focus()
    return
  }

  if (block === '') {
    // 整块删除：连同紧跟的一个换行，避免文档以空行开头
    const closeLine = doc.lineAt(span.to)
    const to = doc.sliceString(closeLine.to, Math.min(closeLine.to + 1, doc.length)) === '\n' ? closeLine.to + 1 : closeLine.to
    view.dispatch({ changes: { from: 0, to, insert: '' }, userEvent: 'input' })
  } else {
    view.dispatch({ changes: { from: 0, to: span.to, insert: `---\n${block}\n---` }, userEvent: 'input' })
  }
  view.focus()
}
