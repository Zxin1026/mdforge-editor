import { promises as fs } from 'node:fs'
import path from 'node:path'
import { scanFences } from '../../shared/fences'
import type { DocLink, DocRef, LinkIndexResult } from '../../shared/ipc'
import { decodeBuffer } from './encoding'
import { FileOpError } from './error'
import { isUnderFolderRoot } from './file-store'
import { walkMarkdownFiles } from './walk'

const MD_EXT = /\.(md|markdown|mdown|mkd|txt)$/i
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const LINK = /(?<!!)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?[^)]*\)/g
const MAX_LINE_CHARS = 120

function keyOf(target: string): string {
  const resolved = path.resolve(target)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function decodeTarget(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** 行内出链：跳过代码围栏，只看指向文件夹内部文档的 Markdown 链接 */
export async function scanLinks(dir: string): Promise<LinkIndexResult> {
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

  const { files } = await walkMarkdownFiles(absolute)
  const byKey = new Map<string, DocRef>()
  for (const file of files) {
    byKey.set(keyOf(file.path), { path: file.path, name: file.name })
  }

  const links: DocLink[] = []
  for (const file of files) {
    let text: string
    try {
      const buffer = await fs.readFile(file.path)
      text = decodeBuffer(buffer).text
    } catch {
      continue
    }
    const { fenced } = scanFences(text)
    const rows = text.split('\n')
    const baseDir = path.dirname(file.path)
    for (let index = 0; index < rows.length; index += 1) {
      if (fenced.has(index + 1)) continue
      const line = rows[index]
      if (!line.includes('](')) continue
      LINK.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = LINK.exec(line)) !== null) {
        const raw = decodeTarget(match[2].trim())
        if (raw === '') continue
        const hashIdx = raw.indexOf('#')
        const filePart = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw
        if (filePart === '') continue
        if (SCHEME.test(filePart)) continue
        if (!MD_EXT.test(filePart)) continue
        const resolved = keyOf(path.resolve(baseDir, filePart))
        const target = byKey.get(resolved)
        if (!target) continue
        const trimmed = line.trim()
        links.push({
          from: file.path,
          to: target.path,
          line: index + 1,
          text: trimmed.length > MAX_LINE_CHARS ? `${trimmed.slice(0, MAX_LINE_CHARS)}…` : trimmed
        })
      }
    }
  }

  return { files: [...byKey.values()], links }
}
