import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  normalizeContentWidth,
  normalizeExportOptions,
  normalizeFontSize,
  normalizeSidebarWidth,
  normalizeSplitRatio,
  normalizeTheme,
  normalizeViewMode,
  normalizeZoom,
  type SessionData
} from '../../shared/ipc'

const MAX_LIST = 24
/** 会话里最多记这么多条键位覆盖 */
const MAX_KEYBINDINGS = 200

function sessionFile(): string {
  return path.join(app.getPath('userData'), 'session.json')
}

function dedupe(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const item of list) {
    if (typeof item === 'string' && item && !out.includes(item)) out.push(item)
  }
  return out.slice(0, MAX_LIST)
}

/** 键位覆盖的形状检查：渲染进程还会再按命令表逐条校验 */
function sanitizeKeybindings(raw: unknown): Record<string, string | null> | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const out: Record<string, string | null> = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof id !== 'string' || id === '') continue
    if (value === null) out[id] = null
    else if (typeof value === 'string' && value !== '' && value.length <= 40) out[id] = value
    if (Object.keys(out).length >= MAX_KEYBINDINGS) break
  }
  return out
}

export async function readSession(): Promise<SessionData | null> {
  try {
    const raw = await fs.readFile(sessionFile(), 'utf-8')
    const data = JSON.parse(raw) as Partial<SessionData>
    return {
      openDocs: dedupe(data.openDocs),
      active: typeof data.active === 'string' && data.active ? data.active : null,
      recents: dedupe(data.recents),
      folder: typeof data.folder === 'string' && data.folder ? data.folder : null,
      favorites: dedupe(data.favorites),
      sidebar: typeof data.sidebar === 'boolean' ? data.sidebar : undefined,
      autoSave: typeof data.autoSave === 'boolean' ? data.autoSave : undefined,
      export: normalizeExportOptions(data.export),
      theme: normalizeTheme(data.theme),
      zoom: normalizeZoom(data.zoom),
      fontSize: normalizeFontSize(data.fontSize),
      contentWidth: normalizeContentWidth(data.contentWidth),
      viewMode: normalizeViewMode(data.viewMode),
      typewriter: typeof data.typewriter === 'boolean' ? data.typewriter : undefined,
      focusMode: typeof data.focusMode === 'boolean' ? data.focusMode : undefined,
      sidebarWidth: normalizeSidebarWidth(data.sidebarWidth),
      splitRatio: normalizeSplitRatio(data.splitRatio),
      keybindings: sanitizeKeybindings(data.keybindings)
    }
  } catch {
    return null
  }
}

export async function writeSession(session: SessionData): Promise<void> {
  const payload: SessionData = {
    openDocs: dedupe(session.openDocs),
    active: session.active,
    recents: dedupe(session.recents),
    folder: typeof session.folder === 'string' && session.folder ? session.folder : null,
    favorites: dedupe(session.favorites),
    sidebar: typeof session.sidebar === 'boolean' ? session.sidebar : undefined,
    autoSave: session.autoSave,
    export: normalizeExportOptions(session.export),
    theme: normalizeTheme(session.theme),
    zoom: normalizeZoom(session.zoom),
    fontSize: normalizeFontSize(session.fontSize),
    contentWidth: normalizeContentWidth(session.contentWidth),
    viewMode: normalizeViewMode(session.viewMode),
    typewriter: typeof session.typewriter === 'boolean' ? session.typewriter : undefined,
    focusMode: typeof session.focusMode === 'boolean' ? session.focusMode : undefined,
    sidebarWidth: normalizeSidebarWidth(session.sidebarWidth),
    splitRatio: normalizeSplitRatio(session.splitRatio),
    keybindings: sanitizeKeybindings(session.keybindings)
  }
  const file = sessionFile()
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  try {
    await fs.writeFile(temp, JSON.stringify(payload, null, 2), 'utf-8')
    await fs.rename(temp, file)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}
