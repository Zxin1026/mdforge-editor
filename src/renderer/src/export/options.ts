import type { AssetExportMode, ExportTheme, PageMargin, PaperSize } from '../../../shared/ipc'

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

export const THEME_LABELS: Record<ExportTheme, string> = {
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

export const ASSET_MODES: AssetExportMode[] = ['copy', 'inline', 'keep']
export const THEMES: ExportTheme[] = ['default', 'serif', 'plain', 'dark', 'mdmdt']
export const MARGINS: PageMargin[] = ['narrow', 'standard', 'wide']
