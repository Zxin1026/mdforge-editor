import { watch as fsWatch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import type { ExternalChange } from '../../shared/ipc'
import { cacheKeyOf, diskState, rememberedHash } from './file-store'

type Listener = (change: ExternalChange) => void

interface DirWatch {
  dir: string
  handle: FSWatcher | null
  /** 小写文件名 -> 该目录下被监测的绝对路径 */
  files: Map<string, string[]>
}

/** 事件风暴合并窗口：原子保存会连续产生 rename 与 change，还会顺带写临时文件 */
const DEBOUNCE_MS = 250

const dirs = new Map<string, DirWatch>()
/** 文件键 -> 绝对路径 */
const wanted = new Map<string, string>()
/** 已经上报过的磁盘哈希：用户还没决策时不再重复弹窗 */
const notified = new Map<string, string | null>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const listeners = new Set<Listener>()

function fileKeyOf(absolute: string): string {
  return cacheKeyOf(path.resolve(absolute))
}

function emit(change: ExternalChange): void {
  for (const listener of listeners) listener(change)
}

async function investigate(key: string, absolute: string): Promise<void> {
  timers.delete(key)
  if (!wanted.has(key)) return

  let current: { hash: string; mtimeMs: number } | null
  try {
    current = await diskState(absolute)
  } catch {
    // 读取失败（占用、权限）说明文件还在，等下一次事件再看
    return
  }
  const hash = current?.hash ?? null

  // 与我们上次载入/保存的内容一致：多半是自己写的盘，不是外部改动
  if (hash === rememberedHash(absolute)) return
  if (notified.has(key) && notified.get(key) === hash) return
  notified.set(key, hash)

  emit({
    path: absolute,
    kind: hash === null ? 'deleted' : 'modified',
    hash,
    mtimeMs: current?.mtimeMs ?? 0
  })
}

function schedule(key: string): void {
  const absolute = wanted.get(key)
  if (!absolute) return
  const pending = timers.get(key)
  if (pending) clearTimeout(pending)
  timers.set(
    key,
    setTimeout(() => void investigate(key, absolute), DEBOUNCE_MS)
  )
}

function probeAll(dirWatch: DirWatch): void {
  for (const list of dirWatch.files.values()) for (const file of list) schedule(fileKeyOf(file))
}

function attach(dirWatch: DirWatch): void {
  if (dirWatch.handle || dirWatch.files.size === 0) return
  try {
    const handle = fsWatch(dirWatch.dir, (_event, filename) => {
      if (!filename) {
        probeAll(dirWatch)
        return
      }
      const list = dirWatch.files.get(String(filename).toLowerCase())
      if (list) for (const file of list) schedule(fileKeyOf(file))
    })
    // 目录被删除或移出可达范围时监听器会报错，逐个复查文件即可得出"已删除"
    handle.on('error', () => {
      dirWatch.handle?.close()
      dirWatch.handle = null
      probeAll(dirWatch)
    })
    dirWatch.handle = handle
  } catch {
    dirWatch.handle = null
  }
}

export function watchFile(absolute: string): void {
  if (!absolute || !path.isAbsolute(absolute)) return
  const resolved = path.resolve(absolute)
  const key = fileKeyOf(resolved)
  if (wanted.has(key)) return
  wanted.set(key, resolved)

  const dir = path.dirname(resolved)
  const dirKey = cacheKeyOf(dir)
  let dirWatch = dirs.get(dirKey)
  if (!dirWatch) {
    dirWatch = { dir, handle: null, files: new Map() }
    dirs.set(dirKey, dirWatch)
  }
  const base = path.basename(resolved).toLowerCase()
  const list = dirWatch.files.get(base) ?? []
  if (!list.includes(resolved)) list.push(resolved)
  dirWatch.files.set(base, list)
  attach(dirWatch)
}

export function unwatchFile(absolute: string): void {
  if (!absolute || !path.isAbsolute(absolute)) return
  const resolved = path.resolve(absolute)
  const key = fileKeyOf(resolved)
  wanted.delete(key)
  notified.delete(key)

  const pending = timers.get(key)
  if (pending) {
    clearTimeout(pending)
    timers.delete(key)
  }

  const dirKey = cacheKeyOf(path.dirname(resolved))
  const dirWatch = dirs.get(dirKey)
  if (!dirWatch) return

  const base = path.basename(resolved).toLowerCase()
  const list = (dirWatch.files.get(base) ?? []).filter((file) => fileKeyOf(file) !== key)
  if (list.length > 0) dirWatch.files.set(base, list)
  else dirWatch.files.delete(base)

  if (dirWatch.files.size === 0) {
    dirWatch.handle?.close()
    dirs.delete(dirKey)
  }
}

export function onExternalChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function stopAllWatchers(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  for (const dirWatch of dirs.values()) dirWatch.handle?.close()
  dirs.clear()
  wanted.clear()
  notified.clear()
}
