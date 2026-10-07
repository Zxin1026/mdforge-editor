import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DocDraft } from '../../shared/ipc'

/**
 * 崩溃草稿只服务于"进程被杀掉 / 断电"这类异常退出。
 * 正常保存和主动放弃修改都会立即删掉对应草稿，所以重启后还在的一定向征着没写盘的改动。
 */

let root: string | null = null

export function initDraftStore(dir: string): void {
  root = dir
}

function draftRoot(): string {
  if (!root) throw new Error('草稿目录尚未初始化')
  return root
}

/** key 里带绝对路径与盘符，散列成干净的文件名才能跨平台落盘 */
function fileFor(key: string): string {
  const name = createHash('sha1').update(key).digest('hex')
  return path.join(draftRoot(), `${name}.json`)
}

function isDraft(draft: Partial<DocDraft>): draft is DocDraft {
  return (
    typeof draft.key === 'string' &&
    draft.key.length > 0 &&
    typeof draft.text === 'string' &&
    typeof draft.name === 'string' &&
    (draft.path === null || typeof draft.path === 'string') &&
    draft.meta !== undefined &&
    draft.meta !== null
  )
}

export async function draftWrite(draft: DocDraft): Promise<void> {
  const file = fileFor(draft.key)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  try {
    await fs.writeFile(temp, JSON.stringify(draft), 'utf-8')
    await fs.rename(temp, file)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

export async function draftList(): Promise<DocDraft[]> {
  let names: string[]
  try {
    names = await fs.readdir(draftRoot())
  } catch {
    return []
  }
  const drafts: DocDraft[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(draftRoot(), name), 'utf-8')) as Partial<DocDraft>
      if (isDraft(parsed)) drafts.push(parsed)
    } catch {
      /* 写了一半的草稿直接跳过，不能让它挡住启动 */
    }
  }
  return drafts.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

export async function draftClear(keys: readonly string[]): Promise<void> {
  await Promise.all(keys.map((key) => fs.rm(fileFor(key), { force: true }).catch(() => {})))
}
