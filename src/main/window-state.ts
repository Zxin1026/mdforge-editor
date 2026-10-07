/**
 * 窗口位置尺寸的持久化：主进程独管 userData/window-state.json。
 * 不并进 session.json——那份文件由渲染进程整体覆写，两个写入方会互相丢字段。
 */
import { mkdirSync, promises as fs, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

const MIN_WIDTH = 640
const MIN_HEIGHT = 400
/** 至少这么多像素落在某块屏幕的工作区内，位置才值得恢复 */
const VISIBLE_X = 64
const VISIBLE_Y = 32

function num(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : undefined
}

export function normalizeWindowState(raw: unknown): WindowState | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const data = raw as Partial<WindowState>
  const width = num(data.width)
  const height = num(data.height)
  if (width === undefined || height === undefined) return undefined
  if (width < MIN_WIDTH || height < MIN_HEIGHT) return undefined
  return {
    x: num(data.x),
    y: num(data.y),
    width,
    height,
    maximized: data.maximized === true
  }
}

function overlaps(a: Rect, b: Rect): boolean {
  const x = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const y = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return x >= VISIBLE_X && y >= VISIBLE_Y
}

/** 位置仍落在某块屏幕上才恢复（显示器拔掉后不能把窗口丢到看不见的地方）；否则交给系统摆位 */
export function fitToDisplays(state: WindowState, workAreas: Rect[]): Rect | undefined {
  if (state.x === undefined || state.y === undefined) return undefined
  const rect: Rect = { x: state.x, y: state.y, width: state.width, height: state.height }
  return workAreas.some((area) => overlaps(rect, area)) ? rect : undefined
}

export async function readWindowState(dir: string): Promise<WindowState | undefined> {
  try {
    const raw = await fs.readFile(path.join(dir, 'window-state.json'), 'utf-8')
    return normalizeWindowState(JSON.parse(raw))
  } catch {
    return undefined
  }
}

/** 写失败不值得打扰用户：窗口状态只是便利信息 */
export function saveWindowState(dir: string, state: WindowState): void {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'window-state.json'), JSON.stringify(state, null, 2), 'utf-8')
  } catch {
    // 忽略
  }
}
