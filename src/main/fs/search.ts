import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  WorkspaceFileHit,
  WorkspaceMatch,
  WorkspaceReplaceFile,
  WorkspaceReplaceInput,
  WorkspaceReplaceResult,
  WorkspaceSearchInput,
  WorkspaceSearchResult
} from '../../shared/ipc'
import { decodeBuffer, encodeText } from './encoding'
import { FileOpError } from './error'
import { isUnderFolderRoot, writeFileAtomic } from './file-store'
import { walkMarkdownFiles } from './walk'

/** 超过这个体量的文件不做内容搜索（按普通笔记的尺度已经很大了） */
const MAX_FILE_BYTES = 2 * 1024 * 1024
/** 单文件最多收录的行命中数 */
const MAX_MATCHES_PER_FILE = 100
/** 一次搜索最多收录的总命中数 */
const MAX_TOTAL_MATCHES = 1000
/** 命中行预览的最大长度 */
const MAX_LINE_CHARS = 240
/** 正则替换防止病态输入卡死：匹配次数上限 */
const MAX_REPLACE_COUNT = 100_000

function requireUnderRoot(target: unknown, what: string): string {
  if (typeof target !== 'string' || !target || target.includes('\0')) {
    throw new FileOpError('invalid-path', `${what}不合法`, { path: String(target) })
  }
  const absolute = path.resolve(target)
  if (!isUnderFolderRoot(absolute)) {
    throw new FileOpError('not-granted', '这个文件夹还没有通过“打开文件夹”授权', {
      path: absolute,
      hint: '请先用「文件 → 打开文件夹…」选择它'
    })
  }
  return absolute
}

/** 把查询编译成正则：字面量模式先转义，正则模式原样编译并给出可读的报错 */
function buildMatcher(query: unknown, caseSensitive: boolean, regex: boolean): { source: string; flags: string } {
  if (typeof query !== 'string' || query === '') {
    throw new FileOpError('invalid-path', '搜索内容不能为空')
  }
  const flags = caseSensitive ? 'g' : 'gi'
  if (regex) {
    try {
      new RegExp(query, flags)
    } catch (error) {
      throw new FileOpError('invalid-path', `正则表达式无效：${error instanceof Error ? error.message : String(error)}`)
    }
    return { source: query, flags }
  }
  return { source: query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags }
}

function countMatches(text: string, source: string, flags: string): number {
  const re = new RegExp(source, flags.includes('g') ? flags : `${flags}g`)
  let count = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    count += 1
    // 空匹配（如 ^）不推进 lastIndex 会死循环，手动挪一格
    if (match.index === re.lastIndex) re.lastIndex += 1
    if (count >= MAX_REPLACE_COUNT) break
  }
  return count
}

/** 每行最多记一处命中（首处），行号与列号都从 1 起，列号相对 trim 后的文本 */
function collectLineMatches(
  text: string,
  source: string,
  flags: string,
  limit: number
): { matches: WorkspaceMatch[]; truncated: boolean } {
  const rows = text.split('\n')
  const matches: WorkspaceMatch[] = []
  let truncated = false
  for (let index = 0; index < rows.length; index += 1) {
    const line = rows[index]
    const re = new RegExp(source, flags)
    const found = re.exec(line)
    if (!found) continue
    const leading = line.length - line.trimStart().length
    const trimmed = line.trimStart()
    const trimmedForShow = trimmed.length > MAX_LINE_CHARS ? `${trimmed.slice(0, MAX_LINE_CHARS)}…` : trimmed
    const col = Math.max(1, found.index - leading + 1)
    const length = Math.min(found[0].length, Math.max(0, trimmedForShow.length - (col - 1)))
    matches.push({ line: index + 1, col, length, text: trimmedForShow })
    if (matches.length >= limit) {
      truncated = true
      break
    }
  }
  return { matches, truncated }
}

function testName(name: string, source: string, caseSensitive: boolean): boolean {
  return new RegExp(source, caseSensitive ? '' : 'i').test(name)
}

export async function searchWorkspace(input: WorkspaceSearchInput): Promise<WorkspaceSearchResult> {
  const root = requireUnderRoot(input?.dir, '文件夹路径')
  const matcher = buildMatcher(input?.query, input?.caseSensitive === true, input?.regex === true)

  const { files, truncated: walkTruncated } = await walkMarkdownFiles(root)
  const hits: WorkspaceFileHit[] = []
  let total = 0
  let truncated = walkTruncated

  for (const file of files) {
    if (total >= MAX_TOTAL_MATCHES) {
      truncated = true
      break
    }
    const nameMatch = testName(file.name, matcher.source, input.caseSensitive === true)

    let buffer: Buffer
    try {
      buffer = await fs.readFile(file.path)
    } catch {
      continue
    }
    const hash = createHash('sha1').update(buffer).digest('hex')

    // 大文件只认文件名：内容扫描跳过，但能搜索、也能进替换目标（替换时主进程会重读）
    if (file.size > MAX_FILE_BYTES) {
      if (nameMatch)
        hits.push({ path: file.path, name: file.name, hash, matches: [], truncated: false, nameMatch: true })
      continue
    }

    let decoded
    try {
      decoded = decodeBuffer(buffer)
    } catch {
      // 解码不认识的文件（也可能是外部工具的二进制）直接跳过
      continue
    }

    const { matches, truncated: fileTruncated } = collectLineMatches(
      decoded.text,
      matcher.source,
      matcher.flags,
      MAX_MATCHES_PER_FILE
    )
    if (!nameMatch && matches.length === 0) continue

    hits.push({
      path: file.path,
      name: file.name,
      hash,
      matches,
      truncated: fileTruncated,
      nameMatch
    })
    total += matches.length
  }

  return { files: hits, totalMatches: total, scanned: files.length, truncated }
}

export async function replaceWorkspace(input: WorkspaceReplaceInput): Promise<WorkspaceReplaceResult> {
  requireUnderRoot(input?.dir, '文件夹路径')
  const matcher = buildMatcher(input?.query, input?.caseSensitive === true, input?.regex === true)
  const replacement = typeof input?.replacement === 'string' ? input.replacement : ''
  const targets = Array.isArray(input?.targets) ? input.targets : []

  const files: WorkspaceReplaceFile[] = []
  let replacedFiles = 0
  let replacedMatches = 0

  for (const target of targets) {
    const rawPath = typeof target?.path === 'string' ? target.path : ''
    const name = path.basename(rawPath) || rawPath
    let absolute: string
    try {
      absolute = requireUnderRoot(rawPath, '目标文件路径')
    } catch (error) {
      files.push({ path: rawPath, name, replaced: 0, kind: 'error', detail: errorMessage(error) })
      continue
    }

    try {
      const buffer = await fs.readFile(absolute)
      const hash = createHash('sha1').update(buffer).digest('hex')
      if (typeof target?.hash === 'string' && target.hash !== '' && hash !== target.hash) {
        files.push({ path: absolute, name, replaced: 0, kind: 'skipped', detail: '搜索之后文件被改动过，已跳过' })
        continue
      }

      const decoded = decodeBuffer(buffer)
      const count = countMatches(decoded.text, matcher.source, matcher.flags)
      if (count === 0) {
        files.push({ path: absolute, name, replaced: 0, kind: 'ok' })
        continue
      }
      // 字面量替换不解释 $1 之类的占位；正则模式保留给用户当分组引用
      const next = input.regex
        ? decoded.text.replace(new RegExp(matcher.source, matcher.flags), replacement)
        : decoded.text.replace(new RegExp(matcher.source, matcher.flags), () => replacement)
      if (next === decoded.text) {
        files.push({ path: absolute, name, replaced: 0, kind: 'ok' })
        continue
      }

      await writeFileAtomic(absolute, encodeText(next, decoded.meta, absolute))
      files.push({ path: absolute, name, replaced: count, kind: 'ok' })
      replacedFiles += 1
      replacedMatches += count
    } catch (error) {
      files.push({ path: absolute, name, replaced: 0, kind: 'error', detail: errorMessage(error) })
    }
  }

  return { files, replacedFiles, replacedMatches }
}

function errorMessage(error: unknown): string {
  if (error instanceof FileOpError) return error.message
  return error instanceof Error ? error.message : String(error)
}
