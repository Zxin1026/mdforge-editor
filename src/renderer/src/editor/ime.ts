/**
 * 中文输入法合成期间的状态计数。
 * 用计数而不是布尔值：部分输入法在候选窗内会连续触发多次 start/end，
 * 失焦时必须整体清零，否则合成状态会永久卡住、装饰不再更新。
 */
export class CompositionTracker {
  private depth = 0

  get composing(): boolean {
    return this.depth > 0
  }

  start(): void {
    this.depth += 1
  }

  end(): void {
    this.depth = Math.max(0, this.depth - 1)
  }

  reset(): void {
    this.depth = 0
  }
}
