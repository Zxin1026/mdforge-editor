/**
 * front matter 的表单化编辑：只认顶层 `键: 值` 与列表这几个子集，
 * 未列出的字段（含续行、注释）逐行原样保留——表单不吞用户的原始 YAML。
 */

export interface FrontMatterEntry {
  key: string
  /** 键行 + 续行的原始文本，逐行保留 */
  lines: string[]
}

export interface FrontMatterModel {
  /** 第一个键之前的注释与空行 */
  preamble: string[]
  entries: FrontMatterEntry[]
}

export interface KnownField {
  key: string
  /** 读取时按顺序匹配的别名；写入沿用命中的那个键名 */
  aliases: string[]
  label: string
  kind: 'text' | 'list' | 'textarea'
  placeholder?: string
}

export const FRONT_MATTER_FIELDS: KnownField[] = [
  { key: 'title', aliases: ['title'], label: '标题', kind: 'text', placeholder: '文档标题' },
  { key: 'author', aliases: ['author', 'authors'], label: '作者', kind: 'text', placeholder: '作者或组织' },
  { key: 'date', aliases: ['date', 'created', 'updated'], label: '日期', kind: 'text', placeholder: '如 2026-10-08' },
  { key: 'tags', aliases: ['tags', 'keywords'], label: '标签', kind: 'list', placeholder: '用逗号分隔，如：笔记, 教程' },
  {
    key: 'description',
    aliases: ['description', 'summary', 'abstract'],
    label: '摘要',
    kind: 'textarea',
    placeholder: '一两句话概括文档内容'
  }
]

/** 键行：顶格、不是注释、不是列表项，冒号前有非空键名 */
function keyOf(line: string): string | null {
  if (line === '' || /^[\s#]/.test(line) || /^\s*-\s/.test(line)) return null
  if (line.startsWith('---') || line.startsWith('...')) return null
  const index = line.indexOf(':')
  if (index <= 0) return null
  const key = line.slice(0, index).trim()
  return key === '' ? null : key
}

/** 从 Markdown 原文里取出 front matter 的块正文（不含 --- 标记）；没有返回 null */
export function frontMatterTextOf(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/)
  if (lines.length < 2 || lines[0].trim() !== '---') return null
  const limit = Math.min(lines.length, 1000)
  for (let index = 1; index < limit; index += 1) {
    const trimmed = lines[index].trim()
    if (trimmed === '---' || trimmed === '...') return lines.slice(1, index).join('\n')
  }
  return null
}

export function parseFrontMatter(raw: string): FrontMatterModel {
  const model: FrontMatterModel = { preamble: [], entries: [] }
  let current: FrontMatterEntry | null = null
  for (const line of raw.split(/\r?\n/)) {
    const key = keyOf(line)
    if (key !== null) {
      current = { key, lines: [line] }
      model.entries.push(current)
      continue
    }
    if (current !== null) current.lines.push(line)
    else model.preamble.push(line)
  }
  return model
}

function inlineValue(line: string): string {
  const index = line.indexOf(':')
  return index < 0 ? '' : line.slice(index + 1).trim()
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

/** 列表值：`[a, b]` 或换行后的 `- a` 两种写法都认；不是列表返回 null */
export function entryList(entry: FrontMatterEntry): string[] | null {
  const raw = inlineValue(entry.lines[0])
  if (raw.startsWith('[')) {
    const inner = raw.endsWith(']') ? raw.slice(1, -1) : raw.slice(1)
    return inner
      .split(',')
      .map((part) => unquote(part.trim()))
      .filter((part) => part !== '')
  }
  const items = entry.lines
    .slice(1)
    .filter((line) => /^\s*-\s+/.test(line))
    .map((line) => unquote(line.replace(/^\s*-\s+/, '').trim()))
  return items.length > 0 ? items : null
}

/** 单值：块标量（| 和 >）取续行，列表合成逗号串，其余剥引号 */
export function entryValue(entry: FrontMatterEntry): string {
  const raw = inlineValue(entry.lines[0])
  if (/^[|>][-+]?\d?$/.test(raw)) {
    const rest = entry.lines.slice(1).map((line) => line.replace(/^\s+/, ''))
    while (rest.length > 0 && rest[rest.length - 1].trim() === '') rest.pop()
    return raw.startsWith('>') ? rest.join(' ') : rest.join('\n')
  }
  const list = entryList(entry)
  if (list !== null) return list.join(', ')
  return unquote(raw)
}

function findEntry(model: FrontMatterModel, field: KnownField): FrontMatterEntry | undefined {
  return model.entries.find((entry) => field.aliases.includes(entry.key.toLowerCase()))
}

/** 表单初值：五个已知字段的当前文本 */
export function readFields(model: FrontMatterModel): Record<string, string> {
  const out: Record<string, string> = {}
  for (const field of FRONT_MATTER_FIELDS) {
    const entry = findEntry(model, field)
    out[field.key] = entry === undefined ? '' : entryValue(entry)
  }
  return out
}

const NEEDS_QUOTE = /[\n:#{}[\]&*!|>'"%@`,]|^\s|\s$|^[-?]/

function formatScalar(value: string): string {
  if (value === '' || NEEDS_QUOTE.test(value)) return JSON.stringify(value)
  return value
}

export function splitList(value: string): string[] {
  return value
    .split(/[,，;；]/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/**
 * 由表单值重建 YAML：已知字段按固定顺序在前（沿用原文的键名），
 * 其余条目连同注释与缩进原样排在其后。空字段不写出。
 */
export function buildFrontMatter(model: FrontMatterModel, values: Record<string, string>): string {
  const lines: string[] = [...model.preamble]
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  if (lines.length > 0) lines.push('')

  const consumed = new Set<FrontMatterEntry>()
  for (const field of FRONT_MATTER_FIELDS) {
    const entry = findEntry(model, field)
    if (entry !== undefined) consumed.add(entry)
    const value = (values[field.key] ?? '').trim()
    if (value === '') continue
    const key = entry?.key ?? field.key
    if (field.kind === 'list') {
      const items = splitList(value)
      if (items.length === 0) continue
      lines.push(`${key}: [${items.map((item) => formatScalar(item)).join(', ')}]`)
    } else {
      lines.push(`${key}: ${formatScalar(value)}`)
    }
  }

  for (const entry of model.entries) {
    if (consumed.has(entry)) continue
    lines.push(...entry.lines)
  }

  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines.join('\n')
}
