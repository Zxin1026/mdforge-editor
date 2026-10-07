import type { DocLink, DocRef } from '../../shared/ipc'

export interface GraphInput {
  files: DocRef[]
  links: DocLink[]
  /** 当前打开的文档：高亮它 */
  current: string | null
  onPick(path: string): void
}

interface Node {
  path: string
  name: string
  x: number
  y: number
  degree: number
}

let overlay: HTMLElement | null = null
let onKeydown: ((event: KeyboardEvent) => void) | null = null

export function closeGraph(): void {
  if (onKeydown) window.removeEventListener('keydown', onKeydown)
  onKeydown = null
  overlay?.remove()
  overlay = null
}

function keyOf(path: string): string {
  return path.toLowerCase()
}

function labelOf(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

/**
 * 文档关系图：节点是文件夹里的文档，连线是文档之间的链接。
 * 用一轮简单的力导向布局（斥力 + 边弹簧 + 向心）算出位置，然后交给 SVG；
 * 节点可以拖动，点节点打开对应文档。
 */
export function openGraph(input: GraphInput): void {
  closeGraph()

  const root = document.createElement('div')
  root.className = 'mdf-graph'
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', '文档关系图')

  const card = document.createElement('div')
  card.className = 'mdf-graph-card'

  const head = document.createElement('div')
  head.className = 'mdf-graph-head'
  const title = document.createElement('div')
  title.className = 'mdf-graph-title'
  title.textContent = `文档关系图 · ${input.files.length} 个文档 · ${input.links.length} 条链接`
  const hint = document.createElement('div')
  hint.className = 'mdf-graph-hint'
  hint.textContent = '点击节点打开文档，拖动可以摆位置'
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'mdf-graph-close'
  close.textContent = '关闭'
  close.addEventListener('click', closeGraph)
  head.append(title, hint, close)
  card.appendChild(head)

  const width = Math.min(1100, Math.max(560, window.innerWidth - 160))
  const height = Math.min(680, Math.max(380, window.innerHeight - 200))
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'mdf-graph-svg')
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  card.appendChild(svg)

  if (input.files.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'mdf-graph-empty'
    empty.textContent = '文件夹里还没有可打开的文档'
    card.appendChild(empty)
  } else {
    renderGraph(svg, width, height, input)
  }

  root.appendChild(card)
  root.addEventListener('mousedown', (event) => {
    if (event.target === root) closeGraph()
  })

  onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeGraph()
    }
  }
  window.addEventListener('keydown', onKeydown)

  overlay = root
  document.body.appendChild(root)
}

function renderGraph(svg: SVGSVGElement, width: number, height: number, input: GraphInput): void {
  const centerX = width / 2
  const centerY = height / 2
  const nodes: Node[] = input.files.map((file, index) => {
    const angle = (index / Math.max(1, input.files.length)) * Math.PI * 2
    const radius = Math.min(width, height) * 0.32
    return {
      path: file.path,
      name: file.name,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
      degree: 0
    }
  })
  const byKey = new Map<string, Node>()
  for (const node of nodes) byKey.set(keyOf(node.path), node)

  const edges: Array<{ a: Node; b: Node }> = []
  const seen = new Set<string>()
  for (const link of input.links) {
    const a = byKey.get(keyOf(link.from))
    const b = byKey.get(keyOf(link.to))
    if (!a || !b || a === b) continue
    const pairKey = [keyOf(a.path), keyOf(b.path)].sort().join('\u0000')
    if (seen.has(pairKey)) continue
    seen.add(pairKey)
    a.degree += 1
    b.degree += 1
    edges.push({ a, b })
  }

  layout(nodes, edges, centerX, centerY, width, height)

  const edgeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g')
  const nodeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g')
  svg.append(edgeLayer, nodeLayer)

  const edgeEls = edges.map((edge) => {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    line.setAttribute('class', 'mdf-graph-edge')
    edgeLayer.appendChild(line)
    return { line, edge }
  })

  const currentKey = input.current === null ? '' : keyOf(input.current)
  const nodeEls = nodes.map((node) => {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    group.setAttribute(
      'class',
      `mdf-graph-node${keyOf(node.path) === currentKey ? ' is-current' : ''}${node.degree === 0 ? ' is-isolated' : ''}`
    )

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    const radius = Math.min(16, 6 + node.degree * 1.6)
    circle.setAttribute('r', String(radius))
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    label.setAttribute('text-anchor', 'middle')
    label.setAttribute('dy', String(radius + 13))
    label.textContent = labelOf(node.name)
    const titleTag = document.createElementNS('http://www.w3.org/2000/svg', 'title')
    titleTag.textContent = `${node.path}\n${node.degree} 条链接`
    group.append(circle, label, titleTag)
    group.addEventListener('click', () => input.onPick(node.path))
    nodeLayer.appendChild(group)

    attachDrag(circle, node, () => placeAll(nodeEls, edgeEls), svg, width, height)
    return { group, node }
  })

  placeAll(nodeEls, edgeEls)
}

interface NodeEl {
  group: SVGGElement
  node: Node
}
interface EdgeEl {
  line: SVGLineElement
  edge: { a: Node; b: Node }
}

function placeAll(nodeEls: NodeEl[], edgeEls: EdgeEl[]): void {
  for (const { group, node } of nodeEls) {
    group.setAttribute('transform', `translate(${node.x.toFixed(1)} ${node.y.toFixed(1)})`)
  }
  for (const { line, edge } of edgeEls) {
    line.setAttribute('x1', edge.a.x.toFixed(1))
    line.setAttribute('y1', edge.a.y.toFixed(1))
    line.setAttribute('x2', edge.b.x.toFixed(1))
    line.setAttribute('y2', edge.b.y.toFixed(1))
  }
}

/** 力导向布局：斥力推开、边当弹簧、再轻轻拉向中心 */
function layout(
  nodes: Node[],
  edges: Array<{ a: Node; b: Node }>,
  centerX: number,
  centerY: number,
  width: number,
  height: number
): void {
  if (nodes.length === 0) return
  const area = width * height
  const k = Math.sqrt(area / nodes.length) * 0.55
  const pad = 40
  let temperature = Math.min(width, height) * 0.12

  for (let step = 0; step < 320; step += 1) {
    const fx = new Map<Node, number>()
    const fy = new Map<Node, number>()
    for (const node of nodes) {
      fx.set(node, 0)
      fy.set(node, 0)
    }

    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i]
        const b = nodes[j]
        let dx = a.x - b.x
        let dy = a.y - b.y
        let dist = Math.hypot(dx, dy)
        if (dist < 0.01) {
          dx = (i - j) * 0.5 + 0.1
          dy = (j - i) * 0.5 + 0.1
          dist = Math.hypot(dx, dy)
        }
        const force = (k * k) / dist
        const ux = dx / dist
        const uy = dy / dist
        fx.set(a, (fx.get(a) ?? 0) + ux * force)
        fy.set(a, (fy.get(a) ?? 0) + uy * force)
        fx.set(b, (fx.get(b) ?? 0) - ux * force)
        fy.set(b, (fy.get(b) ?? 0) - uy * force)
      }
    }

    for (const { a, b } of edges) {
      const dx = a.x - b.x
      const dy = a.y - b.y
      const dist = Math.max(1, Math.hypot(dx, dy))
      const force = (dist * dist) / k
      const ux = dx / dist
      const uy = dy / dist
      fx.set(a, (fx.get(a) ?? 0) - ux * force)
      fy.set(a, (fy.get(a) ?? 0) - uy * force)
      fx.set(b, (fx.get(b) ?? 0) + ux * force)
      fy.set(b, (fy.get(b) ?? 0) + uy * force)
    }

    for (const node of nodes) {
      fx.set(node, (fx.get(node) ?? 0) + (centerX - node.x) * 0.02)
      fy.set(node, (fy.get(node) ?? 0) + (centerY - node.y) * 0.02)
      const dx = fx.get(node) ?? 0
      const dy = fy.get(node) ?? 0
      const dist = Math.max(0.01, Math.hypot(dx, dy))
      const move = Math.min(dist, temperature)
      node.x += (dx / dist) * move
      node.y += (dy / dist) * move
      node.x = Math.min(width - pad, Math.max(pad, node.x))
      node.y = Math.min(height - pad, Math.max(pad, node.y))
    }
    temperature *= 0.985
  }
}

function attachDrag(
  circle: SVGCircleElement,
  node: Node,
  redraw: () => void,
  svg: SVGSVGElement,
  width: number,
  height: number
): void {
  circle.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    event.stopPropagation()
    circle.setPointerCapture(event.pointerId)
    const point = (e: PointerEvent): { x: number; y: number } => {
      const box = svg.getBoundingClientRect()
      return {
        x: ((e.clientX - box.left) / box.width) * width,
        y: ((e.clientY - box.top) / box.height) * height
      }
    }
    const onMove = (e: PointerEvent): void => {
      const p = point(e)
      node.x = Math.min(width - 10, Math.max(10, p.x))
      node.y = Math.min(height - 10, Math.max(10, p.y))
      redraw()
    }
    const onUp = (): void => {
      circle.removeEventListener('pointermove', onMove)
      circle.removeEventListener('pointerup', onUp)
      circle.removeEventListener('pointercancel', onUp)
    }
    circle.addEventListener('pointermove', onMove)
    circle.addEventListener('pointerup', onUp)
    circle.addEventListener('pointercancel', onUp)
  })
}
