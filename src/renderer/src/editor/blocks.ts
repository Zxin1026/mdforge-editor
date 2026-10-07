import { EditorView, WidgetType } from '@codemirror/view'
import katex from 'katex'
import { renderCellInline } from './cell-inline'
import { setFrontMatterCollapsed } from './frontmatter'
import { openLightbox } from './lightbox'
import { renderMermaid } from './mermaid'
import { writeImageWidth } from './image-size'
import { parseTable, type TableModel } from './table'
import { openCellEditor } from './table-edit'
import type { EditorTheme } from './theme-runtime'

export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly width: number | null,
    readonly from: number,
    readonly to: number
  ) {
    super()
  }

  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.width === this.width && other.from === this.from && other.to === this.to
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'mdf-image-preview'

    const img = document.createElement('img')
    img.src = this.src
    img.alt = this.alt
    img.className = 'mdf-preview-img'
    img.draggable = false
    if (this.width !== null) img.style.width = `${this.width}px`
    img.addEventListener('error', () => {
      img.className = 'mdf-preview-missing'
      img.title = '图片无法显示'
    })
    img.addEventListener('click', () => openLightbox(this.src, this.alt || this.src))
    // 预览只在光标离开本行时出现，点击不会与放置光标冲突
    img.addEventListener('mousedown', (event) => event.preventDefault())

    wrap.appendChild(img)
    wrap.appendChild(makeResizeHandle(img, this.width, (width) => writeImageWidth(view, this.from, this.to, width)))
    return wrap
  }

  override get estimatedHeight(): number {
    return 220
  }
}

function currentWidth(img: HTMLImageElement, fallback: number | null): number {
  // 刚重建的 img 可能还没量出宽度，退回原图宽度或已提交的宽度，避免拖拽基准取到 0
  return Math.round(img.getBoundingClientRect().width || img.naturalWidth || fallback || 0)
}

function restore(img: HTMLImageElement, width: number | null): void {
  img.style.width = width === null ? '' : `${width}px`
}

/**
 * 右下角手柄拖拽调宽：拖动过程中只改样式，松手才写回源文本，
 * 否则一次拖拽会产生上百个事务，撤销栈与脏标记都会失控。
 */
function makeResizeHandle(
  img: HTMLImageElement,
  committed: number | null,
  commit: (width: number) => boolean
): HTMLElement {
  const grip = document.createElement('span')
  grip.className = 'mdf-resize-grip'
  grip.title = '拖动调整图片宽度'

  grip.addEventListener('mousedown', (down) => {
    down.preventDefault()
    down.stopPropagation()

    const start = down.clientX
    const from = currentWidth(img, committed)
    const max = Math.max(from, img.naturalWidth || 0)
    let latest = from

    const move = (event: MouseEvent) => {
      latest = Math.min(Math.max(48, Math.round(from + event.clientX - start)), max)
      img.style.width = `${latest}px`
    }
    const up = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      if (Math.abs(latest - from) < 4 || !commit(latest)) restore(img, committed)
    }

    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  })

  return grip
}

/** 公式渲染失败时把 KaTeX 的消息原样显示，便于用户改源码 */
function renderKatex(target: HTMLElement, source: string, displayMode: boolean): void {
  try {
    target.innerHTML = katex.renderToString(source, { displayMode, throwOnError: false, output: 'html' })
  } catch (error) {
    target.textContent = error instanceof Error ? error.message : String(error)
  }
}

export class MathBlockWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly display: boolean
  ) {
    super()
  }

  override eq(other: MathBlockWidget): boolean {
    return other.source === this.source && other.display === this.display
  }

  override toDOM(): HTMLElement {
    const box = document.createElement('div')
    box.className = 'mdf-math-block'
    renderKatex(box, this.source, this.display)
    return box
  }

  override get estimatedHeight(): number {
    return 56
  }
}

export class MathInlineWidget extends WidgetType {
  constructor(readonly source: string) {
    super()
  }

  override eq(other: MathInlineWidget): boolean {
    return other.source === this.source
  }

  override toDOM(): HTMLElement {
    const box = document.createElement('span')
    box.className = 'mdf-math-inline'
    renderKatex(box, this.source, false)
    return box
  }
}

export class MermaidWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly theme: EditorTheme
  ) {
    super()
  }

  override eq(other: MermaidWidget): boolean {
    // 主题也算图的一部分：深浅切换后必须按新配色重画
    return other.source === this.source && other.theme === this.theme
  }

  override toDOM(): HTMLElement {
    const box = document.createElement('div')
    box.className = 'mdf-mermaid'
    box.textContent = '正在渲染图表…'

    renderMermaid(this.source)
      .then((svg) => {
        if (!box.isConnected) return
        box.className = 'mdf-mermaid'
        box.innerHTML = svg
      })
      .catch((error: unknown) => {
        if (!box.isConnected) return
        box.className = 'mdf-mermaid is-error'
        box.textContent = `图表渲染失败：${error instanceof Error ? error.message : String(error)}`
      })
    return box
  }

  override get estimatedHeight(): number {
    return 260
  }
}

export class TableGridWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly nodeFrom: number,
    readonly nodeTo: number
  ) {
    super()
  }

  override eq(other: TableGridWidget): boolean {
    return other.source === this.source && other.nodeFrom === this.nodeFrom && other.nodeTo === this.nodeTo
  }

  override toDOM(view: EditorView): HTMLElement {
    const model = parseTable(this.source)
    if (!model) {
      const box = document.createElement('div')
      box.className = 'mdf-table-grid is-error'
      box.textContent = '表格格式无法解析'
      return box
    }
    const table = buildTable(model)
    // 点单元格就地编辑：widget 默认忽略内部事件，点击不会挪动 CodeMirror 的光标
    table.addEventListener('click', (event) => {
      const cell = (event.target as HTMLElement | null)?.closest('th, td')
      if (!(cell instanceof HTMLElement)) return
      openCellEditor(view, cell, {
        source: this.source,
        nodeFrom: this.nodeFrom,
        row: Number(cell.dataset.row ?? '-1'),
        col: Number(cell.dataset.col ?? '0')
      })
    })
    return table
  }

  override get estimatedHeight(): number {
    return 34 * (this.source.split('\n').length - 1) + 8
  }
}

const ALIGN_STYLE: Record<string, string> = {
  left: 'left',
  center: 'center',
  right: 'right'
}

function buildTable(model: TableModel): HTMLElement {
  const table = document.createElement('table')
  table.className = 'mdf-table-grid'

  const head = table.createTHead().insertRow()
  model.header.forEach((cell, col) => {
    const th = document.createElement('th')
    renderCellInline(th, cell)
    th.dataset.row = '-1'
    th.dataset.col = String(col)
    head.appendChild(th)
  })

  const body = table.createTBody()
  model.rows.forEach((row, index) => {
    const tr = body.insertRow()
    for (const [col, cell] of row.entries()) {
      const td = document.createElement('td')
      renderCellInline(td, cell)
      td.dataset.row = String(index)
      td.dataset.col = String(col)
      const align = ALIGN_STYLE[model.aligns[col] ?? '']
      if (align) td.style.textAlign = align
      tr.appendChild(td)
    }
  })
  return table
}

/** front matter 的折叠/展开开关：折叠时占满整块，展开时只是行尾的一个小按钮 */
export class FrontMatterWidget extends WidgetType {
  constructor(
    readonly lines: number,
    readonly collapsed: boolean,
    readonly from: number,
    readonly to: number
  ) {
    super()
  }

  override eq(other: FrontMatterWidget): boolean {
    return (
      other.lines === this.lines &&
      other.collapsed === this.collapsed &&
      other.from === this.from &&
      other.to === this.to
    )
  }

  override toDOM(view: EditorView): HTMLElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = this.collapsed ? 'mdf-fm-collapsed' : 'mdf-fm-toggle'
    button.textContent = this.collapsed ? `front matter · ${this.lines} 行 · 点击展开` : '折叠 front matter'
    button.title = this.collapsed ? '展开 front matter' : '折叠 front matter'
    button.addEventListener('mousedown', (event) => event.stopPropagation())
    button.addEventListener('click', (event) => {
      event.preventDefault()
      const collapse = !this.collapsed
      // 折叠后把光标挪到块外，否则"光标在块内就展开"的规则会立刻把它顶回去
      const anchor = collapse ? Math.min(this.to + 1, view.state.doc.length) : this.from
      view.dispatch({
        effects: setFrontMatterCollapsed.of(collapse),
        selection: { anchor },
        userEvent: 'select'
      })
    })
    return button
  }

  override ignoreEvent(): boolean {
    return false
  }
}

export class TaskWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number
  ) {
    super()
  }

  override eq(other: TaskWidget): boolean {
    return other.checked === this.checked && other.pos === this.pos
  }

  override toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = this.checked
    box.className = 'mdf-task-box'
    // 不拦住 mousedown 的话，CodeMirror 会把光标移进这一行，widget 当场被原始 [x] 文本替换
    box.addEventListener('mousedown', (event) => event.stopPropagation())
    box.addEventListener('keydown', (event) => event.stopPropagation())
    box.addEventListener('change', () => {
      const marker = box.checked ? '[x]' : '[ ]'
      if (!TASK_MARK.test(view.state.sliceDoc(this.pos, this.pos + 3))) return
      view.dispatch({
        changes: { from: this.pos, to: this.pos + 3, insert: marker },
        userEvent: 'input'
      })
    })
    return box
  }

  override ignoreEvent(): boolean {
    return false
  }
}

const TASK_MARK = /^\[[ xX]\]$/
