import { promises as fs } from 'node:fs'
import path from 'node:path'
import { entryList, entryValue, frontMatterTextOf, parseFrontMatter } from '../../shared/frontmatter-yaml'
import type { DocRef, TagIndexResult } from '../../shared/ipc'
import { decodeBuffer } from './encoding'
import { FileOpError } from './error'
import { isUnderFolderRoot } from './file-store'
import { walkMarkdownFiles } from './walk'

/** 超过这个体量的文件不读内容（照常进文档清单） */
const MAX_FILE_BYTES = 2 * 1024 * 1024
/** 单个标签的长度上限 */
const TAG_MAX_CHARS = 40
/** 每篇文档收录的标签数上限 */
const TAGS_PER_DOC = 30

function splitFlat(value: string): string[] {
  return value
    .split(/[,，;；]/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

function normalizeTags(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of values) {
    const tag = raw.trim().replace(/^#+/, '').trim().slice(0, TAG_MAX_CHARS)
    if (tag === '') continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= TAGS_PER_DOC) break
  }
  return out
}

/** 扫描文件夹里每个文档 front matter 的 tags / keywords（列表、逗号串两种写法都认） */
export async function scanTags(dir: string): Promise<TagIndexResult> {
  if (typeof dir !== 'string' || !dir || dir.includes('\0')) {
    throw new FileOpError('invalid-path', '文件夹路径不合法', { path: String(dir) })
  }
  const absolute = path.resolve(dir)
  if (!isUnderFolderRoot(absolute)) {
    throw new FileOpError('not-granted', '这个文件夹还没有通过“打开文件夹”授权', {
      path: absolute,
      hint: '请先用「文件 → 打开文件夹…」选择它'
    })
  }

  const { files, truncated } = await walkMarkdownFiles(absolute)
  const refs: DocRef[] = []
  const docs: TagIndexResult['docs'] = []

  for (const file of files) {
    refs.push({ path: file.path, name: file.name })
    if (file.size > MAX_FILE_BYTES) continue
    let text: string
    try {
      text = decodeBuffer(await fs.readFile(file.path)).text
    } catch {
      continue
    }
    const raw = frontMatterTextOf(text)
    if (raw === null) continue
    const model = parseFrontMatter(raw)
    const entry = model.entries.find((item) => ['tags', 'keywords'].includes(item.key.toLowerCase()))
    if (entry === undefined) continue
    const tags = normalizeTags(entryList(entry) ?? splitFlat(entryValue(entry)))
    if (tags.length === 0) continue
    docs.push({ path: file.path, name: file.name, tags })
  }

  return { files: refs, docs, truncated }
}
