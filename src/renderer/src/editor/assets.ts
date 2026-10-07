const ASSET_PREFIX = 'mdasset://file/'
const REMOTE = /^(https?:|data:|blob:|mdasset:)/i

export function dirOf(absolutePath: string): string {
  const index = Math.max(absolutePath.lastIndexOf('/'), absolutePath.lastIndexOf('\\'))
  return index < 0 ? '' : absolutePath.slice(0, index)
}

function driveRoot(absolutePath: string): string | null {
  const match = /^([a-zA-Z]:\/)/.exec(absolutePath)
  return match ? match[1] : null
}

function decode(src: string): string {
  try {
    return decodeURIComponent(src)
  } catch {
    return src
  }
}

/** 折叠 . 与 ..，避免 ../ 逃出文档所在目录 */
function collapse(path: string): string {
  const winRoot = /^[a-zA-Z]:\//.test(path)
  const parts = path.split('/')
  const stack: string[] = []

  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') stack.pop()
      continue
    }
    stack.push(part)
  }

  const joined = stack.join('/')
  if (winRoot) return joined
  return path.startsWith('/') ? `/${joined}` : joined
}

export function stripTitle(src: string): string {
  const match = /^(.*?)\s+(?:"[^"]*"|'[^']*'|\([^)]*\))$/.exec(src)
  return match ? match[1] : src
}

const WIDTH_TOKEN = /(^|\s)w=(\d+)(px)?(?=\s|$)/i

/**
 * 图片宽度写在链接的 title 槽里（`![说明](a.png "w=640")`），
 * 这样源文本仍是合法 CommonMark，导出与外部编辑器都能正常显示图片。
 */
export function widthFromTitle(title: string | null): number | null {
  if (title === null) return null
  const match = WIDTH_TOKEN.exec(title)
  if (!match) return null
  const width = Number.parseInt(match[2], 10)
  return Number.isFinite(width) && width > 0 ? width : null
}

/** 在原 title 上改写宽度提示，保留用户已有的说明文字 */
export function titleWithWidth(title: string | null, width: number): string {
  const token = `w=${Math.max(1, Math.round(width))}`
  if (title === null || title.trim() === '') return `"${token}"`
  if (WIDTH_TOKEN.test(title)) return `"${title.replace(WIDTH_TOKEN, `$1${token}`)}"`
  return `"${title.trim()} ${token}"`
}

/**
 * 把 Markdown 里的图片地址解析为本地绝对路径。
 * 远程与 data: 地址返回 null：v1 不发起网络请求，也不内联外部数据。
 */
export function resolveLocalPath(docPath: string, rawSrc: string): string | null {
  if (!docPath) return null

  let src = stripTitle(rawSrc.trim())
  if (src.startsWith('<') && src.endsWith('>')) src = src.slice(1, -1)
  src = src.split('#')[0]
  if (src === '' || REMOTE.test(src)) return null
  src = decode(src).replace(/\\/g, '/')

  if (/^[a-zA-Z]:\//.test(src)) return collapse(src)
  if (src.startsWith('/')) {
    const root = driveRoot(docPath.replace(/\\/g, '/'))
    return collapse(root ? `${root}${src.slice(1)}` : src)
  }
  return collapse(`${dirOf(docPath.replace(/\\/g, '/'))}/${src}`)
}

export function assetUrl(docPath: string, rawSrc: string): string | null {
  const local = resolveLocalPath(docPath, rawSrc)
  if (!local) return null
  return `${ASSET_PREFIX}${encodeURIComponent(local)}`
}
