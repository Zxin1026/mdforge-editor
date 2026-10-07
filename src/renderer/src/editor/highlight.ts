import { HighlightStyle } from '@codemirror/language'
import { tags } from '@lezer/highlight'

/**
 * 语法配色全部走 CSS 变量，深浅色切换不必重建编辑器。
 * 条目与 @codemirror/language 的 defaultHighlightStyle 一一对应，
 * 浅色变量沿用它的原值，所以浅色下的观感与换用前一致。
 * 标题/链接下划线、强调与删除线的结构样式由 markdownHighlight 与装饰类负责，这里不重复。
 */
export const themeHighlight = HighlightStyle.define([
  { tag: tags.meta, color: 'var(--mdf-syn-meta)' },
  { tag: tags.keyword, color: 'var(--mdf-syn-keyword)' },
  { tag: [tags.atom, tags.bool, tags.url, tags.contentSeparator, tags.labelName], color: 'var(--mdf-syn-atom)' },
  { tag: [tags.literal, tags.inserted], color: 'var(--mdf-syn-literal)' },
  { tag: [tags.string, tags.deleted], color: 'var(--mdf-syn-string)' },
  { tag: [tags.regexp, tags.escape, tags.special(tags.string)], color: 'var(--mdf-syn-regexp)' },
  { tag: tags.definition(tags.variableName), color: 'var(--mdf-syn-def)' },
  { tag: tags.local(tags.variableName), color: 'var(--mdf-syn-local)' },
  { tag: [tags.typeName, tags.namespace], color: 'var(--mdf-syn-type)' },
  { tag: tags.className, color: 'var(--mdf-syn-class)' },
  { tag: [tags.special(tags.variableName), tags.macroName], color: 'var(--mdf-syn-macro)' },
  { tag: tags.definition(tags.propertyName), color: 'var(--mdf-syn-defprop)' },
  { tag: tags.comment, color: 'var(--mdf-syn-comment)' },
  { tag: tags.invalid, color: 'var(--mdf-syn-invalid)' }
])
