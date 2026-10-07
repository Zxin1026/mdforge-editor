import { StateEffect, StateField, type EditorState, type Range } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet, type WidgetType } from '@codemirror/view'
import {
  FrontMatterWidget,
  ImageWidget,
  MathBlockWidget,
  MathInlineWidget,
  MermaidWidget,
  TableGridWidget,
  TaskWidget
} from './blocks'
import { docPathOf, setDocPath } from './doc-path'
import { frontMatterCollapsed } from './frontmatter'
import { CompositionTracker } from './ime'
import { collectMarks, type MarkRange } from './marks'
import { currentTheme } from './theme-runtime'

export const compositionStart = StateEffect.define<null>()
export const compositionEnd = StateEffect.define<null>()
export const compositionReset = StateEffect.define<null>()
/** 深浅色切换：图片之外还有 mermaid 这类按主题渲染的块，要重建装饰集才会重画 */
export const themeChanged = StateEffect.define<null>()

export const compositionField = StateField.define<CompositionTracker>({
  create: () => new CompositionTracker(),
  update(tracker, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(compositionStart)) tracker.start()
      else if (effect.is(compositionEnd)) tracker.end()
      else if (effect.is(compositionReset)) tracker.reset()
    }
    return tracker
  }
})

function buildWidget(range: MarkRange): WidgetType {
  switch (range.widget) {
    case 'task':
      return new TaskWidget(range.checked === true, range.from)
    case 'math-block':
      return new MathBlockWidget(range.content ?? '', true)
    case 'math-inline':
      return new MathInlineWidget(range.content ?? '')
    case 'mermaid':
      return new MermaidWidget(range.content ?? '', currentTheme())
    case 'table':
      return new TableGridWidget(range.content ?? '', range.nodeFrom ?? range.from, range.nodeTo ?? range.to)
    case 'front-matter':
      return new FrontMatterWidget(
        range.lines ?? 0,
        range.collapsed === true,
        range.nodeFrom ?? range.from,
        range.nodeTo ?? range.to
      )
    default:
      return new ImageWidget(
        range.src ?? '',
        range.alt ?? '',
        range.width ?? null,
        range.nodeFrom ?? range.from,
        range.nodeTo ?? range.to
      )
  }
}

function toDecoration(range: MarkRange): Range<Decoration> {
  switch (range.type) {
    case 'line':
      // 行装饰要求零宽区间，传整行范围会让整个 Decoration.set 构建失败
      return Decoration.line({ class: range.cls }).range(range.from)
    case 'widget': {
      const widget = buildWidget(range)
      if (range.widget === 'front-matter') {
        return range.collapsed
          ? Decoration.replace({ widget }).range(range.from, range.to)
          : Decoration.widget({ widget, side: -1 }).range(range.to)
      }
      if (range.block) {
        return Decoration.widget({ widget, block: true, side: 1 }).range(range.from)
      }
      return Decoration.replace({ widget }).range(range.from, range.to)
    }
    case 'hide':
      return Decoration.replace({}).range(range.from, range.to)
    default:
      return Decoration.mark({ class: range.cls, inclusive: false }).range(range.from, range.to)
  }
}

function build(state: EditorState): DecorationSet {
  const selection = state.selection.ranges.map((range) => ({ from: range.from, to: range.to }))
  const ranges = collectMarks(state, selection, docPathOf(state))
  return Decoration.set(ranges.map(toDecoration), true)
}

/**
 * 块级 widget 只能由 StateField 提供，ViewPlugin 会被 CodeMirror 直接拒绝
 * （"Block decorations may not be specified via plugins"）。
 */
export const markdownDecorations = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update(value, transaction) {
    const tracker = transaction.state.field(compositionField)
    if (tracker.composing) return value

    let pathChanged = false
    let compositionSettled = false
    let themeSwitched = false
    for (const effect of transaction.effects) {
      if (effect.is(setDocPath)) pathChanged = true
      else if (effect.is(compositionEnd) || effect.is(compositionReset)) compositionSettled = true
      else if (effect.is(themeChanged)) themeSwitched = true
    }
    const foldChanged =
      transaction.state.field(frontMatterCollapsed) !== transaction.startState.field(frontMatterCollapsed)

    if (
      transaction.docChanged ||
      transaction.selection ||
      pathChanged ||
      compositionSettled ||
      themeSwitched ||
      foldChanged
    ) {
      return build(transaction.state)
    }
    return value
  },
  provide: (field) => EditorView.decorations.from(field)
})

export const compositionEvents = EditorView.domEventHandlers({
  compositionstart: (_event, view) => {
    view.dispatch({ effects: compositionStart.of(null) })
  },
  compositionend: (_event, view) => {
    view.dispatch({ effects: compositionEnd.of(null) })
  },
  blur: (_event, view) => {
    view.dispatch({ effects: compositionReset.of(null) })
  }
})
