/** 渲染进程侧的纯路径工具：不依赖 node:path，路径一律按 posix 处理 */

export function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

export function driveOfPath(value: string): string {
  return /^([a-zA-Z]:)/.exec(value)?.[1].toLowerCase() ?? ''
}

/** 目录部分；没有分隔符时返回空串（供相对链接计算） */
export function dirOfPath(target: string): string {
  const index = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'))
  return index < 0 ? '' : target.slice(0, index)
}

/** 折叠 . 与 ..；保留盘符与开头斜杠 */
export function collapsePath(value: string): string {
  const drive = /^([a-zA-Z]:)\//.exec(value)?.[1] ?? ''
  const rest = drive === '' ? value : value.slice(drive.length)
  const absolute = rest.startsWith('/')
  const stack: string[] = []
  for (const part of rest.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') stack.pop()
      continue
    }
    stack.push(part)
  }
  const joined = stack.join('/')
  if (drive !== '') return joined === '' ? drive : `${drive}/${joined}`
  return absolute ? `/${joined}` : joined
}

/** 相对引用 → 绝对路径：支持 ../、./ 与盘符根引用 */
export function resolvePath(baseDir: string, relative: string): string {
  const base = baseDir.replace(/\\/g, '/')
  const rel = relative.replace(/\\/g, '/')
  if (driveOfPath(rel) !== '') return collapsePath(rel)
  if (rel.startsWith('/')) {
    // 保留原盘符大小写（C: 不能写成 c:）
    const drive = /^([a-zA-Z]:)/.exec(base)?.[1] ?? ''
    return collapsePath(drive === '' ? rel : `${drive}${rel}`)
  }
  return collapsePath(`${base}/${rel}`)
}

/** 两端都是相对路径时直接返回 target（站点内的链接计算走这里） */
export function relativePosix(root: string, target: string): string | null {
  const base = normalizePath(root)
  const full = normalizePath(target)
  const baseKey = base.toLowerCase()
  const fullKey = full.toLowerCase()
  if (fullKey === baseKey) return ''
  if (!fullKey.startsWith(`${baseKey}/`)) return null
  return full.slice(base.length + 1)
}

/** target 相对 fromDir 的 posix 路径；跨盘符或无法表示时返回 null */
export function relativeBetween(fromDir: string, target: string): string | null {
  const dir = normalizePath(fromDir)
  const full = normalizePath(target)
  if (dir === '') return full
  if (driveOfPath(dir) !== driveOfPath(full)) return null
  const dirParts = dir.split('/')
  const fullParts = full.split('/')
  let common = 0
  while (
    common < dirParts.length &&
    common < fullParts.length &&
    dirParts[common].toLowerCase() === fullParts[common].toLowerCase()
  ) {
    common += 1
  }
  const ups = dirParts.length - common
  const rest = fullParts.slice(common)
  return [...Array.from({ length: ups }, () => '..'), ...rest].join('/')
}
