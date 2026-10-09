import katexCssText from 'katex/dist/katex.min.css?raw'
import amsRegular from 'katex/dist/fonts/KaTeX_AMS-Regular.woff2?inline'
import caligraphicBold from 'katex/dist/fonts/KaTeX_Caligraphic-Bold.woff2?inline'
import caligraphicRegular from 'katex/dist/fonts/KaTeX_Caligraphic-Regular.woff2?inline'
import frakturBold from 'katex/dist/fonts/KaTeX_Fraktur-Bold.woff2?inline'
import frakturRegular from 'katex/dist/fonts/KaTeX_Fraktur-Regular.woff2?inline'
import mainBold from 'katex/dist/fonts/KaTeX_Main-Bold.woff2?inline'
import mainBoldItalic from 'katex/dist/fonts/KaTeX_Main-BoldItalic.woff2?inline'
import mainItalic from 'katex/dist/fonts/KaTeX_Main-Italic.woff2?inline'
import mainRegular from 'katex/dist/fonts/KaTeX_Main-Regular.woff2?inline'
import mathBoldItalic from 'katex/dist/fonts/KaTeX_Math-BoldItalic.woff2?inline'
import mathItalic from 'katex/dist/fonts/KaTeX_Math-Italic.woff2?inline'
import sansBold from 'katex/dist/fonts/KaTeX_SansSerif-Bold.woff2?inline'
import sansItalic from 'katex/dist/fonts/KaTeX_SansSerif-Italic.woff2?inline'
import sansRegular from 'katex/dist/fonts/KaTeX_SansSerif-Regular.woff2?inline'
import scriptRegular from 'katex/dist/fonts/KaTeX_Script-Regular.woff2?inline'
import size1 from 'katex/dist/fonts/KaTeX_Size1-Regular.woff2?inline'
import size2 from 'katex/dist/fonts/KaTeX_Size2-Regular.woff2?inline'
import size3 from 'katex/dist/fonts/KaTeX_Size3-Regular.woff2?inline'
import size4 from 'katex/dist/fonts/KaTeX_Size4-Regular.woff2?inline'
import typewriterRegular from 'katex/dist/fonts/KaTeX_Typewriter-Regular.woff2?inline'

/**
 * 导出的公式样式：katex 自带的排版表 + 字体转 data URI。
 * 导出文件要脱离 node_modules 单独生效，字体不能留相对路径；
 * woff2 覆盖现代浏览器与 Electron，woff/ttf 回退链删掉以免指向不存在的文件。
 */
const FONTS: Record<string, string> = {
  'KaTeX_AMS-Regular.woff2': amsRegular,
  'KaTeX_Caligraphic-Bold.woff2': caligraphicBold,
  'KaTeX_Caligraphic-Regular.woff2': caligraphicRegular,
  'KaTeX_Fraktur-Bold.woff2': frakturBold,
  'KaTeX_Fraktur-Regular.woff2': frakturRegular,
  'KaTeX_Main-Bold.woff2': mainBold,
  'KaTeX_Main-BoldItalic.woff2': mainBoldItalic,
  'KaTeX_Main-Italic.woff2': mainItalic,
  'KaTeX_Main-Regular.woff2': mainRegular,
  'KaTeX_Math-BoldItalic.woff2': mathBoldItalic,
  'KaTeX_Math-Italic.woff2': mathItalic,
  'KaTeX_SansSerif-Bold.woff2': sansBold,
  'KaTeX_SansSerif-Italic.woff2': sansItalic,
  'KaTeX_SansSerif-Regular.woff2': sansRegular,
  'KaTeX_Script-Regular.woff2': scriptRegular,
  'KaTeX_Size1-Regular.woff2': size1,
  'KaTeX_Size2-Regular.woff2': size2,
  'KaTeX_Size3-Regular.woff2': size3,
  'KaTeX_Size4-Regular.woff2': size4,
  'KaTeX_Typewriter-Regular.woff2': typewriterRegular
}

let cached: string | null = null

export function katexExportCss(): string {
  if (cached !== null) return cached
  cached = katexCssText
    .replace(/url\(fonts\/([^)]+\.woff2)\)/g, (whole, name: string) => {
      const data = FONTS[name]
      return data === undefined ? whole : `url(${data})`
    })
    .replace(/,\s*url\(fonts\/[^)]+\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g, '')
  return cached
}
