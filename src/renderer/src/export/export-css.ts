import {
  BUILTIN_EXPORT_THEMES,
  MARGIN_MM,
  type BuiltinExportTheme,
  type ExportTheme,
  type HighlightTheme,
  type PageMargin,
  type PaperSize
} from '../../../shared/ipc'
import { highlightCss } from './highlight-css'

/** 结构样式：与主题无关，所有导出文档共用 */
const BASE_CSS = `
:root { color-scheme: light; }
html { background: #ffffff; }
body { margin: 0; font-size: 16px; line-height: 1.75; }
.mdf-doc { max-width: 860px; margin: 0 auto; padding: 48px 40px 72px; }
h1, h2, h3, h4, h5, h6 { margin: 1.6em 0 0.6em; font-weight: 600; line-height: 1.35; }
h1 { margin-top: 0; font-size: 2em; }
h2 { font-size: 1.5em; }
h3 { font-size: 1.25em; }
h4 { font-size: 1.1em; }
h5, h6 { font-size: 1em; }
p, ul, ol, blockquote, table, pre { margin: 0 0 1em; }
code, tt { padding: .15em .35em; font-family: 'Cascadia Mono', Consolas, 'Courier New', monospace; font-size: 87%; border-radius: 3px; }
pre { padding: 14px 16px; overflow: auto; border-radius: 6px; }
pre code { padding: 0; background: transparent; font-size: 92%; }
blockquote { padding: 0 1em; }
table { display: block; width: max-content; max-width: 100%; overflow: auto; border-collapse: collapse; }
th, td { padding: 6px 13px; }
th { font-weight: 600; }
img { max-width: 100%; height: auto; }
ul, ol { padding-left: 1.6em; }
li + li { margin-top: .25em; }
input[type='checkbox'] { margin-right: .4em; vertical-align: -.12em; }
hr { height: 1px; margin: 1.5em 0; border: 0; }
/* 公式与图表：行间公式可横向滚动，行内公式按整体换行（katex 排版表在用到时另行追加） */
.mdf-math-block { overflow-x: auto; }
.mdf-math-inline { display: inline-block; vertical-align: -.12em; }
.mdf-mermaid { margin: 0 0 1em; text-align: center; }
.mdf-mermaid svg { max-width: 100%; height: auto; }
/* 静态站点的页首导航：与正文同一基调，只用透明度拉开层次 */
.mdf-site-nav { max-width: 860px; margin: 0 auto; padding: 18px 40px 0; font-size: 14px; }
.mdf-site-nav a { color: inherit; opacity: .65; text-decoration: none; }
.mdf-site-nav a:hover { opacity: 1; text-decoration: underline; }
.mdf-toc { margin: 0 0 2em; font-size: 15px; }
.mdf-toc-title { margin-bottom: .4em; font-size: 13px; letter-spacing: .08em; }
.mdf-toc-list { padding-left: 1.2em; }
.mdf-toc-list li { margin: .15em 0; }
.mdf-toc-item.level-2 { margin-left: .6em; }
.mdf-toc-item.level-3 { margin-left: 1.2em; }
.mdf-toc-item.level-4 { margin-left: 1.8em; }
.mdf-toc-item.level-5, .mdf-toc-item.level-6 { margin-left: 2.4em; }
.hljs-keyword, .hljs-selector-tag, .hljs-built_in { color: #d73a49; }
.hljs-string, .hljs-regexp { color: #032f62; }
.hljs-number, .hljs-literal, .hljs-variable, .hljs-template-variable { color: #005cc5; }
.hljs-comment { color: #6a737d; font-style: italic; }
.hljs-title, .hljs-section, .hljs-function { color: #6f42c1; }
.hljs-name, .hljs-tag { color: #22863a; }
.hljs-attr, .hljs-attribute, .hljs-selector-class, .hljs-selector-id { color: #e36209; }
.hljs-symbol, .hljs-bullet { color: #e36209; }
.hljs-meta { color: #6a737d; }
.hljs-addition { color: #22863a; background: #f0fff4; }
.hljs-deletion { color: #b31d28; background: #ffeef0; }
@media print {
  .mdf-doc { max-width: none; padding: 0; }
  pre, blockquote, table, img, .mdf-toc, .mdf-math-block, .mdf-mermaid { break-inside: avoid; }
  h1, h2, h3 { break-after: avoid; }
}
`

/** 主题样式排在结构样式之后，同名属性以主题为准 */
const THEME_CSS: Record<ExportTheme, string> = {
  default: `
body { color: #24292e; font-family: -apple-system, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans CJK SC', sans-serif; }
a { color: #0b6bcb; text-decoration: none; }
a:hover { text-decoration: underline; }
h1, h2 { padding-bottom: .3em; border-bottom: 1px solid #e1e4e8; }
h5, h6 { color: #57606a; }
code { background: #f3f4f5; }
pre { background: #f6f7f8; }
blockquote { color: #57606a; border-left: 4px solid #dfe2e5; }
th, td { border: 1px solid #dfe2e5; }
th { background: #f6f7f8; }
hr { background: #e1e4e8; }
.mdf-toc-title { color: #6a737d; }
`,
  serif: `
body { color: #1f2328; font-family: Georgia, 'Times New Roman', 'Songti SC', 'STSong', 'SimSun', 'Noto Serif CJK SC', serif; font-size: 17px; line-height: 1.9; }
.mdf-doc { max-width: 46rem; }
a { color: #1f2328; text-decoration: underline; }
h1, h2, h3, h4, h5, h6 { font-weight: 700; text-align: center; }
h1 { font-size: 1.9em; }
h2 { font-size: 1.45em; }
h3 { font-size: 1.2em; }
h4, h5, h6 { font-size: 1.05em; }
p { text-align: justify; }
code { background: #f2f0ea; }
pre { background: #f7f5f0; border: 1px solid #e6e2d8; }
blockquote { color: #55514b; border-left: 3px solid #cdc7bb; }
th, td { border: 1px solid #d8d3c8; }
th { background: #f7f5f0; }
hr { background: #d8d3c8; }
.mdf-toc-title { color: #6b665f; }
`,
  plain: `
body { color: #1a1a1a; font-family: 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif; }
a { color: #1a1a1a; text-decoration: underline; }
h5, h6 { color: #444; }
code { background: #f0f0f0; }
pre { background: #f7f7f7; border: 1px dashed #c8c8c8; }
blockquote { color: #444; border-left: 3px solid #c8c8c8; }
th, td { border: 1px solid #c8c8c8; }
hr { background: #c8c8c8; }
.mdf-toc-title { color: #666; }
`,
  // 与应用深色界面同一套色阶（--mdf-* 的深色值），导出的整页保持一个明度基调
  dark: `
:root { color-scheme: dark; }
html { background: #1b1d1f; }
body { color: #d7dbde; font-family: -apple-system, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans CJK SC', sans-serif; }
a { color: #58a6ff; text-decoration: none; }
a:hover { text-decoration: underline; }
h1, h2 { padding-bottom: .3em; border-bottom: 1px solid #33383d; }
h5, h6 { color: #8b9299; }
code { background: #2a2e32; }
pre { background: #24282b; }
blockquote { color: #a6adb4; border-left: 4px solid #3a4046; }
th, td { border: 1px solid #33383d; }
th { background: #24282b; }
hr { background: #33383d; }
.mdf-toc-title { color: #8b9299; }
.hljs-keyword, .hljs-selector-tag, .hljs-built_in { color: #ff7b72; }
.hljs-string, .hljs-regexp { color: #a5d6ff; }
.hljs-number, .hljs-literal, .hljs-variable, .hljs-template-variable { color: #79c0ff; }
.hljs-comment { color: #8b949e; font-style: italic; }
.hljs-title, .hljs-section, .hljs-function { color: #d2a8ff; }
.hljs-name, .hljs-tag { color: #7ee787; }
.hljs-attr, .hljs-attribute, .hljs-selector-class, .hljs-selector-id { color: #ffa657; }
.hljs-symbol, .hljs-bullet { color: #ffa657; }
.hljs-meta { color: #8b949e; }
.hljs-addition { color: #7ee787; background: #12261e; }
.hljs-deletion { color: #ff7b72; background: #2d1618; }
`,
  // 移植自 Typora 主题 mdmdt（cayxc，Apache-2.0）的浅色版：雅黑正文、蓝色引用块、隔行表格
  mdmdt: `
body { color: #000; font-family: 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', Arial, 'Helvetica Neue', sans-serif; font-size: 16px; line-height: 1.6; letter-spacing: 0.6px; }
a { color: #3e69d7; font-weight: 500; text-decoration: none; }
a:hover { color: #f59102; text-decoration: underline; }
h1, h2, h3, h4, h5, h6 { letter-spacing: 2px; margin: 32px 0 18px; }
h1 { font-size: 2em; padding-bottom: .18em; border-bottom: 1px solid #d2d2d2; }
h2 { font-size: 1.75em; }
h3 { font-size: 1.5em; }
h4 { font-size: 1.25em; }
h5 { font-size: 1.125em; }
h6 { font-size: 1em; }
h5, h6 { color: #000; }
p + p { margin-top: 24px; }
strong { font-weight: 800; }
del { color: #666; text-decoration-color: #e30f2e; }
code { padding: 3px 5px; border-radius: 4px; background: rgba(62, 105, 215, 0.15); color: #2f479f; }
pre { background: rgb(236, 236, 238); border-radius: 8px; }
pre code { color: inherit; }
blockquote { padding: 16px; border-left: 4px solid #3e69d7; border-radius: 8px; background: rgba(62, 105, 215, 0.06); color: #000; }
blockquote > *:first-child { margin-top: 0; }
blockquote > *:last-child { margin-bottom: 0; }
table { border: 1px solid #d2d2d2; border-radius: 8px; border-collapse: separate; border-spacing: 0; }
th, td { padding: 10px; border: 0; border-left: 1px solid #d2d2d2; }
th:first-child, td:first-child { border-left: 0; }
th { background: rgb(236, 236, 238); }
tbody tr:nth-child(even) td { background: rgb(236, 236, 238); }
hr { background: #d2d2d2; }
.mdf-toc-title { color: #666; }
::selection { background: rgba(245, 145, 2, 0.3); }
.hljs-keyword, .hljs-selector-tag, .hljs-built_in { color: #e32e73; }
.hljs-string, .hljs-regexp { color: #02be74; }
.hljs-number, .hljs-literal, .hljs-variable, .hljs-template-variable { color: #f59102; }
.hljs-comment { color: rgba(72, 93, 108, 0.75); font-style: italic; }
.hljs-title, .hljs-section, .hljs-function { color: #3876eb; }
.hljs-name, .hljs-tag { color: #0c9bd3; }
.hljs-attr, .hljs-attribute, .hljs-selector-class, .hljs-selector-id { color: #c08b01; }
.hljs-symbol, .hljs-bullet { color: #f59102; }
.hljs-meta { color: rgba(72, 93, 108, 0.75); }
.hljs-addition { color: #03b736; background: rgba(3, 183, 54, 0.15); }
.hljs-deletion { color: #e30f2e; background: rgba(227, 15, 46, 0.15); }
`
}

const PAGE_SIZE: Record<PaperSize, string> = {
  A4: 'A4',
  A5: 'A5',
  Letter: 'letter',
  Legal: 'legal'
}

/** 纸张与页边距写进 @page，导出的 HTML 直接用浏览器打印也能对上 PDF 的分页 */
export function pageCss(paper: PaperSize, margin: PageMargin): string {
  return `@page { size: ${PAGE_SIZE[paper]}; margin: ${MARGIN_MM[margin]}mm; }\n`
}

/** 内置主题的样式块；custom:<id> 引用返回 null。主题编辑器拿它做"复制为自定义"的底稿 */
export function builtinThemeCss(theme: ExportTheme): string | null {
  return (BUILTIN_EXPORT_THEMES as readonly string[]).includes(theme) ? THEME_CSS[theme as BuiltinExportTheme] : null
}

export interface CssExtras {
  /** custom:<id> 引用命中的自定义 CSS；条目被删时回落默认主题 */
  custom?: string
  /** 代码高亮主题；auto 沿用排版主题自带的配色 */
  highlight?: HighlightTheme
}

export function cssFor(theme: ExportTheme, extras: CssExtras = {}): string {
  const themed = builtinThemeCss(theme) ?? extras.custom ?? THEME_CSS.default
  const highlight = highlightCss(extras.highlight ?? 'auto')
  return highlight === '' ? `${BASE_CSS}\n${themed}` : `${BASE_CSS}\n${themed}\n${highlight}`
}
