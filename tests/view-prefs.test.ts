import { describe, expect, it } from 'vitest'
import {
  CONTENT_WIDTH_PX,
  DEFAULT_CONTENT_WIDTH,
  DEFAULT_FONT_SIZE,
  normalizeContentWidth,
  normalizeFontSize
} from '../src/shared/ipc'

describe('normalizeFontSize', () => {
  it('四档预设原样返回', () => {
    for (const size of [13, 14, 15, 16]) {
      expect(normalizeFontSize(size)).toBe(size)
    }
  })

  it('默认值是 14，档位表里必须有它', () => {
    expect(DEFAULT_FONT_SIZE).toBe(14)
    expect(normalizeFontSize(DEFAULT_FONT_SIZE)).toBe(14)
  })

  it('非预设值返回 undefined，由调用方回落默认', () => {
    expect(normalizeFontSize(12)).toBeUndefined()
    expect(normalizeFontSize(14.5)).toBeUndefined()
    expect(normalizeFontSize('14')).toBeUndefined()
    expect(normalizeFontSize(null)).toBeUndefined()
  })
})

describe('normalizeContentWidth', () => {
  it('四个档位原样返回', () => {
    for (const width of ['narrow', 'medium', 'wide', 'full']) {
      expect(normalizeContentWidth(width)).toBe(width)
    }
  })

  it('默认铺满，且只有它不设 max-width', () => {
    expect(DEFAULT_CONTENT_WIDTH).toBe('full')
    expect(CONTENT_WIDTH_PX.full).toBeNull()
    expect(CONTENT_WIDTH_PX.narrow).toBe(760)
    expect(CONTENT_WIDTH_PX.medium).toBe(900)
    expect(CONTENT_WIDTH_PX.wide).toBe(1100)
  })

  it('非法输入返回 undefined', () => {
    expect(normalizeContentWidth('FULL')).toBeUndefined()
    expect(normalizeContentWidth(900)).toBeUndefined()
    expect(normalizeContentWidth(undefined)).toBeUndefined()
  })
})
