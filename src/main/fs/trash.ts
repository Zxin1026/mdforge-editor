import { shell } from 'electron'
import { FileOpError } from './error'
import { requireEntry } from './folder'

/**
 * 删除条目：走系统回收站而不是 fs.unlink——本地文档编辑器里删错了还能捞回来。
 * 授权口径与重命名/移动一致：只碰已授权文件夹里的真实条目。
 */
export async function trashPath(target: unknown): Promise<string> {
  const absolute = await requireEntry(target)
  try {
    await shell.trashItem(absolute)
  } catch (error) {
    throw new FileOpError('unknown', `移入回收站失败：${error instanceof Error ? error.message : String(error)}`, {
      path: absolute
    })
  }
  return absolute
}
