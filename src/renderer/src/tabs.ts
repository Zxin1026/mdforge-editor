export interface TabItem {
  id: string
  name: string
  dirty: boolean
  active: boolean
}

export interface TabBar {
  render(items: readonly TabItem[]): void
}

export function createTabBar(
  mount: HTMLElement,
  handlers: { onSelect: (id: string) => void; onClose: (id: string) => void; onNew: () => void }
): TabBar {
  function build(item: TabItem): HTMLElement {
    const tab = document.createElement('div')
    tab.className = `tab${item.active ? ' is-active' : ''}`
    tab.dataset.id = item.id
    tab.title = item.name

    const label = document.createElement('span')
    label.className = 'tab-label'
    label.textContent = item.name

    const dot = document.createElement('span')
    dot.className = 'tab-dirty'
    dot.textContent = item.dirty ? '•' : ''

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'tab-close'
    close.textContent = '×'
    close.title = '关闭'
    close.addEventListener('click', (event) => {
      event.stopPropagation()
      handlers.onClose(item.id)
    })
    // 中键关闭是常见编辑器习惯
    tab.addEventListener('auxclick', (event) => {
      if (event.button === 1) handlers.onClose(item.id)
    })

    tab.addEventListener('click', () => handlers.onSelect(item.id))
    tab.append(label, dot, close)
    return tab
  }

  function render(items: readonly TabItem[]): void {
    mount.replaceChildren(...items.map(build))
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'tab-add'
    add.textContent = '＋'
    add.title = '新建标签（Ctrl+N）'
    add.addEventListener('click', handlers.onNew)
    mount.appendChild(add)
  }

  return { render }
}
