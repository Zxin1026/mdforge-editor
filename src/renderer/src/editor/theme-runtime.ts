export type EditorTheme = 'light' | 'dark'

/** 高对比度按深色族渲染（黑底）；护眼与浅色共用浅色族 */
const DARK_SKINS = new Set(['dark', 'high-contrast'])

/** 界面皮肤的唯一出处是 <html data-theme>（theme.ts 写入），编辑器侧只读它 */
export function currentTheme(): EditorTheme {
  return DARK_SKINS.has(document.documentElement.dataset.theme ?? '') ? 'dark' : 'light'
}
