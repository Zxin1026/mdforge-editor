let overlay: HTMLElement | null = null
let onKeydown: ((event: KeyboardEvent) => void) | null = null

function destroy(): void {
  if (onKeydown) window.removeEventListener('keydown', onKeydown)
  onKeydown = null
  overlay?.remove()
  overlay = null
}

export function isLightboxOpen(): boolean {
  return overlay !== null
}

/** 点击预览图后的原图查看层：点击遮罩、按 Esc 或关闭按钮都能退出 */
export function openLightbox(src: string, caption = ''): void {
  destroy()

  const root = document.createElement('div')
  root.className = 'mdf-lightbox'
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', '查看图片')

  const figure = document.createElement('figure')
  figure.className = 'mdf-lightbox-figure'
  const img = document.createElement('img')
  img.className = 'mdf-lightbox-img'
  img.src = src
  img.alt = caption
  img.addEventListener('error', () => {
    figure.replaceChildren()
    const note = document.createElement('div')
    note.className = 'mdf-lightbox-missing'
    note.textContent = '图片无法显示'
    figure.appendChild(note)
  })
  figure.appendChild(img)

  const text = document.createElement('figcaption')
  text.className = 'mdf-lightbox-caption'
  text.textContent = caption
  figure.appendChild(text)

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'mdf-lightbox-close'
  close.textContent = '关闭'
  close.addEventListener('click', destroy)
  figure.appendChild(close)

  root.appendChild(figure)
  // 遮罩本身才关闭，点图片区域不关闭
  root.addEventListener('mousedown', (event) => {
    if (event.target === root) destroy()
  })

  onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      destroy()
    }
  }
  window.addEventListener('keydown', onKeydown)

  overlay = root
  document.body.appendChild(root)
}

export const closeLightbox = destroy
