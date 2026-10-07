import { net, protocol } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isUnderGrantedRoot } from './fs/file-store'

export const ASSET_SCHEME = 'mdasset'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.svg'])

/** 必须在 app ready 之前调用 */
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

function targetOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.host !== 'file') return null
    let pathname = decodeURIComponent(parsed.pathname)
    if (process.platform === 'win32') pathname = pathname.replace(/^\/([a-zA-Z]:)/, '$1')
    else if (pathname.startsWith('//')) pathname = pathname.slice(1)
    return path.normalize(pathname)
  } catch {
    return null
  }
}

export function handleAssetRequests(): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    const target = targetOf(request.url)
    if (!target) return new Response('bad request', { status: 400 })
    if (!IMAGE_EXT.has(path.extname(target).toLowerCase())) {
      return new Response('unsupported type', { status: 415 })
    }
    if (!isUnderGrantedRoot(target)) {
      return new Response('forbidden', { status: 403 })
    }

    try {
      return await net.fetch(pathToFileURL(target).toString())
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}
