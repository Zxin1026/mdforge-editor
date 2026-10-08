import {
  customIdOf,
  type CustomStyleLibrary,
  type CustomTemplate,
  type CustomTheme,
  type ExportTheme,
  type HighlightTheme,
  type PageTemplate
} from '../../../shared/ipc'
import { cssFor } from './export-css'

/**
 * 渲染进程侧的样式资产注册表：启动时从主进程拉一次，
 * 管理器里增删改后重新 set。导出各路径都从这里查 custom:<id> 的内容。
 */

let themes = new Map<string, CustomTheme>()
let templates = new Map<string, CustomTemplate>()

export function setStyleLibrary(library: CustomStyleLibrary): void {
  themes = new Map(library.themes.map((theme) => [theme.id, theme]))
  templates = new Map(library.templates.map((template) => [template.id, template]))
}

export function customThemes(): CustomTheme[] {
  return [...themes.values()]
}

export function customTemplates(): CustomTemplate[] {
  return [...templates.values()]
}

export function customThemeById(id: string): CustomTheme | undefined {
  return themes.get(id)
}

export function customTemplateById(id: string): CustomTemplate | undefined {
  return templates.get(id)
}

/** 引用是否还指着存在的条目：条目被删后用它回退到内置 */
export function themeRefExists(ref: ExportTheme): boolean {
  const id = customIdOf(ref)
  return id === null || themes.has(id)
}

export function templateRefExists(ref: PageTemplate): boolean {
  const id = customIdOf(ref)
  return id === null || templates.has(id)
}

/** 排版主题 + 代码高亮主题合成最终样式表 */
export function cssForRef(ref: ExportTheme, highlight: HighlightTheme): string {
  const id = customIdOf(ref)
  return cssFor(ref, { custom: id === null ? undefined : themes.get(id)?.css, highlight })
}

/** 自定义页面的模板 HTML；内置返回 null，由调用方用内置模板 */
export function templateHtmlForRef(ref: PageTemplate): string | null {
  const id = customIdOf(ref)
  return id === null ? null : (templates.get(id)?.html ?? null)
}
