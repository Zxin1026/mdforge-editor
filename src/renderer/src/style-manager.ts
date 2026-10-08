/**
 * 主题与模板管理器：内置/自定义的导出主题（CSS）与页面模板（HTML）都在这里
 * 设为当前、编辑、导出、删除、导入。条目存在主进程的 userData 目录，
 * 本模块只负责列表与动作，库变化通过 ctx.setLibrary 回给工作区。
 */

import {
  customIdOf,
  customRefOf,
  type CustomStyleKind,
  type CustomStyleLibrary,
  type ExportOptions,
  type ExportTheme,
  type PageTemplate
} from '../../shared/ipc'
import { askDialog, dialogStackPush, dialogStackRemove, dialogStackTop, type DialogOption } from './dialog'
import { builtinThemeCss } from './export/export-css'
import { THEME_LABELS, THEMES } from './export/options'
import { BUILTIN_TEMPLATE_HTML } from './export/page-template'
import { openStyleEditor } from './style-editor'

export interface StyleManagerContext {
  library(): CustomStyleLibrary
  currentTheme(): ExportTheme
  currentTemplate(): PageTemplate
  /** 预览来源：当前文档；null 时编辑器用示例文档 */
  source(): { text: string; title: string; path: string | null } | null
  options(): ExportOptions
  setLibrary(library: CustomStyleLibrary): void
  chooseTheme(ref: ExportTheme): void
  chooseTemplate(ref: PageTemplate): void
  notify(text: string): void
}

interface RowSpec {
  kind: CustomStyleKind
  ref: ExportTheme | PageTemplate
  name: string
  builtin: boolean
  id: string | null
}

export function openStyleManager(ctx: StyleManagerContext): void {
  let tab: CustomStyleKind = 'theme'

  const backdrop = document.createElement('div')
  backdrop.className = 'mdf-dialog-backdrop'

  const panel = document.createElement('div')
  panel.className = 'mdf-dialog mdf-style-dialog'
  panel.tabIndex = -1
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-label', '主题与模板')

  const title = document.createElement('div')
  title.className = 'mdf-dialog-title'
  title.textContent = '主题与模板'
  panel.appendChild(title)

  const tabs = document.createElement('div')
  tabs.className = 'mdf-style-tabs'
  const tabButtons = new Map<CustomStyleKind, HTMLButtonElement>()
  for (const [kind, label] of [
    ['theme', '导出主题'],
    ['template', '页面模板']
  ] as Array<[CustomStyleKind, string]>) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'mdf-style-tab'
    button.textContent = label
    button.dataset.tab = kind
    button.addEventListener('click', () => {
      tab = kind
      render()
    })
    tabButtons.set(kind, button)
    tabs.appendChild(button)
  }
  panel.appendChild(tabs)

  const list = document.createElement('div')
  list.className = 'mdf-style-list'
  panel.appendChild(list)

  const actions = document.createElement('div')
  actions.className = 'mdf-style-actions'
  panel.appendChild(actions)

  const note = document.createElement('div')
  note.className = 'mdf-dialog-note'
  panel.appendChild(note)

  const footer = document.createElement('div')
  footer.className = 'mdf-dialog-footer'
  const done = document.createElement('button')
  done.type = 'button'
  done.className = 'mdf-dialog-button is-default'
  done.textContent = '完成'
  done.dataset.action = 'style-manager-done'
  done.addEventListener('click', finish)
  footer.appendChild(done)
  panel.appendChild(footer)

  let settled = false

  function finish(): void {
    if (settled) return
    settled = true
    document.removeEventListener('keydown', onKey, true)
    dialogStackRemove(backdrop)
    backdrop.remove()
  }

  function onKey(event: KeyboardEvent): void {
    if (dialogStackTop() !== backdrop) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      finish()
    }
  }

  function currentRef(): ExportTheme | PageTemplate {
    return tab === 'theme' ? ctx.currentTheme() : ctx.currentTemplate()
  }

  function choose(ref: ExportTheme | PageTemplate): void {
    if (tab === 'theme') ctx.chooseTheme(ref as ExportTheme)
    else ctx.chooseTemplate(ref as PageTemplate)
    render()
  }

  function rows(): RowSpec[] {
    const library = ctx.library()
    if (tab === 'theme') {
      const builtin: RowSpec[] = THEMES.map((ref) => ({
        kind: 'theme',
        ref,
        name: THEME_LABELS[ref],
        builtin: true,
        id: null
      }))
      const mine: RowSpec[] = library.themes.map((theme) => ({
        kind: 'theme',
        ref: customRefOf(theme.id),
        name: theme.name,
        builtin: false,
        id: theme.id
      }))
      return [...builtin, ...mine]
    }
    const builtinTpl: RowSpec = { kind: 'template', ref: 'builtin', name: '内置标准页', builtin: true, id: null }
    const mineTpl: RowSpec[] = library.templates.map((template) => ({
      kind: 'template',
      ref: customRefOf(template.id),
      name: template.name,
      builtin: false,
      id: template.id
    }))
    return [builtinTpl, ...mineTpl]
  }

  function button(label: string, action: string, run: () => void, danger = false): HTMLButtonElement {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = `mdf-style-btn${danger ? ' is-danger' : ''}`
    item.textContent = label
    item.dataset.action = action
    item.addEventListener('click', run)
    return item
  }

  function rowElement(spec: RowSpec): HTMLElement {
    const row = document.createElement('div')
    row.className = 'mdf-style-row'
    row.dataset.kind = spec.kind
    row.dataset.ref = spec.ref

    const info = document.createElement('div')
    info.className = 'mdf-style-info'
    const name = document.createElement('span')
    name.className = 'mdf-style-name'
    name.textContent = spec.name
    const tag = document.createElement('span')
    tag.className = 'mdf-style-tag'
    tag.textContent = spec.builtin ? '内置' : '自定义'
    info.append(name, tag)

    const isCurrent = currentRef() === spec.ref
    if (isCurrent) {
      const chip = document.createElement('span')
      chip.className = 'mdf-style-current'
      chip.textContent = '当前'
      info.appendChild(chip)
    }
    row.appendChild(info)

    const box = document.createElement('div')
    box.className = 'mdf-style-row-actions'
    if (!isCurrent) {
      box.appendChild(button('设为当前', 'style-use', () => choose(spec.ref)))
    }
    if (spec.builtin) {
      box.appendChild(button('复制为自定义…', 'style-copy', () => copyBuiltin(spec)))
    } else {
      box.appendChild(button('编辑…', 'style-edit', () => editStyle(spec)))
      box.appendChild(button('导出…', 'style-export', () => void exportStyle(spec)))
      box.appendChild(button('删除…', 'style-delete', () => void removeStyle(spec), true))
    }
    row.appendChild(box)
    return row
  }

  /** 复制内置条目为自定义底稿：改坏也只影响副本 */
  function copyBuiltin(spec: RowSpec): void {
    const content = spec.kind === 'theme' ? (builtinThemeCss(spec.ref as ExportTheme) ?? '') : BUILTIN_TEMPLATE_HTML
    openStyleEditor({
      kind: spec.kind,
      id: null,
      name: `${spec.name} 副本`,
      content,
      source: ctx.source,
      options: ctx.options,
      save: async (input) => {
        const result = await window.mdforge.styleSave(input)
        if (!result.ok) return result.error.message
        ctx.setLibrary(result.value.library)
        choose(customRefOf(result.value.id))
        ctx.notify(
          `已创建${labelOf(spec.kind)}「${findName(result.value.library, input.kind, result.value.id)}」并设为当前`
        )
        render()
        return null
      }
    })
  }

  /** 新建空白条目 */
  function createStyle(): void {
    openStyleEditor({
      kind: tab,
      id: null,
      name: '',
      content: '',
      source: ctx.source,
      options: ctx.options,
      save: async (input) => {
        const result = await window.mdforge.styleSave(input)
        if (!result.ok) return result.error.message
        ctx.setLibrary(result.value.library)
        choose(customRefOf(result.value.id))
        ctx.notify(`已创建${labelOf(tab)}「${findName(result.value.library, tab, result.value.id)}」并设为当前`)
        render()
        return null
      }
    })
  }

  function editStyle(spec: RowSpec): void {
    const id = spec.id ?? ''
    const item =
      spec.kind === 'theme'
        ? ctx.library().themes.find((entry) => entry.id === id)
        : ctx.library().templates.find((entry) => entry.id === id)
    if (!item) {
      ctx.notify('这个条目已经不在了')
      render()
      return
    }
    openStyleEditor({
      kind: spec.kind,
      id,
      name: item.name,
      content: spec.kind === 'theme' ? (item as { css: string }).css : (item as { html: string }).html,
      source: ctx.source,
      options: ctx.options,
      save: async (input) => {
        const result = await window.mdforge.styleSave(input)
        if (!result.ok) return result.error.message
        ctx.setLibrary(result.value.library)
        ctx.notify(`已保存${labelOf(spec.kind)}「${findName(result.value.library, input.kind, result.value.id)}」`)
        render()
        return null
      }
    })
  }

  async function exportStyle(spec: RowSpec): Promise<void> {
    if (spec.id === null) return
    const result = await window.mdforge.styleExport(spec.kind, spec.id)
    if (!result.ok) {
      ctx.notify(result.error.message)
      return
    }
    if (result.value === null) return
    ctx.notify(`已导出：${result.value}`)
  }

  async function removeStyle(spec: RowSpec): Promise<void> {
    if (spec.id === null) return
    const choice = await askDialog<'delete' | 'cancel'>({
      title: `删除${labelOf(spec.kind)}`,
      body: `删除「${spec.name}」？`,
      note: '删除后导出选项里不再能选到它，文件也会从用户目录移除。',
      options: [
        { label: '删除', value: 'delete', kind: 'danger' },
        { label: '取消', value: 'cancel' }
      ] as DialogOption<'delete' | 'cancel'>[],
      cancelValue: 'cancel'
    })
    if (choice !== 'delete') return
    const result = await window.mdforge.styleDelete(spec.kind, spec.id)
    if (!result.ok) {
      ctx.notify(result.error.message)
      return
    }
    ctx.setLibrary(result.value)
    if (customIdOf(ctx.currentTheme()) === spec.id) ctx.chooseTheme('default')
    if (customIdOf(ctx.currentTemplate()) === spec.id) ctx.chooseTemplate('builtin')
    ctx.notify(`已删除${labelOf(spec.kind)}「${spec.name}」`)
    render()
  }

  async function importStyle(): Promise<void> {
    const result = await window.mdforge.styleImport(tab)
    if (!result.ok) {
      ctx.notify(result.error.message)
      return
    }
    if (result.value === null) return
    ctx.setLibrary(result.value.library)
    choose(customRefOf(result.value.id))
    ctx.notify(`已导入并设为当前：${labelOf(tab)}「${result.value.name}」`)
  }

  function render(): void {
    for (const [kind, element] of tabButtons) element.classList.toggle('is-active', kind === tab)

    list.replaceChildren(...rows().map(rowElement))

    actions.replaceChildren(
      button(tab === 'theme' ? '新建主题…' : '新建模板…', 'style-create', createStyle),
      button(tab === 'theme' ? '导入主题…' : '导入模板…', 'style-import', () => void importStyle())
    )

    note.textContent =
      tab === 'theme'
        ? '主题是导出页的排版 CSS，排在基础样式之后；代码高亮可在“导出选项 → 代码高亮”里另选。'
        : '模板决定导出 HTML 的外壳（页眉、页脚、自己的样式），正文放进 {{content}} 占位符。'
  }

  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) finish()
  })

  backdrop.appendChild(panel)
  document.body.appendChild(backdrop)
  dialogStackPush(backdrop)
  document.addEventListener('keydown', onKey, true)

  render()
  panel.focus()
}

function labelOf(kind: CustomStyleKind): string {
  return kind === 'theme' ? '主题' : '模板'
}

function findName(library: CustomStyleLibrary, kind: CustomStyleKind, id: string): string {
  const item = (kind === 'theme' ? library.themes : library.templates).find((entry) => entry.id === id)
  return item?.name ?? ''
}
