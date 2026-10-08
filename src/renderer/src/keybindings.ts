/**
 * 统一键位表：菜单提示、帮助弹窗、窗口级派发与编辑器 keymap 都从这里取键。
 * 会话里只存与默认值不同的覆盖（keybindings 字段），载入时逐条校验。
 */

export type KeyScope = 'app' | 'editor'

export interface KeyCommand {
  id: string
  label: string
  group: string
  /** 规范化写法：修饰键按 Ctrl+Alt+Shift 顺序，键名见 keyFromEvent 的 token 表 */
  defaultKey: string
  scope: KeyScope
}

/** 组在帮助弹窗里的展示顺序 */
export const KEY_GROUP_ORDER = ['文件', '查找', '格式', '段落', '视图', '导航']

export const KEY_COMMANDS: KeyCommand[] = [
  { id: 'new', label: '新建', group: '文件', defaultKey: 'Ctrl+N', scope: 'app' },
  { id: 'open', label: '打开', group: '文件', defaultKey: 'Ctrl+O', scope: 'app' },
  { id: 'save', label: '保存', group: '文件', defaultKey: 'Ctrl+S', scope: 'app' },
  { id: 'saveAs', label: '另存为', group: '文件', defaultKey: 'Ctrl+Shift+S', scope: 'app' },
  { id: 'closeTab', label: '关闭标签页', group: '文件', defaultKey: 'Ctrl+W', scope: 'app' },

  { id: 'find', label: '查找', group: '查找', defaultKey: 'Ctrl+F', scope: 'editor' },
  { id: 'replace', label: '替换', group: '查找', defaultKey: 'Ctrl+H', scope: 'app' },
  { id: 'findNext', label: '查找下一个', group: '查找', defaultKey: 'F3', scope: 'editor' },
  { id: 'findPrevious', label: '查找上一个', group: '查找', defaultKey: 'Shift+F3', scope: 'editor' },
  { id: 'workspaceSearch', label: '在工作区中查找', group: '查找', defaultKey: 'Ctrl+Shift+F', scope: 'app' },

  { id: 'bold', label: '加粗', group: '格式', defaultKey: 'Ctrl+B', scope: 'editor' },
  { id: 'italic', label: '斜体', group: '格式', defaultKey: 'Ctrl+I', scope: 'editor' },
  { id: 'strike', label: '删除线', group: '格式', defaultKey: 'Ctrl+Shift+X', scope: 'editor' },
  { id: 'inlineCode', label: '行内代码', group: '格式', defaultKey: 'Ctrl+`', scope: 'editor' },

  { id: 'heading1', label: '一级标题', group: '段落', defaultKey: 'Ctrl+1', scope: 'editor' },
  { id: 'heading2', label: '二级标题', group: '段落', defaultKey: 'Ctrl+2', scope: 'editor' },
  { id: 'heading3', label: '三级标题', group: '段落', defaultKey: 'Ctrl+3', scope: 'editor' },
  { id: 'heading4', label: '四级标题', group: '段落', defaultKey: 'Ctrl+4', scope: 'editor' },
  { id: 'heading5', label: '五级标题', group: '段落', defaultKey: 'Ctrl+5', scope: 'editor' },
  { id: 'heading6', label: '六级标题', group: '段落', defaultKey: 'Ctrl+6', scope: 'editor' },
  { id: 'body', label: '正文', group: '段落', defaultKey: 'Ctrl+0', scope: 'editor' },
  { id: 'bulletList', label: '无序列表', group: '段落', defaultKey: 'Ctrl+Shift+L', scope: 'editor' },
  { id: 'orderedList', label: '有序列表', group: '段落', defaultKey: 'Ctrl+Shift+O', scope: 'editor' },
  { id: 'taskList', label: '任务列表', group: '段落', defaultKey: 'Ctrl+Shift+T', scope: 'editor' },
  { id: 'quote', label: '引用', group: '段落', defaultKey: 'Ctrl+Shift+Q', scope: 'editor' },
  { id: 'table', label: '表格', group: '段落', defaultKey: 'Ctrl+Alt+T', scope: 'editor' },
  { id: 'codeBlock', label: '切换代码块', group: '段落', defaultKey: 'Ctrl+Shift+K', scope: 'editor' },
  { id: 'toggleTask', label: '切换任务勾选', group: '段落', defaultKey: 'Ctrl+Shift+C', scope: 'editor' },
  { id: 'headingUp', label: '提升标题级别', group: '段落', defaultKey: 'Ctrl+Alt+=', scope: 'editor' },
  { id: 'headingDown', label: '降低标题级别', group: '段落', defaultKey: 'Ctrl+Alt+-', scope: 'editor' },
  { id: 'moveLineUp', label: '上移一行', group: '段落', defaultKey: 'Alt+ArrowUp', scope: 'editor' },
  { id: 'moveLineDown', label: '下移一行', group: '段落', defaultKey: 'Alt+ArrowDown', scope: 'editor' },

  { id: 'sourceMode', label: '源代码模式', group: '视图', defaultKey: 'Ctrl+/', scope: 'app' },
  { id: 'palette', label: '命令面板', group: '视图', defaultKey: 'Ctrl+Shift+P', scope: 'app' },
  { id: 'zoomIn', label: '放大', group: '视图', defaultKey: 'Ctrl+=', scope: 'app' },
  { id: 'zoomOut', label: '缩小', group: '视图', defaultKey: 'Ctrl+-', scope: 'app' },
  { id: 'zoomReset', label: '实际大小', group: '视图', defaultKey: 'Ctrl+Shift+0', scope: 'app' },
  { id: 'fullScreen', label: '全屏', group: '视图', defaultKey: 'F11', scope: 'app' },

  { id: 'navBack', label: '后退', group: '导航', defaultKey: 'Alt+ArrowLeft', scope: 'app' },
  { id: 'navForward', label: '前进', group: '导航', defaultKey: 'Alt+ArrowRight', scope: 'app' }
]

const COMMAND_BY_ID = new Map(KEY_COMMANDS.map((command) => [command.id, command]))

/** 键盘 code → 键名 token；字母、数字、功能键、方向键与常用符号 */
const CODE_TOKEN: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  NumpadDivide: '/',
  NumpadAdd: '=',
  NumpadSubtract: '-',
  Space: 'Space',
  Escape: 'Escape',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown'
}

const KEY_TOKEN = /^(?:[A-Z]|[0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Arrow(?:Left|Right|Up|Down)|Escape|Enter|Space|Backspace|Tab|Delete|Insert|Home|End|PageUp|PageDown|`|-|=|\[|\]|\\|;|'|,|\.|\/)$/

/** 键盘事件 → 规范化键名；按不出来（纯修饰键等）返回 null */
export function keyFromEvent(event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey'>): string | null {
  let token: string | null = null
  if (/^Key[A-Z]$/.test(event.code)) token = event.code.slice(3)
  else if (/^Digit[0-9]$/.test(event.code)) token = event.code.slice(5)
  else if (/^Numpad[0-9]$/.test(event.code)) token = event.code.slice(6)
  else if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(event.code)) token = event.code
  else token = CODE_TOKEN[event.code] ?? null
  if (token === null) return null
  const mods: string[] = []
  if (event.ctrlKey) mods.push('Ctrl')
  if (event.altKey) mods.push('Alt')
  if (event.shiftKey) mods.push('Shift')
  return mods.length === 0 ? token : `${mods.join('+')}+${token}`
}

/** 校验并规范化一个绑定串：修饰键顺序归一；必须带 Ctrl/Alt 或功能键，避免吞掉普通输入 */
export function normalizeBinding(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null
  const parts = raw.split('+')
  let token = parts.pop() ?? ''
  if (/^[a-z]$/.test(token)) token = token.toUpperCase()
  if (!KEY_TOKEN.test(token)) return null
  const mods = new Set<string>()
  for (const part of parts) {
    const name = part.toLowerCase()
    if (name === 'ctrl' || name === 'control') mods.add('Ctrl')
    else if (name === 'alt') mods.add('Alt')
    else if (name === 'shift') mods.add('Shift')
    else return null
  }
  const ordered: string[] = []
  if (mods.has('Ctrl')) ordered.push('Ctrl')
  if (mods.has('Alt')) ordered.push('Alt')
  if (mods.has('Shift')) ordered.push('Shift')
  if (ordered.length === 0) {
    // 无修饰的绑定只允许功能键
    return /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(token) ? token : null
  }
  if (!mods.has('Ctrl') && !mods.has('Alt') && !/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(token)) return null
  return `${ordered.join('+')}+${token}`
}

const DISPLAY_TOKEN: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Space: '空格'
}

/** 展示用：方向键换成箭头，其余照抄 */
export function formatKey(key: string): string {
  const parts = key.split('+')
  const token = parts.pop() ?? ''
  const shown = DISPLAY_TOKEN[token] ?? token
  return [...parts, shown].join('+')
}

/** 转成 CodeMirror 的键名写法：Ctrl→Ctrl、字母小写、其余原样 */
export function toCmKey(key: string): string {
  const parts = key.split('+')
  const token = parts.pop() ?? ''
  const cmToken = token.length === 1 && /[A-Z]/.test(token) ? token.toLowerCase() : token
  return [...parts, cmToken].join('-')
}

let overrides: Record<string, string | null> = {}
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** 会话里读回的覆盖：未知 id、格式不对的绑定一律丢弃 */
export function loadKeybindings(raw: unknown): void {
  const next: Record<string, string | null> = {}
  if (raw !== null && typeof raw === 'object') {
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!COMMAND_BY_ID.has(id)) continue
      if (value === null) {
        next[id] = null
        continue
      }
      const normalized = normalizeBinding(value)
      if (normalized !== null) next[id] = normalized
    }
  }
  overrides = next
}

export function effectiveKey(id: string): string | null {
  if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id]
  return COMMAND_BY_ID.get(id)?.defaultKey ?? null
}

export function overrideOf(id: string): string | null | undefined {
  return Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : undefined
}

/** 只存与默认值不同的覆盖；改回默认等于删掉覆盖 */
function storeOverride(id: string, key: string | null): void {
  const command = COMMAND_BY_ID.get(id)!
  if (key === command.defaultKey) delete overrides[id]
  else overrides[id] = key
}

export interface KeyBindingProblem {
  reason: string
}

/** 改一个命令的绑定；null 表示解绑。与其它命令冲突时拒绝并说明撞了谁 */
export function setKeybinding(id: string, raw: unknown): KeyBindingProblem | null {
  const command = COMMAND_BY_ID.get(id)
  if (!command) return { reason: '未知命令' }
  if (raw === null) {
    storeOverride(id, null)
    emit()
    return null
  }
  const key = normalizeBinding(raw)
  if (key === null) return { reason: '这个组合键不能用作快捷键' }
  const clash = KEY_COMMANDS.find((other) => other.id !== id && effectiveKey(other.id) === key)
  if (clash) return { reason: `已分给「${clash.label}」` }
  storeOverride(id, key)
  emit()
  return null
}

export function resetKeybinding(id: string): void {
  delete overrides[id]
  emit()
}

export function resetKeybindings(): void {
  overrides = {}
  emit()
}

/** 落盘快照：只含覆盖项 */
export function keybindingsSnapshot(): Record<string, string | null> {
  return { ...overrides }
}

export function onKeybindingChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

let appMapCache: Map<string, string> | null = null

/** 窗口级派发用的查找表：绑定串 → 命令 id */
export function appKeyMap(): Map<string, string> {
  if (appMapCache !== null) return appMapCache
  const map = new Map<string, string>()
  for (const command of KEY_COMMANDS) {
    if (command.scope !== 'app') continue
    const key = effectiveKey(command.id)
    if (key !== null) map.set(key, command.id)
  }
  appMapCache = map
  return map
}

onKeybindingChange(() => {
  appMapCache = null
})
