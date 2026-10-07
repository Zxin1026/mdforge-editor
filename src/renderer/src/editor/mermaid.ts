import { currentTheme, type EditorTheme } from './theme-runtime'

const CACHE_LIMIT = 16
const cache = new Map<string, string>()
let loading: Promise<typeof import('mermaid').default> | null = null
let seq = 0
let configured: EditorTheme | null = null

/** 与界面同一套基调，避免图块在文档里出现相反明暗的色块（色板对齐 mdmdt 皮肤） */
const THEME_VARIABLES: Record<EditorTheme, Record<string, string>> = {
  light: {
    primaryColor: '#e9eefc',
    primaryTextColor: '#000000',
    primaryBorderColor: '#b9c8f0',
    secondaryColor: '#ececee',
    secondaryTextColor: '#000000',
    secondaryBorderColor: '#c9c9cc',
    tertiaryColor: '#ffffff',
    lineColor: '#666666',
    mainBkg: '#ffffff',
    nodeBkg: '#ffffff',
    nodeBorder: '#b9c8f0',
    clusterBkg: '#f3f3f5',
    clusterBorder: '#d2d2d2',
    titleColor: '#000000',
    edgeLabelBackground: '#ffffff',
    actorBkg: '#e9eefc',
    actorBorder: '#b9c8f0',
    actorTextColor: '#000000',
    signalColor: '#333333',
    labelBoxBkgColor: '#e9eefc',
    labelBoxBorderColor: '#b9c8f0',
    labelTextColor: '#000000',
    loopTextColor: '#000000',
    noteBkgColor: '#fdf3e3',
    noteTextColor: '#000000',
    noteBorderColor: '#f2cf9a',
    activationBkgColor: '#ececee',
    sequenceNumberColor: '#000000'
  },
  dark: {
    primaryColor: '#1e2740',
    primaryTextColor: '#d0d0d0',
    primaryBorderColor: '#3e5aa8',
    secondaryColor: '#282a32',
    secondaryTextColor: '#d0d0d0',
    secondaryBorderColor: '#3d4048',
    tertiaryColor: '#232329',
    lineColor: '#667c89',
    mainBkg: '#232329',
    nodeBkg: '#232329',
    nodeBorder: '#3e5aa8',
    clusterBkg: '#202026',
    clusterBorder: '#464b50',
    titleColor: '#d0d0d0',
    edgeLabelBackground: '#232329',
    actorBkg: '#1e2740',
    actorBorder: '#3e5aa8',
    actorTextColor: '#d0d0d0',
    signalColor: '#a8b1ba',
    labelBoxBkgColor: '#1e2740',
    labelBoxBorderColor: '#3e5aa8',
    labelTextColor: '#d0d0d0',
    loopTextColor: '#d0d0d0',
    noteBkgColor: '#3a3320',
    noteTextColor: '#e6d9a8',
    noteBorderColor: '#5c5230',
    activationBkgColor: '#282a32',
    sequenceNumberColor: '#d0d0d0'
  }
}

function configure(mermaid: typeof import('mermaid').default, theme: EditorTheme): void {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: "'Microsoft YaHei UI', 'Microsoft YaHei', 'Segoe UI', sans-serif",
    themeVariables: THEME_VARIABLES[theme],
    flowchart: { useMaxWidth: false, htmlLabels: false },
    sequence: { useMaxWidth: false },
    gantt: { useMaxWidth: false }
  })
}

function load(): Promise<typeof import('mermaid').default> {
  if (!loading) loading = import('mermaid').then((module) => module.default)
  return loading
}

/**
 * mermaid 渲染是异步且昂贵的，而装饰集会随选区变化重建，
 * 因此按"主题 + 源码"缓存结果；缓存只保留最近若干条，避免长文档堆积。
 */
export async function renderMermaid(code: string): Promise<string> {
  const theme = currentTheme()
  const key = `${theme}\n${code}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  const mermaid = await load()
  // 主题换了要重新 initialize，否则整份图仍按上一种配色画
  if (configured !== theme) {
    configure(mermaid, theme)
    configured = theme
  }
  const id = `mdf-mermaid-${++seq}`
  const { svg } = await mermaid.render(id, code.trim())
  cache.set(key, svg)
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return svg
}

export function clearMermaidCache(): void {
  cache.clear()
}
