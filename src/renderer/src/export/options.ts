import {
  BUILTIN_EXPORT_THEMES,
  HIGHLIGHT_THEMES,
  customIdOf,
  type AssetExportMode,
  type BuiltinExportTheme,
  type ExportTheme,
  type HighlightTheme,
  type PageMargin,
  type PageTemplate,
  type PaperSize
} from '../../../shared/ipc'
import { customTemplates, customThemes } from './style-lib'

export const ASSET_MODE_LABELS: Record<AssetExportMode, string> = {
  copy: '复制图片',
  inline: '内联 base64',
  keep: '保持原路径'
}

export const ASSET_MODE_NOTES: Record<AssetExportMode, string> = {
  copy: '换目录不断链',
  inline: '单文件带走',
  keep: '必须留在原目录'
}

export const THEME_LABELS: Record<BuiltinExportTheme, string> = {
  default: '默认',
  serif: '衬排',
  plain: '朴素',
  dark: '深色',
  mdmdt: 'mdmdt'
}

export const MARGIN_LABELS: Record<PageMargin, string> = {
  narrow: '窄 (12 mm)',
  standard: '标准 (20 mm)',
  wide: '宽 (30 mm)'
}

export const PAPER_LABELS: Record<PaperSize, string> = {
  A4: 'A4',
  Letter: 'Letter',
  Legal: 'Legal',
  A5: 'A5'
}

export const HIGHLIGHT_LABELS: Record<HighlightTheme, string> = {
  auto: '跟随主题',
  github: 'GitHub',
  'atom-one-light': 'Atom One Light',
  'solarized-light': 'Solarized Light',
  'github-dark': 'GitHub Dark',
  'atom-one-dark': 'Atom One Dark',
  monokai: 'Monokai',
  dracula: 'Dracula',
  nord: 'Nord',
  'solarized-dark': 'Solarized Dark',
  vs2015: 'VS2015'
}

export const ASSET_MODES: AssetExportMode[] = ['copy', 'inline', 'keep']
export const THEMES: BuiltinExportTheme[] = [...BUILTIN_EXPORT_THEMES]
export const HIGHLIGHT_CHOICES: HighlightTheme[] = ['auto', ...HIGHLIGHT_THEMES]
export const MARGINS: PageMargin[] = ['narrow', 'standard', 'wide']

/** 主题显示名：内置查表，自定义查注册表；条目被删时如实标出 */
export function themeLabel(ref: ExportTheme): string {
  const id = customIdOf(ref)
  if (id === null) return THEME_LABELS[ref as BuiltinExportTheme] ?? ref
  return customThemes().find((item) => item.id === id)?.name ?? '自定义主题（已删除）'
}

export function templateLabel(ref: PageTemplate): string {
  const id = customIdOf(ref)
  if (id === null) return '内置标准页'
  return customTemplates().find((item) => item.id === id)?.name ?? '页面模板（已删除）'
}

export function highlightLabel(ref: HighlightTheme): string {
  return HIGHLIGHT_LABELS[ref] ?? ref
}
