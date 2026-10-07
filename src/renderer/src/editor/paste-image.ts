import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { FileErrorInfo } from '../../../shared/ipc'
import { docPathField } from './doc-path'

export interface ImagePasteTarget {
  notify: (error: FileErrorInfo) => void
}

const IMAGE_TYPE = /^image\//
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i

const isImage = (file: File): boolean => IMAGE_TYPE.test(file.type) || IMAGE_EXT.test(file.name)

function altOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

const UNSAVED: FileErrorInfo = {
  code: 'not-granted',
  message: '文档尚未保存，无法确定图片落盘位置',
  hint: '请先保存文档，再粘贴图片'
}

/**
 * 粘贴图片落盘：写入文档同级的 assets/，再把相对链接插进光标处。
 * 落盘是异步的，插入时以最新光标位置为准，避免写到已经变动的旧位置。
 */
async function insertImages(view: EditorView, files: File[], docPath: string, target: ImagePasteTarget): Promise<void> {
  const links: string[] = []

  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const result = await window.mdforge.saveAsset({ docPath, name: file.name || 'image.png', bytes })
    if (!result.ok) {
      target.notify(result.error)
      continue
    }
    links.push(`![${altOf(file.name || result.value.name)}](${result.value.relative})`)
  }

  if (links.length === 0 || !view.dom.isConnected) return

  const range = view.state.selection.main
  const insert = links.join('\n\n')
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: range.from + insert.length },
    scrollIntoView: true,
    userEvent: 'input'
  })
}

export function imagePaste(target: ImagePasteTarget): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const images = Array.from(event.clipboardData?.files ?? []).filter(isImage)
      if (images.length === 0) return false
      // 只有图片才接管，粘贴纯文本保持 CodeMirror 默认行为
      event.preventDefault()

      const docPath = view.state.field(docPathField)
      if (!docPath) {
        target.notify(UNSAVED)
        return true
      }
      void insertImages(view, images, docPath, target).catch((error: unknown) => {
        target.notify({
          code: 'unknown',
          message: `图片落盘失败：${error instanceof Error ? error.message : String(error)}`
        })
      })
      return true
    }
  })
}
