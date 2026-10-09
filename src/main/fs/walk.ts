import { promises as fs } from 'node:fs'
import path from 'node:path'
import { WALK_MAX_FILES } from '../../shared/ipc'

export interface WalkedFile {
  path: string
  name: string
  size: number
}

const OPENABLE = new Set(['.md', '.markdown', '.mdown', '.mkd', '.txt'])

/** 搜索与链接索引共用的跳表：这些目录里不会有用户笔记 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', 'dist', 'out', 'build'])

const MAX_DEPTH = 12

/**
 * 递归收集文件夹里的可打开文件。
 * 符号链接一律跳过（lstat）：既避开环，也避免顺着链接读到授权范围外。
 */
export async function walkMarkdownFiles(root: string): Promise<{ files: WalkedFile[]; truncated: boolean }> {
  const files: WalkedFile[] = []
  let truncated = false

  async function visit(dir: string, depth: number): Promise<void> {
    if (truncated || depth > MAX_DEPTH) return
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (truncated) return
      if (name.startsWith('.')) continue
      const full = path.join(dir, name)
      let stat
      try {
        stat = await fs.lstat(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(name.toLowerCase())) continue
        await visit(full, depth + 1)
      } else if (stat.isFile() && OPENABLE.has(path.extname(name).toLowerCase())) {
        files.push({ path: full, name, size: stat.size })
        if (files.length >= WALK_MAX_FILES) truncated = true
      }
    }
  }

  const stat = await fs.stat(root).catch(() => null)
  if (!stat || !stat.isDirectory()) return { files: [], truncated: false }
  await visit(root, 0)
  return { files, truncated }
}
