import { beforeEach, describe, expect, it } from 'vitest'
import {
  KEY_COMMANDS,
  effectiveKey,
  formatKey,
  keyFromEvent,
  keybindingsSnapshot,
  loadKeybindings,
  normalizeBinding,
  resetKeybindings,
  setKeybinding,
  toCmKey
} from '../src/renderer/src/keybindings'

function event(
  code: string,
  mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}
): { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean } {
  return { code, ctrlKey: false, altKey: false, shiftKey: false, ...mods }
}

beforeEach(() => {
  resetKeybindings()
})

describe('键位表', () => {
  it('id 与默认绑定都唯一且合法', () => {
    const ids = new Set(KEY_COMMANDS.map((command) => command.id))
    expect(ids.size).toBe(KEY_COMMANDS.length)
    const keys = KEY_COMMANDS.map((command) => command.defaultKey)
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) expect(normalizeBinding(key)).toBe(key)
  })

  it('事件按 code 解析成规范化键名', () => {
    expect(keyFromEvent(event('KeyS', { ctrlKey: true }))).toBe('Ctrl+S')
    expect(keyFromEvent(event('KeyS', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+S')
    expect(keyFromEvent(event('ArrowUp', { altKey: true }))).toBe('Alt+ArrowUp')
    expect(keyFromEvent(event('F3'))).toBe('F3')
    expect(keyFromEvent(event('Digit0', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+0')
    expect(keyFromEvent(event('NumpadAdd', { ctrlKey: true }))).toBe('Ctrl+=')
    expect(keyFromEvent(event('ControlLeft', { ctrlKey: true }))).toBeNull()
  })

  it('规范化：修饰键顺序无关；裸字母与纯 Shift 被拒绝', () => {
    expect(normalizeBinding('Shift+Ctrl+K')).toBe('Ctrl+Shift+K')
    expect(normalizeBinding('ctrl+b')).toBe('Ctrl+B')
    expect(normalizeBinding('A')).toBeNull()
    expect(normalizeBinding('Shift+A')).toBeNull()
    expect(normalizeBinding('Ctrl+')).toBeNull()
    expect(normalizeBinding('F5')).toBe('F5')
    expect(normalizeBinding('Meta+X')).toBeNull()
  })

  it('转 CodeMirror 键名写法', () => {
    expect(toCmKey('Ctrl+Shift+X')).toBe('Ctrl-Shift-x')
    expect(toCmKey('Ctrl+`')).toBe('Ctrl-`')
    expect(toCmKey('Alt+ArrowUp')).toBe('Alt-ArrowUp')
    expect(toCmKey('Ctrl+Alt+-')).toBe('Ctrl-Alt--')
  })

  it('展示：方向键换成箭头符号', () => {
    expect(formatKey('Alt+ArrowLeft')).toBe('Alt+←')
    expect(formatKey('Ctrl+Shift+0')).toBe('Ctrl+Shift+0')
  })
})

describe('覆盖的读写', () => {
  it('会话读回：未知 id 与坏绑定都被丢掉', () => {
    loadKeybindings({ bold: 'Ctrl+Shift+B', ghost: 'Ctrl+G', strike: 'Shift+X' })
    expect(effectiveKey('bold')).toBe('Ctrl+Shift+B')
    expect(effectiveKey('strike')).toBe('Ctrl+Shift+X')
    expect(effectiveKey('ghost')).toBeNull()
  })

  it('冲突被拒绝并指明撞了谁；改回默认等于删覆盖', () => {
    const clash = setKeybinding('bold', 'Ctrl+S')
    expect(clash?.reason).toContain('保存')
    expect(effectiveKey('bold')).toBe('Ctrl+B')

    expect(setKeybinding('bold', 'Ctrl+Shift+B')).toBeNull()
    expect(keybindingsSnapshot()).toEqual({ bold: 'Ctrl+Shift+B' })
    expect(setKeybinding('bold', 'Ctrl+B')).toBeNull()
    expect(keybindingsSnapshot()).toEqual({})
  })

  it('解绑生效，per-key 恢复回到默认', () => {
    expect(setKeybinding('italic', null)).toBeNull()
    expect(effectiveKey('italic')).toBeNull()
    expect(keybindingsSnapshot()).toEqual({ italic: null })
    resetKeybindings()
    expect(effectiveKey('italic')).toBe('Ctrl+I')
  })
})
