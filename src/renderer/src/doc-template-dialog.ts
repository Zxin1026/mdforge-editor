/**
 * 从模板新建：弹窗列出内置骨架，选中后由工作区建标签。
 * 键盘可达：↑↓ 选择、Enter 使用、Esc 取消。
 */

import { DOC_TEMPLATES, type DocTemplate } from './doc-templates'

export function chooseDocTemplate(): Promise<DocTemplate | null> {
  return new Promise<DocTemplate | null>((resolve) => {
    let active = 0
    let closed = false

    const backdrop = document.createElement('div')
    backdrop.className = 'mdf-dialog-backdrop'
    backdrop.dataset.dialog = 'template'

    const panel = document.createElement('div')
    panel.className = 'mdf-dialog mdf-template-dialog'
    panel.tabIndex = -1
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-modal', 'true')
    panel.setAttribute('aria-label', '从模板新建')

    const title = document.createElement('div')
    title.className = 'mdf-dialog-title'
    title.textContent = '从模板新建'

    const note = document.createElement('div')
    note.className = 'mdf-dialog-note'
    note.textContent = '选一个骨架建新文档，日期占位符会自动填上今天的日期。'

    const list = document.createElement('div')
    list.className = 'template-list'

    const footer = document.createElement('div')
    footer.className = 'mdf-dialog-footer'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'mdf-dialog-button is-plain'
    cancel.textContent = '取消'
    cancel.dataset.action = 'template-cancel'
    cancel.addEventListener('click', () => finish(null))
    footer.appendChild(cancel)

    panel.append(title, note, list, footer)
    backdrop.appendChild(panel)

    function render(): void {
      list.replaceChildren()
      DOC_TEMPLATES.forEach((template, index) => {
        const item = document.createElement('button')
        item.type = 'button'
        item.className = `template-item${index === active ? ' is-active' : ''}`
        item.dataset.template = template.id
        const name = document.createElement('div')
        name.className = 'template-name'
        name.textContent = template.name
        const description = document.createElement('div')
        description.className = 'template-description'
        description.textContent = template.description
        item.append(name, description)
        item.addEventListener('mousemove', () => {
          if (active === index) return
          active = index
          render()
        })
        item.addEventListener('click', () => finish(template))
        list.appendChild(item)
      })
    }

    function finish(template: DocTemplate | null): void {
      if (closed) return
      closed = true
      document.removeEventListener('keydown', onKey, true)
      backdrop.remove()
      resolve(template)
    }

    function onKey(event: KeyboardEvent): void {
      if (closed) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        finish(null)
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        active = (active + step + DOC_TEMPLATES.length) % DOC_TEMPLATES.length
        render()
        list.querySelector('.template-item.is-active')?.scrollIntoView({ block: 'nearest' })
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        finish(DOC_TEMPLATES[active])
      }
    }

    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) finish(null)
    })

    document.body.appendChild(backdrop)
    document.addEventListener('keydown', onKey, true)
    render()
    panel.focus()
  })
}
