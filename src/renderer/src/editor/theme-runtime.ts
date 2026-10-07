export type EditorTheme = 'light' | 'dark'

/** 界面深浅的唯一出处是 <html data-theme>（theme.ts 写入），编辑器侧只读它 */
export function currentTheme(): EditorTheme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}
