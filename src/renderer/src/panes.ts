import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  SPLIT_RATIO_DEFAULT,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN
} from '../../shared/ipc'

/** 侧边栏宽度落在 CSS 变量上，样式表按变量取宽 */
export function applySidebarWidth(px: number): void {
  document.documentElement.style.setProperty('--mdf-sidebar-width', `${px}px`)
}

/** 分屏右栏占比（0–1）落在 CSS 变量上，左右两栏的宽度都由它推出来 */
export function applySplitRatio(ratio: number): void {
  document.documentElement.style.setProperty('--mdf-split-ratio', `${Math.round(ratio * 100)}%`)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 通用拖拽：pointerdown 后跟随指针，回调持续给出新值（final=false），
 * 抬手时回调一次 final=true——只有那一次才值得写会话。
 */
function bindDrag(
  handle: HTMLElement,
  deps: { valueAt(clientX: number, clientY: number): number; apply(value: number, final: boolean): void; reset(): void }
): void {
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    handle.setPointerCapture(event.pointerId)
    handle.classList.add('is-dragging')
    let latest = deps.valueAt(event.clientX, event.clientY)
    const move = (moveEvent: PointerEvent): void => {
      latest = deps.valueAt(moveEvent.clientX, moveEvent.clientY)
      deps.apply(latest, false)
    }
    const finish = (): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', finish)
      handle.removeEventListener('pointercancel', finish)
      handle.classList.remove('is-dragging')
      deps.apply(latest, true)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', finish)
    handle.addEventListener('pointercancel', finish)
  })
  handle.addEventListener('dblclick', (event) => {
    event.preventDefault()
    deps.reset()
  })
}

/** 侧边栏分隔条：宽度 = 指针到窗口（正文区）左缘的距离 */
export function bindSidebarResizer(
  handle: HTMLElement,
  body: HTMLElement,
  deps: { onWidth(px: number, final: boolean): void }
): void {
  bindDrag(handle, {
    valueAt: (clientX) => {
      const rect = body.getBoundingClientRect()
      return Math.round(clamp(clientX - rect.left, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX))
    },
    apply: (value, final) => deps.onWidth(value, final),
    reset: () => deps.onWidth(SIDEBAR_WIDTH_DEFAULT, true)
  })
}

/** 分屏分隔条：右栏占比 = 指针到编辑区右缘的距离 / 编辑区总宽 */
export function bindSplitResizer(
  handle: HTMLElement,
  host: HTMLElement,
  deps: { onRatio(ratio: number, final: boolean): void }
): void {
  const ratioAt = (clientX: number): number => {
    const rect = host.getBoundingClientRect()
    if (rect.width <= 0) return SPLIT_RATIO_DEFAULT
    return Math.round(clamp((rect.right - clientX) / rect.width, SPLIT_RATIO_MIN, SPLIT_RATIO_MAX) * 100) / 100
  }
  bindDrag(handle, {
    valueAt: (clientX) => ratioAt(clientX),
    apply: (value, final) => deps.onRatio(value, final),
    reset: () => deps.onRatio(SPLIT_RATIO_DEFAULT, true)
  })
}
