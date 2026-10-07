import { normalizeTheme, type AppTheme } from '../../shared/ipc'

export type ResolvedTheme = 'light' | 'dark'

export interface ThemeController {
  mode(): AppTheme
  resolved(): ResolvedTheme
  set(mode: AppTheme): void
  /** 只有"最终落到浅色还是深色"变化时才回调，系统模式下跟随系统切换也会触发 */
  onChange(cb: (resolved: ResolvedTheme) => void): void
}

/** 主题菜单三项怎么落到具体深浅色；prefersDark 由渲染进程读取，便于单测 */
export function resolveTheme(mode: AppTheme, prefersDark: boolean): ResolvedTheme {
  if (mode === 'system') return prefersDark ? 'dark' : 'light'
  return mode
}

const QUERY = '(prefers-color-scheme: dark)'

export function createTheme(initial: AppTheme): ThemeController {
  const media = window.matchMedia(QUERY)
  const listeners: Array<(resolved: ResolvedTheme) => void> = []
  let mode: AppTheme = normalizeTheme(initial) ?? 'light'
  let resolved: ResolvedTheme = 'light'

  function apply(next: AppTheme): void {
    const value = resolveTheme(next, media.matches)
    mode = next
    // 界面配色全在 CSS 变量里，这里只翻一个开关；color-scheme 影响滚动条等原生控件
    document.documentElement.dataset.theme = value
    if (value !== resolved) {
      resolved = value
      for (const listener of listeners) listener(value)
    }
  }

  apply(mode)

  media.addEventListener('change', () => {
    if (mode === 'system') apply(mode)
  })

  return {
    mode: () => mode,
    resolved: () => resolved,
    set(next) {
      apply(normalizeTheme(next) ?? 'light')
    },
    onChange(cb) {
      listeners.push(cb)
    }
  }
}
