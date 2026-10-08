import { normalizeTheme, type AppTheme } from '../../shared/ipc'

/** 具体落到的皮肤（system 解析后不会再出现） */
export type ResolvedTheme = 'light' | 'dark' | 'sepia' | 'high-contrast'

/** 编辑器家族：mermaid、分屏预览这类按深浅两套配色的块只认它 */
export type ThemeFamily = 'light' | 'dark'

const DARK_FAMILY: ReadonlySet<ResolvedTheme> = new Set(['dark', 'high-contrast'])

export function themeFamily(theme: ResolvedTheme): ThemeFamily {
  return DARK_FAMILY.has(theme) ? 'dark' : 'light'
}

export interface ThemeController {
  mode(): AppTheme
  resolved(): ResolvedTheme
  set(mode: AppTheme): void
  /** 只有"浅色族 / 深色族"变化时才回调，系统模式下跟随系统切换也会触发 */
  onChange(cb: (family: ThemeFamily) => void): void
}

/** 主题菜单各档怎么落到具体皮肤；prefersDark 由渲染进程读取，便于单测 */
export function resolveTheme(mode: AppTheme, prefersDark: boolean): ResolvedTheme {
  if (mode === 'system') return prefersDark ? 'dark' : 'light'
  return mode
}

const QUERY = '(prefers-color-scheme: dark)'

export function createTheme(initial: AppTheme): ThemeController {
  const media = window.matchMedia(QUERY)
  const listeners: Array<(family: ThemeFamily) => void> = []
  let mode: AppTheme = normalizeTheme(initial) ?? 'light'
  let family: ThemeFamily = themeFamily(resolveTheme(mode, media.matches))

  function apply(next: AppTheme): void {
    const value = resolveTheme(next, media.matches)
    mode = next
    // 界面配色全在 CSS 变量里，这里只翻一个开关；color-scheme 影响滚动条等原生控件
    document.documentElement.dataset.theme = value
    const nextFamily = themeFamily(value)
    if (nextFamily !== family) {
      family = nextFamily
      for (const listener of listeners) listener(nextFamily)
    }
  }

  apply(mode)

  media.addEventListener('change', () => {
    if (mode === 'system') apply(mode)
  })

  return {
    mode: () => mode,
    resolved: () => resolveTheme(mode, media.matches),
    set(next) {
      apply(normalizeTheme(next) ?? 'light')
    },
    onChange(cb) {
      listeners.push(cb)
    }
  }
}
