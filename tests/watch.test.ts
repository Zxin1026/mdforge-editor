import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExternalChange } from '../src/shared/ipc'
import { grantPath, readFile, resetFileStore, writeFile } from '../src/main/fs/file-store'
import { onExternalChange, stopAllWatchers, unwatchFile, watchFile } from '../src/main/fs/watch'

const TIMEOUT = 20000

let dir: string
let events: ExternalChange[]
let detach: (() => void) | null = null

beforeEach(() => {
  resetFileStore()
  stopAllWatchers()
  events = []
  detach = onExternalChange((change) => events.push(change))
  dir = mkdtempSync(path.join(tmpdir(), 'mdforge-watch-'))
})

afterEach(() => {
  detach?.()
  detach = null
  stopAllWatchers()
})

function fileIn(name: string): string {
  return path.join(dir, name)
}

async function waitFor(until: (list: ExternalChange[]) => boolean, timeoutMs = 12000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (until(events)) return true
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  return until(events)
}

/** 静默窗口：确认"没有事件"本身就是期望 */
async function quiet(ms = 900): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function open(target: string, content: string): string {
  writeFileSync(target, content, 'utf8')
  grantPath(target)
  return target
}

describe('外部修改监测', () => {
  it(
    '别的程序改了文件会上报 modified',
    async () => {
      const target = open(fileIn('a.md'), '# 原始\n')
      const loaded = await readFile(target)
      watchFile(target)

      writeFileSync(target, '# 外部改动\n', 'utf8')
      expect(await waitFor((list) => list.length > 0)).toBe(true)
      expect(events[0].kind).toBe('modified')
      expect(events[0].path.toLowerCase()).toBe(target.toLowerCase())
      expect(events[0].hash).not.toBe(loaded.hash)
    },
    TIMEOUT
  )

  it(
    '自己保存不会被当成外部改动',
    async () => {
      const target = open(fileIn('self.md'), '# 原始\n')
      const loaded = await readFile(target)
      watchFile(target)

      await writeFile({ path: target, text: '# 自己改的\n', meta: loaded.meta, baseHash: loaded.hash })
      await quiet()
      expect(events).toEqual([])

      // 自己写完之后再被外部改动，仍然要报
      writeFileSync(target, '# 外部又改了\n', 'utf8')
      expect(await waitFor((list) => list.length > 0)).toBe(true)
    },
    TIMEOUT
  )

  it(
    '同一份外部改动只上报一次，等用户决策',
    async () => {
      const target = open(fileIn('once.md'), '# 原样\n')
      await readFile(target)
      watchFile(target)

      writeFileSync(target, '# 外部改动\n', 'utf8')
      expect(await waitFor((list) => list.length > 0)).toBe(true)

      // 用户还没决策时，同一份内容反复触发事件也不应再报一次
      writeFileSync(target, '# 外部改动\n', 'utf8')
      await quiet(1500)
      expect(events.filter((event) => event.hash !== null)).toHaveLength(1)
    },
    TIMEOUT
  )

  it(
    '内容改回原样（哈希一致）不再上报',
    async () => {
      const target = open(fileIn('same.md'), '# 原样\n')
      await readFile(target)
      watchFile(target)

      writeFileSync(target, '# 改过又改回来\n', 'utf8')
      writeFileSync(target, '# 原样\n', 'utf8')
      await quiet(1500)
      expect(events).toEqual([])
    },
    TIMEOUT
  )

  it(
    '文件被删除上报 deleted',
    async () => {
      const target = open(fileIn('gone.md'), '# 会被删\n')
      await readFile(target)
      watchFile(target)

      rmSync(target)
      expect(await waitFor((list) => list.some((event) => event.kind === 'deleted'))).toBe(true)
      expect(events.find((event) => event.kind === 'deleted')?.hash).toBeNull()
    },
    TIMEOUT
  )

  it(
    '取消监测后不再收到该文件的事件',
    async () => {
      const target = open(fileIn('stop.md'), '# 停掉\n')
      await readFile(target)
      watchFile(target)
      unwatchFile(target)

      writeFileSync(target, '# 改了但没人看\n', 'utf8')
      await quiet()
      expect(events).toEqual([])
    },
    TIMEOUT
  )

  it(
    '同一目录里多个文件分别上报',
    async () => {
      const first = open(fileIn('m1.md'), '# 一\n')
      const second = open(fileIn('m2.md'), '# 二\n')
      await readFile(first)
      await readFile(second)
      watchFile(first)
      watchFile(second)

      writeFileSync(second, '# 二改\n', 'utf8')
      expect(await waitFor((list) => list.length > 0)).toBe(true)
      expect(events.every((event) => event.path.toLowerCase() === second.toLowerCase())).toBe(true)

      events.length = 0
      writeFileSync(first, '# 一改\n', 'utf8')
      expect(await waitFor((list) => list.length > 0)).toBe(true)
      expect(events[0].path.toLowerCase()).toBe(first.toLowerCase())
    },
    TIMEOUT
  )
})
