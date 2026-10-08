import { promises as fs } from 'node:fs'
import path from 'node:path'
import { scanFences } from '../../shared/fences'
import { createSlugger, headingTitle } from '../../shared/slug'
import type {
  AnchorState,
  AssetInfo,
  ResourceAnchorInput,
  ResourceProbeInput,
  ResourceProbeResult,
  ResourceState
} from '../../shared/ipc'
import { decodeBuffer } from './encoding'
import { FileOpError } from './error'
import { cacheKeyOf, isUnderGrantedRoot } from './file-store'

/** 一次检查的引用上限：正常文档远达不到，只用来兜住恶意参数 */
const MAX_REFS = 500
const MAX_ASSET_FILES = 400
const MAX_DEPTH = 4

const IGNORED = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.next', '__pycache__'])

/** 文档同级会被清点的资源：散落在正文旁边的图片（扩展名口径与图片预览一致） */
const SIBLING_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif', '.ico'])

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

/** 文档同级散落的资源（只看直接子级，不递归）：只认图片/附件扩展名，免得把相邻文档也算成资源 */
async function walkSiblingAssets(dir: string, out: AssetInfo[]): Promise<void> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  for (const name of names) {
    if (name.startsWith('.') || out.length >= MAX_ASSET_FILES) continue
    if (!SIBLING_EXT.has(path.extname(name).toLowerCase())) continue
    const full = path.join(dir, name)
    const stat = await fs.stat(full).catch(() => null)
    if (stat === null || !stat.isFile()) continue
    out.push({ relative: name, absolute: full, size: stat.size })
  }
}

const ATX_HEADING = /^ {0,3}#{1,6}[ \t]+\S/
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/

/** front matter 块的收尾行下标；没有收尾按"不存在 front matter"处理（与编辑器口径一致只认首行 ---） */
function frontMatterEnd(lines: readonly string[]): number {
  if ((lines[0] ?? '').trim() !== '---') return -1
  for (let index = 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim()
    if (trimmed === '---' || trimmed === '...') return index
  }
  return -1
}

/**
 * 文档里的全部标题锚点。口径与编辑器大纲一致：跳过围栏代码与 front matter，
 * ATX 与 setext 两类标题都收，slug 走共享的 headingTitle + createSlugger。
 */
export function headingSlugsOf(text: string): Set<string> {
  const lines = text.split('\n')
  const { fenced } = scanFences(text)
  const matterEnd = frontMatterEnd(lines)
  const slugger = createSlugger()
  const slugs = new Set<string>()

  for (let index = 0; index < lines.length; index += 1) {
    if (fenced.has(index + 1) || index <= matterEnd) continue
    const line = lines[index]
    if (ATX_HEADING.test(line)) {
      slugs.add(slugger.slug(headingTitle(line)))
      continue
    }
    if (!SETEXT_UNDERLINE.test(line)) continue
    // setext 的下划线要贴着上一行正文才成立：空行（分隔线）、代码、front matter 与标题行都不算
    const previousIndex = index - 1
    const previous = previousIndex >= 0 ? lines[previousIndex] : ''
    if (previous.trim() === '' || fenced.has(index) || previousIndex <= matterEnd || ATX_HEADING.test(previous)) continue
    slugs.add(slugger.slug(headingTitle(previous)))
  }
  return slugs
}

async function anchorStateOf(item: ResourceAnchorInput, cache: Map<string, Set<string> | null>): Promise<AnchorState> {
  if (!item.path || item.path.includes('\0') || !path.isAbsolute(item.path)) return 'unknown'
  if (!item.anchor || !isUnderGrantedRoot(item.path)) return 'unknown'
  const key = cacheKeyOf(path.resolve(item.path))
  let slugs = cache.get(key)
  if (slugs === undefined) {
    try {
      slugs = headingSlugsOf(decodeBuffer(await fs.readFile(path.resolve(item.path))).text)
    } catch {
      slugs = null
    }
    cache.set(key, slugs)
  }
  if (slugs === null) return 'unknown'
  return slugs.has(item.anchor) ? 'ok' : 'missing'
}

/** 文档检查的数据来源：引用存在性 + 跨文档锚点 + 文档周边的实际资源文件 */
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

  const anchorStates: AnchorState[] = []
  const headingCache = new Map<string, Set<string> | null>()
  for (const item of (input.anchors ?? []).slice(0, MAX_REFS)) {
    anchorStates.push(await anchorStateOf(item, headingCache))
  }

  const assets: AssetInfo[] = []
  if (isUnderGrantedRoot(docDir)) {
    await walkSiblingAssets(docDir, assets)
    await walkAssets(path.join(docDir, 'assets'), docDir, assets, 0)
  }
  return { states, assets, anchorStates }
}
