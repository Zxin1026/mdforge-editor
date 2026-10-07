import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  fitToDisplays,
  normalizeWindowState,
  readWindowState,
  saveWindowState,
  type Rect,
  type WindowState
} from '../src/main/window-state'

const SCREEN: Rect = { x: 0, y: 0, width: 1920, height: 1040 }

function stateOf(overrides: Partial<WindowState> = {}): WindowState {
  return { x: 100, y: 80, width: 1200, height: 800, maximized: false, ...overrides }
}

describe('normalizeWindowState', () => {
  it('合法对象保留数值并取整', () => {
    expect(normalizeWindowState({ x: 10.6, y: -20.2, width: 1200.4, height: 800.5, maximized: true })).toEqual({
      x: 11,
      y: -20,
      width: 1200,
      height: 801,
      maximized: true
    })
  })

  it('尺寸缺失或过小的记录直接丢弃', () => {
    expect(normalizeWindowState({ x: 1, y: 1 })).toBeUndefined()
    expect(normalizeWindowState({ width: 300, height: 200 })).toBeUndefined()
    expect(normalizeWindowState(null)).toBeUndefined()
    expect(normalizeWindowState('x')).toBeUndefined()
  })

  it('只有最大化标记时默认 false，位置缺失不算非法', () => {
    expect(normalizeWindowState({ width: 1200, height: 800 })?.maximized).toBe(false)
    expect(normalizeWindowState({ width: 1200, height: 800 })?.x).toBeUndefined()
  })
})

describe('fitToDisplays', () => {
  it('位置仍落在屏幕上时返回坐标', () => {
    expect(fitToDisplays(stateOf(), [SCREEN])).toEqual({ x: 100, y: 80, width: 1200, height: 800 })
  })

  it('露出一角也算可见：贴近屏幕边缘仍可恢复', () => {
    // 横向还剩 80px、纵向还剩 40px，都在阈值之上
    expect(fitToDisplays(stateOf({ x: 1840, y: 1000 }), [SCREEN])).toBeDefined()
  })

  it('算显示器拔掉后位置不可见时返回 undefined，交给系统摆位', () => {
    expect(fitToDisplays(stateOf({ x: 5000, y: 4000 }), [SCREEN])).toBeUndefined()
    expect(fitToDisplays(stateOf({ x: -2000, y: 0 }), [SCREEN])).toBeUndefined()
  })

  it('没有位置记录时返回 undefined', () => {
    expect(fitToDisplays(stateOf({ x: undefined, y: undefined }), [SCREEN])).toBeUndefined()
  })
})

describe('window-state.json 读写', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mdforge-window-'))
  })

  it('写出去能读回来', async () => {
    saveWindowState(dir, stateOf({ maximized: true }))
    expect(await readWindowState(dir)).toEqual(stateOf({ maximized: true }))
  })

  it('文件不存在或内容损坏时返回 undefined', async () => {
    expect(await readWindowState(dir)).toBeUndefined()

    saveWindowState(dir, stateOf())
    const file = path.join(dir, 'window-state.json')
    const corrupted = JSON.stringify({ width: '大' })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, corrupted, 'utf-8')
    expect(await readWindowState(dir)).toBeUndefined()
  })
})
