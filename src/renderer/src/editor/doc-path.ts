import { EditorState, StateEffect, StateField } from '@codemirror/state'

export const setDocPath = StateEffect.define<string>()

export const docPathField = StateField.define<string>({
  create: () => '',
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setDocPath)) return effect.value
    }
    return value
  }
})

export function docPathOf(state: EditorState): string {
  return state.field(docPathField)
}
