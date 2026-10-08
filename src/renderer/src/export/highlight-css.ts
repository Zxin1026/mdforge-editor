import type { HighlightTheme } from '../../../shared/ipc'

/**
 * 代码高亮主题：按 highlight.js 经典配色的色板手写收敛版（与 BASE_CSS 里的
 * hljs 分组一一对应），只留导出页真正会出现的类，体积比整份主题小一个量级。
 * 选择 auto 时返回空串，沿用排版主题自带的配色。
 */

interface HighlightPalette {
  /** 代码块底色；写进 pre，让整块（含内边距）统一 */
  bg: string
  text: string
  comment: string
  keyword: string
  str: string
  num: string
  title: string
  name: string
  attr: string
  symbol: string
  meta: string
  add: { color: string; bg: string }
  del: { color: string; bg: string }
}

const PALETTES: Record<Exclude<HighlightTheme, 'auto'>, HighlightPalette> = {
  github: {
    bg: '#f6f8fa',
    text: '#24292e',
    comment: '#6a737d',
    keyword: '#d73a49',
    str: '#032f62',
    num: '#005cc5',
    title: '#6f42c1',
    name: '#22863a',
    attr: '#e36209',
    symbol: '#e36209',
    meta: '#6a737d',
    add: { color: '#22863a', bg: '#f0fff4' },
    del: { color: '#b31d28', bg: '#ffeef0' }
  },
  'atom-one-light': {
    bg: '#fafafa',
    text: '#383a42',
    comment: '#a0a1a7',
    keyword: '#a626a4',
    str: '#50a14f',
    num: '#986801',
    title: '#4078f2',
    name: '#e45649',
    attr: '#986801',
    symbol: '#4078f2',
    meta: '#a0a1a7',
    add: { color: '#50a14f', bg: 'rgba(80, 161, 79, 0.12)' },
    del: { color: '#e45649', bg: 'rgba(228, 86, 73, 0.12)' }
  },
  'solarized-light': {
    bg: '#fdf6e3',
    text: '#657b83',
    comment: '#93a1a1',
    keyword: '#859900',
    str: '#2aa198',
    num: '#d33682',
    title: '#268bd2',
    name: '#cb4b16',
    attr: '#b58900',
    symbol: '#2aa198',
    meta: '#93a1a1',
    add: { color: '#859900', bg: 'rgba(133, 153, 0, 0.12)' },
    del: { color: '#dc322f', bg: 'rgba(220, 50, 47, 0.12)' }
  },
  'github-dark': {
    bg: '#0d1117',
    text: '#c9d1d9',
    comment: '#8b949e',
    keyword: '#ff7b72',
    str: '#a5d6ff',
    num: '#79c0ff',
    title: '#d2a8ff',
    name: '#7ee787',
    attr: '#ffa657',
    symbol: '#ffa657',
    meta: '#8b949e',
    add: { color: '#7ee787', bg: '#12261e' },
    del: { color: '#ff7b72', bg: '#2d1618' }
  },
  'atom-one-dark': {
    bg: '#282c34',
    text: '#abb2bf',
    comment: '#5c6370',
    keyword: '#c678dd',
    str: '#98c379',
    num: '#d19a66',
    title: '#61afef',
    name: '#e06c75',
    attr: '#d19a66',
    symbol: '#61afef',
    meta: '#61afef',
    add: { color: '#98c379', bg: 'rgba(152, 195, 121, 0.12)' },
    del: { color: '#e06c75', bg: 'rgba(224, 108, 117, 0.12)' }
  },
  monokai: {
    bg: '#272822',
    text: '#f8f8f2',
    comment: '#75715e',
    keyword: '#f92672',
    str: '#e6db74',
    num: '#ae81ff',
    title: '#a6e22e',
    name: '#f92672',
    attr: '#a6e22e',
    symbol: '#ae81ff',
    meta: '#75715e',
    add: { color: '#a6e22e', bg: 'rgba(166, 226, 46, 0.12)' },
    del: { color: '#f92672', bg: 'rgba(249, 38, 114, 0.12)' }
  },
  dracula: {
    bg: '#282a36',
    text: '#f8f8f2',
    comment: '#6272a4',
    keyword: '#ff79c6',
    str: '#f1fa8c',
    num: '#bd93f9',
    title: '#50fa7b',
    name: '#ff79c6',
    attr: '#50fa7b',
    symbol: '#f1fa8c',
    meta: '#6272a4',
    add: { color: '#50fa7b', bg: 'rgba(80, 250, 123, 0.12)' },
    del: { color: '#ff5555', bg: 'rgba(255, 85, 85, 0.12)' }
  },
  nord: {
    bg: '#2e3440',
    text: '#d8dee9',
    comment: '#616e88',
    keyword: '#81a1c1',
    str: '#a3be8c',
    num: '#b48ead',
    title: '#88c0d0',
    name: '#81a1c1',
    attr: '#8fbcbb',
    symbol: '#81a1c1',
    meta: '#5e81ac',
    add: { color: '#a3be8c', bg: 'rgba(163, 190, 140, 0.12)' },
    del: { color: '#bf616a', bg: 'rgba(191, 97, 106, 0.12)' }
  },
  'solarized-dark': {
    bg: '#002b36',
    text: '#839496',
    comment: '#586e75',
    keyword: '#859900',
    str: '#2aa198',
    num: '#d33682',
    title: '#268bd2',
    name: '#cb4b16',
    attr: '#b58900',
    symbol: '#2aa198',
    meta: '#586e75',
    add: { color: '#859900', bg: 'rgba(133, 153, 0, 0.18)' },
    del: { color: '#dc322f', bg: 'rgba(220, 50, 47, 0.18)' }
  },
  vs2015: {
    bg: '#1e1e1e',
    text: '#d4d4d4',
    comment: '#608b4e',
    keyword: '#569cd6',
    str: '#ce9178',
    num: '#b5cea8',
    title: '#dcdcaa',
    name: '#569cd6',
    attr: '#9cdcfe',
    symbol: '#d7ba7d',
    meta: '#608b4e',
    add: { color: '#b5cea8', bg: 'rgba(181, 206, 168, 0.12)' },
    del: { color: '#d16969', bg: 'rgba(209, 105, 105, 0.15)' }
  }
}

/** 排在排版主题之后，同名单类选择器后者覆盖前者 */
export function highlightCss(theme: HighlightTheme): string {
  if (theme === 'auto') return ''
  const p = PALETTES[theme]
  if (!p) return ''
  return `pre { background: ${p.bg}; }
.hljs { color: ${p.text}; }
.hljs-keyword, .hljs-selector-tag, .hljs-built_in { color: ${p.keyword}; }
.hljs-string, .hljs-regexp { color: ${p.str}; }
.hljs-number, .hljs-literal, .hljs-variable, .hljs-template-variable { color: ${p.num}; }
.hljs-comment { color: ${p.comment}; font-style: italic; }
.hljs-title, .hljs-section, .hljs-function { color: ${p.title}; }
.hljs-name, .hljs-tag { color: ${p.name}; }
.hljs-attr, .hljs-attribute, .hljs-selector-class, .hljs-selector-id { color: ${p.attr}; }
.hljs-symbol, .hljs-bullet { color: ${p.symbol}; }
.hljs-meta { color: ${p.meta}; }
.hljs-addition { color: ${p.add.color}; background: ${p.add.bg}; }
.hljs-deletion { color: ${p.del.color}; background: ${p.del.bg}; }
`
}
