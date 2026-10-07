import { existsSync } from 'node:fs'
import path from 'node:path'
import { grantPath } from './file-store'

const OPENABLE = new Set(['.md', '.markdown', '.mdown', '.mkd', '.txt'])

const pending: string[] = []

/** 只接受绝对路径：Electron 各启动方式的相对路径基准不可靠 */
export function collectFromArgv(argv: readonly string[]): void {
  for (const item of argv.slice(1)) {
    if (item.startsWith('-')) continue
    if (!path.isAbsolute(item)) continue
    if (!OPENABLE.has(path.extname(item).toLowerCase())) continue
    if (!existsSync(item)) continue

    grantPath(item)
    if (!pending.includes(item)) pending.push(item)
  }
}

export function startupPaths(): string[] {
  return [...pending]
}
