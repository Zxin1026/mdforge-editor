/**
 * 主题 / 页面模板编辑器：名称 + 代码区 + 实时预览。
 * 左边改 CSS/HTML，右边 iframe 用真实导出管线重渲染当前文档（没有文档时用示例）。
 */

import type { CustomStyleKind, ExportOptions } from '../../shared/ipc'
import { dialogStackPush, dialogStackRemove, dialogStackTop } from './dialog'
import { cssFor } from './export/export-css'
import { buildHtml } from './export/html'
import { TEMPLATE_PLACEHOLDER_HINT, templateProblem } from './export/page-template'
import { rewritePreviewImages } from './split-preview'

export interface StyleEditorSpec {
  kind: CustomStyleKind
  /** null 表示新建 */
  id: string | null
  name: string
  /** 主题为 CSS，模板为 HTML */
  content: string
  /** 预览与标题的来源：当前文档；返回 null 时用内置示例 */
  source(): { text: string; title: string; path: string | null } | null
  /** 预览用的导出选项（纸张、边距、高亮主题等） */
  options(): ExportOptions
  /** 保存：返回错误文本则留在框里并把错误显示在底部 */
  save(input: { kind: CustomStyleKind; id: string | null; name: string; content: string }): Promise<string | null>
}

const SAMPLE_MARKDOWN = [
  '# 示例文档',
  '',
  '右侧是真实导出管线的渲染结果，左边改动会立刻反映过来。',
  '',
  '## 行内样式',
  '',
  '正文里的 **加粗**、*斜体*、[链接](https://example.com)与行内代码 `inline()`。',
  '',
  '> 引用块与表格的配色最能看出主题的差别。',
  '',
  '| 列 | 值 |',
  '| --- | --- |',
  '| 甲 | 1 |',
  '| 乙 | 2 |',
  '',
  '- 列表项一',
  '- 列表项二',
  '',
  '```js',
  'function greet(name) {',
  '  // 注释与字符串会走高亮主题',
  "  return 'hello ' + name",
  '}',
  '```',
  '',
  '---',
  '',
  '结尾段落。'
].join('\n')

function previewFallback(): string {
  return '<!doctype html><meta charset="utf-8"><body style="margin:0;padding:16px;font:13px Microsoft YaHei,sans-serif;color:#888">预览渲染失败，内容仍可保存。</body>'
}

export function openStyleEditor(spec: StyleEditorSpec): void {
  const isTheme = spec.kind === 'theme'
  const kindName = isTheme ? '导出主题' : '页面模板'
  const title = `${spec.id === null ? '新建' : '编辑'}${kindName}`

  const backdrop = document.createElement('div')
  backdrop.className = 'mdf-dialog-backdrop'

  const panel = document.createElement('div')
  panel.className = 'mdf-dialog mdf-style-editor'
  panel.tabIndex = -1
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-label', title)

  const head = document.createElement('div')
  head.className = 'mdf-dialog-title'
  head.textContent = title
  panel.appendChild(head)

  const grid = document.createElement('div')
  grid.className = 'mdf-style-editor-grid'

  const left = document.createElement('div')
  left.className = 'mdf-style-editor-left'

  const nameRow = document.createElement('label')
  nameRow.className = 'mdf-form-row'
  const nameLabel = document.createElement('span')
  nameLabel.className = 'mdf-form-label'
  nameLabel.textContent = '名称'
  const nameInput = document.createElement('input')
  nameInput.type = 'text'
  nameInput.className = 'mdf-form-input'
  nameInput.dataset.field = 'style-name'
  nameInput.placeholder = isTheme ? '例如：夜航星' : '例如：带页脚的壳'
  nameInput.value = spec.name
  nameInput.spellcheck = false
  nameRow.append(nameLabel, nameInput)
  left.appendChild(nameRow)

  const codeArea = document.createElement('textarea')
  codeArea.className = 'mdf-style-code'
  codeArea.dataset.field = isTheme ? 'style-css' : 'style-html'
  codeArea.spellcheck = false
  codeArea.wrap = 'off'
  codeArea.value = spec.content
  codeArea.setAttribute('aria-label', isTheme ? '主题 CSS' : '模板 HTML')
  left.appendChild(codeArea)

  const error = document.createElement('div')
  error.className = 'mdf-form-error'
  error.hidden = true
  left.appendChild(error)

  if (!isTheme) {
    const hint = document.createElement('div')
    hint.className = 'mdf-dialog-note'
    hint.textContent = `占位符：${TEMPLATE_PLACEHOLDER_HINT}；正文会以 <article class="mdf-doc"> 的形式放进 {{content}}。`
    left.appendChild(hint)
  }

  const right = document.createElement('div')
  right.className = 'mdf-style-editor-preview'
  const frame = document.createElement('iframe')
  frame.className = 'mdf-style-preview-frame'
  frame.setAttribute('title', '样式预览')
  right.appendChild(frame)

  grid.append(left, right)
  panel.appendChild(grid)

  const footer = document.createElement('div')
  footer.className = 'mdf-dialog-footer'

  let settled = false
  let previewTimer: number | undefined
  let previewSeq = 0

  function finish(): void {
    if (settled) return
    settled = true
    if (previewTimer !== undefined) window.clearTimeout(previewTimer)
    document.removeEventListener('keydown', onKey, true)
    dialogStackRemove(backdrop)
    backdrop.remove()
  }

  async function renderPreview(): Promise<void> {
    const current = ++previewSeq
    const source = spec.source() ?? { text: SAMPLE_MARKDOWN, title: '示例文档', path: null }
    const options = spec.options()
    const preview = isTheme
      ? { themeCss: cssFor('custom:preview', { custom: codeArea.value, highlight: options.highlight }) }
      : { templateHtml: codeArea.value }
    try {
      const html = await buildHtml(source.text, source.title, options, { preview })
      if (current !== previewSeq) return
      frame.srcdoc = rewritePreviewImages(html, source.path)
    } catch {
      if (current !== previewSeq) return
      frame.srcdoc = previewFallback()
    }
  }

  function schedulePreview(): void {
    if (previewTimer !== undefined) window.clearTimeout(previewTimer)
    previewTimer = window.setTimeout(() => {
      previewTimer = undefined
      void renderPreview()
    }, 260)
  }

  function showError(text: string | null): void {
    error.hidden = text === null
    error.textContent = text ?? ''
  }

  async function submit(): Promise<void> {
    const content = codeArea.value
    if (content.trim() === '') {
      showError(isTheme ? '主题 CSS 不能为空' : '模板内容不能为空')
      return
    }
    if (!isTheme) {
      const problem = templateProblem(content)
      if (problem !== null) {
        showError(problem)
        return
      }
    }
    showError(null)
    confirmButton.disabled = true
    const problem = await spec.save({
      kind: spec.kind,
      id: spec.id,
      name: nameInput.value,
      content
    })
    confirmButton.disabled = false
    if (problem === null) finish()
    else showError(problem)
  }

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'mdf-dialog-button is-plain'
  cancel.textContent = '取消'
  cancel.addEventListener('click', finish)
  footer.appendChild(cancel)

  const confirmButton = document.createElement('button')
  confirmButton.type = 'button'
  confirmButton.className = 'mdf-dialog-button is-default'
  confirmButton.textContent = '保存'
  confirmButton.dataset.action = 'style-save'
  confirmButton.addEventListener('click', () => void submit())
  footer.appendChild(confirmButton)
  panel.appendChild(footer)

  function onKey(event: KeyboardEvent): void {
    if (dialogStackTop() !== backdrop) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      finish()
      return
    }
    // 编辑区里的回车是换行，别把 Ctrl+Enter 之类误当提交
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void submit()
    }
  }

  codeArea.addEventListener('input', schedulePreview)
  nameInput.addEventListener('input', schedulePreview)
  // 名称框里回车即保存，与表单对话框的习惯一致
  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
      event.preventDefault()
      void submit()
    }
  })

  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) finish()
  })

  backdrop.appendChild(panel)
  document.body.appendChild(backdrop)
  dialogStackPush(backdrop)
  document.addEventListener('keydown', onKey, true)

  codeArea.focus()
  void renderPreview()
}
