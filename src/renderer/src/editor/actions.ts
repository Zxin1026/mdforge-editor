import { deleteLine, moveLineDown, moveLineUp, redo, redoDepth, selectAll, undo, undoDepth } from '@codemirror/commands'
import { findNext, findPrevious, openSearchPanel, replaceAll } from '@codemirror/search'
import type { EditorView } from '@codemirror/view'
import { renderBody } from '../export/html'
import { openFrontMatterEditor } from '../frontmatter-dialog'
import { boldCmd, codeBlockCmd, headingCmd, headingLevelCmd, inlineCodeCmd, italicCmd, listCmd, quoteCmd, strikeCmd, tableCmd, taskToggleCmd } from './commands'
import { htmlToMarkdown } from './rich-paste'

/**
 * 菜单要触发的编辑器动作。键盘快捷键仍走各自的 keymap，
 * 这里只是同一批命令的"可从菜单调用"入口。
 */
export type EditorAction =
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'deleteSelection'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'inlineCode'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'heading4'
  | 'heading5'
  | 'heading6'
  | 'body'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'quote'
  | 'table'
  | 'codeBlock'
  | 'toggleTask'
  | 'headingUp'
  | 'headingDown'
  | 'moveLineUp'
  | 'moveLineDown'
  | 'deleteLine'
  | 'find'
  | 'replace'
  | 'findNext'
  | 'findPrevious'
  | 'replaceAll'
  | 'frontMatter'

export interface EditorFacts {
  canUndo: boolean
  canRedo: boolean
  hasSelection: boolean
}

function selectedText(view: EditorView): string {
  const { state } = view
  const parts: string[] = []
  for (const range of state.selection.ranges) {
    if (!range.empty) parts.push(state.sliceDoc(range.from, range.to))
  }
  return parts.join('\n')
}

/** 面板刚打开时焦点在主输入框，替换行要单独点过去 */
function focusField(view: EditorView, name: 'search' | 'replace'): void {
  const field = view.dom.querySelector<HTMLInputElement>(`.cm-panel.cm-search input[name="${name}"]`)
  field?.focus()
  field?.select()
}

/** 剪贴板走主进程：从菜单点进来时焦点在菜单上，浏览器原生命令不会作用到选区 */
function dispatchWhenAlive(view: EditorView, build: () => Parameters<EditorView['dispatch']>[0]): void {
  if (!view.dom.isConnected) return
  view.dispatch(build())
}

/** 复制/剪切写剪贴板：Markdown 先渲染成 HTML 一起写（粘到 Word / 微信不丢表格与强调），失败退回纯文本 */
async function writeRichSelection(text: string): Promise<void> {
  try {
    const html = await renderBody(text)
    if (await window.mdforge.clipboardWriteHtml(html, text)) return
  } catch {
    /* 富文本准备失败就退回纯文本 */
  }
  await window.mdforge.clipboardWriteText(text)
}

const runners: Record<EditorAction, (view: EditorView) => boolean> = {
  undo: (view) => undo(view),
  redo: (view) => redo(view),
  selectAll: (view) => selectAll(view),
  copy: (view) => {
    const text = selectedText(view)
    if (text === '') return false
    void writeRichSelection(text)
    return true
  },
  cut: (view) => {
    const text = selectedText(view)
    if (text === '') return false
    view.dispatch(view.state.replaceSelection(''), { userEvent: 'delete' })
    void writeRichSelection(text)
    return true
  },
  paste: (view) => {
    // 与编辑器里的 Ctrl+V 同一条路子：有 HTML 就先转 Markdown，没有才用纯文本
    void Promise.all([window.mdforge.clipboardReadHtml(), window.mdforge.clipboardReadText()]).then(([html, text]) => {
      const insert = (html.trim() === '' ? null : htmlToMarkdown(html)) ?? text
      if (insert === '') return
      dispatchWhenAlive(view, () => view.state.replaceSelection(insert))
    })
    return true
  },
  deleteSelection: (view) => {
    if (view.state.selection.ranges.every((range) => range.empty)) return false
    view.dispatch(view.state.replaceSelection(''), { userEvent: 'delete' })
    return true
  },
  bold: (view) => boldCmd(view),
  italic: (view) => italicCmd(view),
  strike: (view) => strikeCmd(view),
  inlineCode: (view) => inlineCodeCmd(view),
  heading1: (view) => headingCmd(1)(view),
  heading2: (view) => headingCmd(2)(view),
  heading3: (view) => headingCmd(3)(view),
  heading4: (view) => headingCmd(4)(view),
  heading5: (view) => headingCmd(5)(view),
  heading6: (view) => headingCmd(6)(view),
  body: (view) => headingCmd(0)(view),
  bulletList: (view) => listCmd('bullet')(view),
  orderedList: (view) => listCmd('ordered')(view),
  taskList: (view) => listCmd('task')(view),
  quote: (view) => quoteCmd(view),
  table: (view) => tableCmd(view),
  codeBlock: (view) => codeBlockCmd(view),
  toggleTask: (view) => taskToggleCmd(view),
  headingUp: (view) => headingLevelCmd(-1)(view),
  headingDown: (view) => headingLevelCmd(1)(view),
  moveLineUp: (view) => {
    const moved = moveLineUp(view)
    // 菜单点完不还焦点给编辑器，方向键会继续开着菜单
    if (moved) view.focus()
    return moved
  },
  moveLineDown: (view) => {
    const moved = moveLineDown(view)
    if (moved) view.focus()
    return moved
  },
  deleteLine: (view) => deleteLine(view),
  find: (view) => {
    openSearchPanel(view)
    focusField(view, 'search')
    return true
  },
  replace: (view) => {
    openSearchPanel(view)
    focusField(view, 'replace')
    return true
  },
  findNext: (view) => findNext(view),
  findPrevious: (view) => findPrevious(view),
  replaceAll: (view) => replaceAll(view),
  frontMatter: (view) => {
    void openFrontMatterEditor(view)
    return true
  }
}

export function runEditorAction(view: EditorView, action: EditorAction): boolean {
  return runners[action](view)
}

/**
 * 键位表（keybindings.ts）里编辑器级命令的运行时实现：
 * 命令 id → CodeMirror 命令，view.ts 组装 keymap 时按当前绑定取用。
 */
export const EDITOR_KEY_COMMANDS: Record<string, (view: EditorView) => boolean> = {
  bold: boldCmd,
  italic: italicCmd,
  strike: strikeCmd,
  inlineCode: inlineCodeCmd,
  heading1: headingCmd(1),
  heading2: headingCmd(2),
  heading3: headingCmd(3),
  heading4: headingCmd(4),
  heading5: headingCmd(5),
  heading6: headingCmd(6),
  body: headingCmd(0),
  bulletList: listCmd('bullet'),
  orderedList: listCmd('ordered'),
  taskList: listCmd('task'),
  quote: quoteCmd,
  table: tableCmd,
  codeBlock: codeBlockCmd,
  toggleTask: taskToggleCmd,
  headingUp: headingLevelCmd(-1),
  headingDown: headingLevelCmd(1),
  moveLineUp: moveLineUp,
  moveLineDown: moveLineDown,
  find: (view) => runEditorAction(view, 'find'),
  replace: (view) => runEditorAction(view, 'replace'),
  findNext: findNext,
  findPrevious: findPrevious
}

export function editorFacts(view: EditorView): EditorFacts {
  return {
    canUndo: undoDepth(view.state) > 0,
    canRedo: redoDepth(view.state) > 0,
    hasSelection: view.state.selection.ranges.some((range) => !range.empty)
  }
}
