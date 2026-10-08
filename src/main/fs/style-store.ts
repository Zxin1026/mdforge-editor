import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  STYLE_CONTENT_MAX,
  STYLE_NAME_MAX,
  templatePlaceholderProblem,
  type CustomStyleInput,
  type CustomStyleKind,
  type CustomStyleLibrary,
  type CustomStyleSaved,
  type CustomTemplate,
  type CustomTheme
} from '../../shared/ipc'
import { FileOpError } from './error'

/**
 * 自定义导出主题（CSS）与页面模板（HTML），一份条目一个 json：
 * userData/export-styles/themes、userData/export-styles/templates。
 * 本模块只管存取与校验，导入导出（系统对话框）在 style-transfer.ts。
 */

let root: string | null = null

export function initStyleStore(dir: string): void {
  root = dir
}

function styleRoot(): string {
  if (!root) throw new Error('主题目录尚未初始化')
  return root
}

function dirOf(kind: CustomStyleKind): string {
  return path.join(styleRoot(), kind === 'theme' ? 'themes' : 'templates')
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/

export function parseKind(raw: unknown): CustomStyleKind {
  if (raw !== 'theme' && raw !== 'template') throw new FileOpError('invalid-path', '未知的主题类型')
  return raw
}

function validId(raw: unknown): string {
  if (typeof raw !== 'string' || !ID_PATTERN.test(raw)) throw new FileOpError('invalid-path', '主题编号不合法')
  return raw
}

function defaultStyleName(kind: CustomStyleKind): string {
  return kind === 'theme' ? '自定义主题' : '页面模板'
}

function createId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** 控制字符换成空格（导入的外来名称里可能有 NUL、换行等），其余字符原样保留 */
function dropControl(raw: string): string {
  let out = ''
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0
    out += code < 32 || code === 127 ? ' ' : char
  }
  return out
}

/** 去掉控制字符、折叠空白并限量；结果为空时用默认名 */
export function sanitizeStyleName(raw: string, fallback: string): string {
  const cleaned = dropControl(raw).replace(/\s+/g, ' ').trim().slice(0, STYLE_NAME_MAX)
  return cleaned === '' ? fallback : cleaned
}

/** 重名时给新条目加序号：导入别人的主题不该顶掉本地的同名条目 */
export function uniqueStyleName(name: string, taken: readonly string[]): string {
  const used = new Set(taken)
  if (!used.has(name)) return name
  for (let i = 2; i < 1000; i += 1) {
    const suffix = ` ${i}`
    const candidate = `${name.slice(0, STYLE_NAME_MAX - suffix.length)}${suffix}`
    if (!used.has(candidate)) return candidate
  }
  return `${name.slice(0, STYLE_NAME_MAX - 8)}-${Date.now().toString(36).slice(-6)}`
}

/** 名称之外的内容校验：空内容、超量、模板缺占位符都在这里拦下 */
export function styleProblem(kind: CustomStyleKind, content: string): string | null {
  if (content.trim() === '') return kind === 'theme' ? '主题 CSS 不能为空' : '模板内容不能为空'
  if (Buffer.byteLength(content, 'utf8') > STYLE_CONTENT_MAX) {
    return `内容过大（上限 ${Math.round(STYLE_CONTENT_MAX / 1024)} KB）`
  }
  if (kind === 'template') return templatePlaceholderProblem(content)
  return null
}

export interface ParsedStyle {
  name: string
  content: string
}

/** 导入文件 → 名称与内容；json 认 {name, css|html}，其余按原始文本读、文件名当名字 */
export function parseImportedStyle(kind: CustomStyleKind, fileName: string, text: string): ParsedStyle {
  const stem = path.basename(fileName, path.extname(fileName))
  const fallback = sanitizeStyleName(stem, defaultStyleName(kind))
  if (path.extname(fileName).toLowerCase() !== '.json') {
    return { name: fallback, content: text }
  }

  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new FileOpError('invalid-path', '这不是有效的 JSON 文件')
  }
  if (data === null || typeof data !== 'object') throw new FileOpError('invalid-path', '文件内容不合法')
  const record = data as Record<string, unknown>
  const content = kind === 'theme' ? record.css : record.html
  if (typeof content !== 'string') {
    throw new FileOpError('invalid-path', kind === 'theme' ? 'JSON 里缺少 css 字段' : 'JSON 里缺少 html 字段')
  }
  const name = typeof record.name === 'string' ? record.name : stem
  return { name: sanitizeStyleName(name, fallback), content }
}

function isTheme(value: unknown): value is CustomTheme {
  const item = value as Partial<CustomTheme>
  return (
    typeof item?.id === 'string' &&
    ID_PATTERN.test(item.id) &&
    typeof item.name === 'string' &&
    typeof item.css === 'string'
  )
}

function isTemplate(value: unknown): value is CustomTemplate {
  const item = value as Partial<CustomTemplate>
  return (
    typeof item?.id === 'string' &&
    ID_PATTERN.test(item.id) &&
    typeof item.name === 'string' &&
    typeof item.html === 'string'
  )
}

async function listKind(kind: CustomStyleKind): Promise<Array<CustomTheme | CustomTemplate>> {
  let names: string[]
  try {
    names = await fs.readdir(dirOf(kind))
  } catch {
    return []
  }
  const items: Array<CustomTheme | CustomTemplate> = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(dirOf(kind), name), 'utf-8')) as unknown
      if (kind === 'theme' ? isTheme(parsed) : isTemplate(parsed)) items.push(parsed as CustomTheme | CustomTemplate)
    } catch {
      /* 写了一半的条目跳过，不能让它挡住主题列表 */
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

export async function listStyles(): Promise<CustomStyleLibrary> {
  const [themes, templates] = await Promise.all([listKind('theme'), listKind('template')])
  return { themes: themes as CustomTheme[], templates: templates as CustomTemplate[] }
}

async function writeItem(kind: CustomStyleKind, id: string, payload: CustomTheme | CustomTemplate): Promise<void> {
  const file = path.join(dirOf(kind), `${id}.json`)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  try {
    await fs.writeFile(temp, JSON.stringify(payload, null, 2), 'utf-8')
    await fs.rename(temp, file)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

export async function readStyleItem(kind: CustomStyleKind, id: string): Promise<CustomTheme | CustomTemplate> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dirOf(kind), `${id}.json`), 'utf-8')) as unknown
    if (kind === 'theme' ? isTheme(parsed) : isTemplate(parsed)) return parsed as CustomTheme | CustomTemplate
  } catch {
    /* 交给下面统一报"不存在" */
  }
  throw new FileOpError('not-found', kind === 'theme' ? '这个主题已经不在了' : '这个模板已经不在了')
}

export async function saveStyle(input: CustomStyleInput): Promise<CustomStyleSaved> {
  if (input === null || typeof input !== 'object') throw new FileOpError('invalid-path', '主题参数不合法')
  const kind = parseKind(input.kind)
  const content = typeof input.content === 'string' ? input.content : ''
  const problem = styleProblem(kind, content)
  if (problem !== null) throw new FileOpError('invalid-path', problem)

  const existing = await listKind(kind)
  let id: string
  if (typeof input.id === 'string' && input.id !== '') {
    id = validId(input.id)
    if (!existing.some((item) => item.id === id)) throw new FileOpError('not-found', '要修改的条目已经不在了')
  } else {
    id = createId()
  }

  const others = existing.filter((item) => item.id !== id).map((item) => item.name)
  const name = uniqueStyleName(
    sanitizeStyleName(typeof input.name === 'string' ? input.name : '', defaultStyleName(kind)),
    others
  )
  const payload: CustomTheme | CustomTemplate =
    kind === 'theme' ? { id, name, css: content } : { id, name, html: content }
  await writeItem(kind, id, payload)
  return { id, library: await listStyles() }
}

export async function deleteStyle(kindRaw: unknown, idRaw: unknown): Promise<CustomStyleLibrary> {
  const kind = parseKind(kindRaw)
  const id = validId(idRaw)
  await fs.rm(path.join(dirOf(kind), `${id}.json`), { force: true })
  return listStyles()
}
