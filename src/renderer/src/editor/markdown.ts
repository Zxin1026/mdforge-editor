import { HighlightStyle } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { tags } from '@lezer/highlight'
import { GFM } from '@lezer/markdown'
import { mathSyntax } from './math'

/**
 * 编辑期语法一律用 lezer（增量解析），remark 链只服务导出与校验。
 * GFM 含表格、任务列表、删除线与自动链接；mathSyntax 补 $$ 块与 $ 行内数学。
 */
export const markdownLanguageExtension = markdown({
  base: markdownLanguage,
  codeLanguages: languages,
  extensions: [GFM, mathSyntax]
})

/**
 * defaultHighlightStyle 给标题和链接加了下划线，而标题与强调的样式已经由装饰类负责。
 * 用限定到 markdown 语言的样式覆盖它，代码块仍交给 fallback 的默认样式。
 */
export const markdownHighlight = HighlightStyle.define(
  [
    { tag: tags.heading, textDecoration: 'none' },
    { tag: tags.link, textDecoration: 'none' },
    { tag: tags.strikethrough, textDecoration: 'line-through' },
    { tag: tags.strong, fontWeight: '700' },
    { tag: tags.emphasis, fontStyle: 'italic' }
  ],
  { scope: markdownLanguage }
)
