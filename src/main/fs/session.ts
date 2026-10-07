import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  normalizeContentWidth,
  normalizeExportOptions,
  normalizeFontSize,
  normalizeTheme,
  normalizeZoom,
  type SessionData
} from '../../shared/ipc'

const MAX_LIST = 24

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

export async function readSession(): Promise<SessionData | null> {
  try {
    const raw = await fs.readFile(sessionFile(), 'utf-8')
    const data = JSON.parse(raw) as Partial<SessionData>
    return {
      openDocs: dedupe(data.openDocs),
      active: typeof data.active === 'string' && data.active ? data.active : null,
      recents: dedupe(data.recents),
      folder: typeof data.folder === 'string' && data.folder ? data.folder : null,
      sidebar: typeof data.sidebar === 'boolean' ? data.sidebar : undefined,
      autoSave: typeof data.autoSave === 'boolean' ? data.autoSave : undefined,
      export: normalizeExportOptions(data.export),
      theme: normalizeTheme(data.theme),
      zoom: normalizeZoom(data.zoom),
      fontSize: normalizeFontSize(data.fontSize),
      contentWidth: normalizeContentWidth(data.contentWidth)
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
    sidebar: typeof session.sidebar === 'boolean' ? session.sidebar : undefined,
    autoSave: session.autoSave,
    export: normalizeExportOptions(session.export),
    theme: normalizeTheme(session.theme),
    zoom: normalizeZoom(session.zoom),
    fontSize: normalizeFontSize(session.fontSize),
    contentWidth: normalizeContentWidth(session.contentWidth)
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
