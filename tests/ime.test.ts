import { describe, expect, it } from 'vitest'
import { CompositionTracker } from '../src/renderer/src/editor/ime'

describe('输入法合成状态', () => {
  it('未合成时为 false', () => {
    expect(new CompositionTracker().composing).toBe(false)
  })

  it('start 后冻结，end 后恢复', () => {
    const tracker = new CompositionTracker()
    tracker.start()
    expect(tracker.composing).toBe(true)
    tracker.end()
    expect(tracker.composing).toBe(false)
  })

  it('嵌套 start 需要配对的 end', () => {
    const tracker = new CompositionTracker()
    tracker.start()
    tracker.start()
    tracker.end()
    expect(tracker.composing).toBe(true)
    tracker.end()
    expect(tracker.composing).toBe(false)
  })

  it('多余的 end 不会变成负数', () => {
    const tracker = new CompositionTracker()
    tracker.end()
    tracker.end()
    expect(tracker.composing).toBe(false)
  })

  it('失焦整体清零，避免合成状态卡死', () => {
    const tracker = new CompositionTracker()
    tracker.start()
    tracker.start()
    tracker.reset()
    expect(tracker.composing).toBe(false)
  })
})
