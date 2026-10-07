import { describe, expect, it } from 'vitest'
import { normalizeTheme, normalizeZoom } from '../src/shared/ipc'
import { resolveTheme } from '../src/renderer/src/theme'

describe('resolveTheme', () => {
  it('明确指定时按指定值', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('跟随系统时读系统深浅色', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })
})

describe('normalizeTheme', () => {
  it('三个合法取值原样返回', () => {
    expect(normalizeTheme('light')).toBe('light')
    expect(normalizeTheme('dark')).toBe('dark')
    expect(normalizeTheme('system')).toBe('system')
  })

  it('旧版 mdmdt 皮肤值迁移到对应深浅色', () => {
    expect(normalizeTheme('mdmdt-light')).toBe('light')
    expect(normalizeTheme('mdmdt-dark')).toBe('dark')
  })

  it('非法输入返回 undefined，由调用方回落默认', () => {
    expect(normalizeTheme('DARK')).toBeUndefined()
    expect(normalizeTheme(1)).toBeUndefined()
    expect(normalizeTheme(null)).toBeUndefined()
  })
})

describe('normalizeZoom', () => {
  it('区间内的值保留两位小数', () => {
    expect(normalizeZoom(1.25)).toBe(1.25)
    expect(normalizeZoom(1.234)).toBe(1.23)
  })

  it('越界值被夹到 0.5–3', () => {
    expect(normalizeZoom(0.1)).toBe(0.5)
    expect(normalizeZoom(8)).toBe(3)
  })

  it('非数字与 NaN 返回 undefined', () => {
    expect(normalizeZoom('1.5')).toBeUndefined()
    expect(normalizeZoom(Number.NaN)).toBeUndefined()
    expect(normalizeZoom(Number.POSITIVE_INFINITY)).toBeUndefined()
  })
})
