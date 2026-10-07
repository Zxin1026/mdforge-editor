/**
 * 表格单元格就地编辑：点网格里的单元格，浮出一个与它等大的文本框，
 * Enter / 失焦提交（按行重写回源码），Esc 取消。
 * 用 textarea 而不是 contenteditable：中文输入法的组合态走浏览器原生路径，不和 CodeMirror 打架；
 * 单元格里的换行不属于 GFM 表格语法，所以 Enter 一律当提交，不插入换行。
 */
import type { EditorView } from '@codemirror/view'
import { buildRowLine, parseTable, sourceLineSpans } from './table'

export interface CellEditContext {
  /** 表格节点的源码与在文档中的起点 */
  source: string
  nodeFrom: number
  /** 数据行索引；-1 表示表头行 */
  row: number
  col: number
}

interface OpenEditor {
  input: HTMLTextAreaElement
  finish: (commit: boolean) => void
}

let current: OpenEditor | null = null

/** 主动收起当前编辑框（提交或丢弃）；点击其他单元格、切换文档等场景由调用方触发 */
export function closeCellEditor(commit = true): void {
  current?.finish(commit)
}

export function openCellEditor(view: EditorView, cell: HTMLElement, context: CellEditContext): void {
  current?.finish(true)

  const model = parseTable(context.source)
  if (!model) return
  const cells = context.row < 0 ? model.header : model.rows[context.row]
  if (!cells || context.col < 0 || context.col >= cells.length) return
  const original = cells[context.col] ?? ''

  const rect = cell.getBoundingClientRect()
  const computed = getComputedStyle(cell)
  const table = cell.closest('table')
  const background = computed.backgroundColor
  const transparent = background === 'rgba(0, 0, 0, 0)' || background === 'transparent'

  // 用与单元格等大的 textarea：长文本同宽折行，编辑时看起来就是单元格原样；
  // 单行 input 会把折行文本截成"高盒子里一行字"，所以不用它
  const input = document.createElement('textarea')
  input.className = 'mdf-table-edit'
  input.value = original
  input.wrap = 'soft'
  input.spellcheck = false
  input.setAttribute('aria-label', '编辑单元格')
  Object.assign(input.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    font: computed.font,
    lineHeight: computed.lineHeight,
    padding: computed.padding,
    textAlign: computed.textAlign,
    color: computed.color,
    background: transparent ? (table ? getComputedStyle(table).backgroundColor : '') : background
  })
  document.body.appendChild(input)

  const finish = (commit: boolean): void => {
    if (current?.input !== input) return
    current = null
    input.removeEventListener('keydown', onKey)
    input.removeEventListener('blur', onBlur)
    view.scrollDOM.removeEventListener('scroll', onFollow)
    window.removeEventListener('resize', onFollow)
    input.remove()

    const next = input.value.trim()
    if (commit && next !== original && view.dom.isConnected) {
      const nextCells = cells.slice()
      nextCells[context.col] = next
      const span = sourceLineSpans(context.source)[context.row < 0 ? 0 : context.row + 2]
      if (span) {
        const from = context.nodeFrom + span.from
        const to = context.nodeFrom + span.to
        // 输入期间文档可能被外部改动：区间对不上就放弃提交，避免写错位置
        if (view.state.sliceDoc(from, to) === span.text) {
          view.dispatch({ changes: { from, to, insert: buildRowLine(nextCells) }, userEvent: 'input' })
        }
      }
    }
    view.focus()
  }

  /**
   * 滚动/改尺寸时让输入框跟着单元格走，而不是立刻关闭：
   * CodeMirror 在点击后可能因布局度量产生一次滚动，直接关闭会把刚打开的输入框秒关。
   * 单元格被重建或滚出视口才收手（提交）。
   */
  const follow = (): void => {
    if (!cell.isConnected) {
      finish(true)
      return
    }
    const box = cell.getBoundingClientRect()
    if (box.width === 0 || box.bottom < 0 || box.top > window.innerHeight) {
      finish(true)
      return
    }
    input.style.left = `${box.left}px`
    input.style.top = `${box.top}px`
    input.style.width = `${box.width}px`
    input.style.height = `${box.height}px`
  }

  const onKey = (event: KeyboardEvent): void => {
    if (event.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      finish(true)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      finish(false)
    }
  }
  const onBlur = (): void => finish(true)
  const onFollow = (): void => follow()

  input.addEventListener('keydown', onKey)
  input.addEventListener('blur', onBlur)
  view.scrollDOM.addEventListener('scroll', onFollow)
  window.addEventListener('resize', onFollow)

  current = { input, finish }
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
}
