import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AssetInfo, ResourceProbeInput, ResourceProbeResult, ResourceState } from '../../shared/ipc'
import { FileOpError } from './error'
import { isUnderGrantedRoot } from './file-store'

/** 一次检查的引用上限：正常文档远达不到，只用来兜住恶意参数 */
const MAX_REFS = 500
const MAX_ASSET_FILES = 400
const MAX_DEPTH = 4

const IGNORED = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.next', '__pycache__'])

async function stateOf(absolute: string): Promise<ResourceState> {
  // 授权范围之外一律按未知返回：既不确认也不否定，避免变成目录探测接口
  if (!isUnderGrantedRoot(absolute)) return 'unknown'
  try {
    const stat = await fs.stat(absolute)
    return stat.isDirectory() ? 'directory' : 'ok'
  } catch {
    return 'missing'
  }
}

async function walkAssets(dir: string, docDir: string, out: AssetInfo[], depth: number): Promise<void> {
  if (out.length >= MAX_ASSET_FILES || depth > MAX_DEPTH) return
  const names = await fs.readdir(dir).catch(() => [] as string[])
  for (const name of names) {
    if (IGNORED.has(name) || name.startsWith('.')) continue
    const full = path.join(dir, name)
    const stat = await fs.stat(full).catch(() => null)
    if (stat === null) continue
    if (stat.isDirectory()) {
      await walkAssets(full, docDir, out, depth + 1)
    } else if (stat.isFile() && out.length < MAX_ASSET_FILES) {
      out.push({
        relative: path.relative(docDir, full).split(path.sep).join('/'),
        absolute: full,
        size: stat.size
      })
    }
  }
}

/** 文档检查的数据来源：引用存在性 + 文档 assets/ 目录实际内容 */
export async function probeResources(input: ResourceProbeInput): Promise<ResourceProbeResult> {
  const docPath = input.docPath
  if (!docPath || docPath.includes('\0') || !path.isAbsolute(docPath)) {
    throw new FileOpError('invalid-path', '文档路径不可用，无法检查引用', { path: docPath })
  }
  const docDir = path.dirname(path.resolve(docPath))

  const states: ResourceState[] = []
  for (const ref of input.refs.slice(0, MAX_REFS)) {
    if (!ref || ref.includes('\0') || !path.isAbsolute(ref)) {
      states.push('outside')
      continue
    }
    states.push(await stateOf(path.resolve(ref)))
  }

  const assets: AssetInfo[] = []
  if (isUnderGrantedRoot(docDir)) await walkAssets(path.join(docDir, 'assets'), docDir, assets, 0)
  return { states, assets }
}
