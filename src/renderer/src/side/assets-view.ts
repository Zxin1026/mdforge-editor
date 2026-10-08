import type {
  AssetListResult,
  AssetRenameInput,
  AssetRenameResult,
  AssetReplaceInput,
  AssetReplaceResult,
  FileResult,
  ManagedAsset
} from '../../../shared/ipc'
import { assetUrlForPath } from '../editor/assets'
import type { Issue } from '../editor/inspect'
import { openLightbox } from '../editor/lightbox'
import { askFormDialog } from '../form-dialog'
import { CANVAS_EXTS, extOf, formatBytes, mimeOfExt, relativePosix, renamePlan, shorten, targetNameFor } from './asset-ops'

export interface AssetsViewDeps {
  /** 扫描根：打开的文件夹，退回当前文档所在目录 */
  root(): string | null
  rootLabel(): string
  openFolder(): void
  list(root: string): Promise<FileResult<AssetListResult>>
  rename(input: AssetRenameInput): Promise<FileResult<AssetRenameResult>>
  replace(input: AssetReplaceInput): Promise<FileResult<AssetReplaceResult>>
  /** 有未保存修改的文档：磁盘上的引用不动，内存缓冲由工作区改写 */
  dirtyDocs(): string[]
  /** 磁盘引用被改写后，让工作区同步打开的标签 */
  syncAfterWrite(touched: readonly string[]): void
  readAsset(path: string): Promise<FileResult<Uint8Array>>
  /** 把 PNG 字节写进系统剪贴板（"复制"按钮） */
  copyImage(bytes: Uint8Array): Promise<boolean>
  activeDocPath(): string | null
  /** 定位到当前文档某一行（1 起） */
  locate(line: number): void
  reveal(path: string): void
  notify(text: string): void
  fail(message: string): void
}

export interface AssetsView {
  mount(host: HTMLElement): void
  /** 切到本页或文件夹变化时重新扫描 */
  refresh(): void
  /** 检查结果里的缺图：面板上给"定位"入口 */
  setMissing(issues: readonly Issue[]): void
}

interface CompressOptions {
  format: 'keep' | 'webp' | 'jpeg'
  quality: number
  maxWidth: number
}

export function createAssetsView(deps: AssetsViewDeps): AssetsView {
  let box: HTMLElement | null = null

  let data: AssetListResult | null = null
  let loading = false
  let error: string | null = null
  let selected = new Set<string>()
  let filter = ''
  let missing: readonly Issue[] = []
  let note = ''
  let busy = false
  let loadSeq = 0

  function render(): void {
    if (box === null) return
    box.replaceChildren(panel())
  }

  async function load(): Promise<void> {
    const root = deps.root()
    if (root === null) {
      data = null
      loading = false
      error = null
      render()
      return
    }
    loading = true
    error = null
    render()
    const seq = ++loadSeq
    const response = await deps.list(root)
    if (seq !== loadSeq) return
    loading = false
    if (response.ok) {
      data = response.value
      // 已不存在的条目从选区里去掉
      const alive = new Set(response.value.assets.map((asset) => asset.path))
      selected = new Set([...selected].filter((path) => alive.has(path)))
    } else {
      data = null
      error = response.error.message
    }
    render()
  }

  // ---- 界面 ----

  function panel(): HTMLElement {
    const root = document.createElement('div')
    root.className = 'assets-panel'

    root.appendChild(header())
    if (deps.root() === null) {
      root.appendChild(emptyBlock('打开文件夹后，这里会列出文件夹里的图片资源', true))
      return root
    }
    if (loading) {
      root.appendChild(noteLine('正在扫描图片…'))
      return root
    }
    if (error !== null) {
      root.appendChild(noteLine(error, true))
      return root
    }
    if (data === null) return root

    root.appendChild(summaryLine(data))
    root.appendChild(toolbar(data))
    if (note !== '') root.appendChild(noteLine(note, false, 'assets-note'))
    if (missing.length > 0) root.appendChild(missingSection())

    const visible = visibleAssets(data)
    if (visible.length === 0) {
      root.appendChild(
        noteLine(data.assets.length === 0 ? '这个文件夹里还没有图片：粘贴或拖入图片会自动放进 assets/' : '没有匹配的图片')
      )
      return root
    }
    const list = document.createElement('div')
    list.className = 'asset-list'
    const activeDoc = deps.activeDocPath()
    for (const asset of visible) list.appendChild(row(asset, activeDoc))
    root.appendChild(list)
    return root
  }

  function header(): HTMLElement {
    const head = document.createElement('div')
    head.className = 'assets-head'
    const name = document.createElement('div')
    name.className = 'files-root-name'
    name.textContent = deps.root() === null ? '图片资源' : deps.rootLabel()
    name.title = deps.root() ?? ''
    const refresh = document.createElement('button')
    refresh.type = 'button'
    refresh.className = 'files-tool'
    refresh.textContent = '↻'
    refresh.title = '重新扫描图片'
    refresh.dataset.action = 'assets-refresh'
    refresh.disabled = loading || busy
    refresh.addEventListener('click', () => void load())
    head.append(name, refresh)
    return head
  }

  function summaryLine(result: AssetListResult): HTMLElement {
    const line = document.createElement('div')
    line.className = 'assets-summary'
    line.dataset.role = 'assets-summary'
    const total = result.assets.reduce((sum, asset) => sum + asset.size, 0)
    const unused = result.assets.filter((asset) => asset.refs.length === 0).length
    const parts = [`${result.assets.length} 张图片`, formatBytes(total)]
    if (unused > 0) parts.push(`未引用 ${unused}`)
    parts.push(`扫描 ${result.docs} 个文档`)
    if (result.truncated) parts.push('数量过多，只列出了一部分')
    line.textContent = parts.join(' · ')
    return line
  }

  function toolbar(result: AssetListResult): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'assets-toolbar'

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'search-input'
    input.placeholder = '按文件名过滤'
    input.spellcheck = false
    input.value = filter
    input.addEventListener('input', () => {
      filter = input.value
      render()
      // 重新渲染后焦点回到输入框并保持光标在末尾
      const again = box?.querySelector<HTMLInputElement>('.assets-toolbar .search-input')
      again?.focus()
    })
    bar.appendChild(input)

    const renameButton = actionButton('重命名…', 'assets-rename', busy, () => void runRename())
    const compressButton = actionButton('压缩…', 'assets-compress', busy, () => void runCompress())
    renameButton.disabled = busy || selected.size === 0
    compressButton.disabled = busy || selected.size === 0
    bar.append(renameButton, compressButton)

    const selectAll = document.createElement('button')
    selectAll.type = 'button'
    selectAll.className = 'search-go'
    selectAll.dataset.action = 'assets-select-all'
    const allSelected = result.assets.length > 0 && selected.size === visibleAssets(result).length
    selectAll.textContent = allSelected ? '清除选择' : '全选'
    selectAll.disabled = busy
    selectAll.addEventListener('click', () => {
      selected = allSelected ? new Set() : new Set(visibleAssets(result).map((asset) => asset.path))
      render()
    })
    bar.appendChild(selectAll)

    const count = document.createElement('div')
    count.className = 'assets-selected'
    count.dataset.role = 'assets-selected'
    count.textContent = selected.size > 0 ? `已选 ${selected.size} 张` : ''
    bar.appendChild(count)
    return bar
  }

  function actionButton(label: string, action: string, disabled: boolean, run: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'search-go'
    button.dataset.action = action
    button.textContent = label
    button.disabled = disabled
    button.addEventListener('click', run)
    return button
  }

  function visibleAssets(result: AssetListResult): ManagedAsset[] {
    const query = filter.trim().toLowerCase()
    if (query === '') return result.assets
    return result.assets.filter(
      (asset) => asset.name.toLowerCase().includes(query) || asset.relative.toLowerCase().includes(query)
    )
  }

  /** 当前文档里引用了但磁盘上找不到的图片：给出定位入口 */
  function missingSection(): HTMLElement {
    const section = document.createElement('div')
    section.className = 'assets-missing'
    const head = document.createElement('div')
    head.className = 'assets-missing-head'
    head.textContent = `缺失的图片引用 ${missing.length}`
    section.appendChild(head)
    for (const issue of missing) {
      const row = document.createElement('div')
      row.className = 'assets-missing-row'
      const label = document.createElement('span')
      label.className = 'assets-missing-label'
      label.textContent = `${issue.label}${issue.line > 0 ? ` · 第 ${issue.line} 行` : ''}`
      label.title = issue.detail
      const locate = document.createElement('button')
      locate.type = 'button'
      locate.className = 'search-go'
      locate.dataset.action = 'assets-locate-missing'
      locate.textContent = '定位'
      locate.addEventListener('click', () => deps.locate(issue.line))
      row.append(label, locate)
      section.appendChild(row)
    }
    return section
  }

  function row(asset: ManagedAsset, activeDoc: string | null): HTMLElement {
    const item = document.createElement('div')
    item.className = `asset-item${asset.refs.length === 0 ? ' is-unused' : ''}`
    item.dataset.assetPath = asset.path
    item.dataset.assetName = asset.name

    const check = document.createElement('input')
    check.type = 'checkbox'
    check.className = 'asset-check'
    check.checked = selected.has(asset.path)
    check.addEventListener('change', () => {
      if (check.checked) selected.add(asset.path)
      else selected.delete(asset.path)
      render()
    })
    item.appendChild(check)

    const thumb = document.createElement('img')
    thumb.className = 'asset-thumb'
    thumb.src = assetUrlForPath(asset.path)
    thumb.alt = asset.name
    thumb.loading = 'lazy'
    thumb.draggable = false
    thumb.title = '点击查看原图'
    thumb.addEventListener('click', () => openLightbox(assetUrlForPath(asset.path), asset.relative))
    thumb.addEventListener('error', () => {
      thumb.classList.add('is-missing')
    })
    item.appendChild(thumb)

    const main = document.createElement('div')
    main.className = 'asset-main'
    const name = document.createElement('button')
    name.type = 'button'
    name.className = 'asset-name'
    name.textContent = asset.name
    name.title = asset.relative
    name.addEventListener('click', () => openLightbox(assetUrlForPath(asset.path), asset.relative))
    const meta = document.createElement('div')
    meta.className = 'asset-meta'
    const dims = asset.width !== null && asset.height !== null ? `${asset.width}×${asset.height}` : '尺寸未知'
    meta.textContent = `${dims} · ${formatBytes(asset.size)}`
    main.append(name, meta)
    item.appendChild(main)

    const dir = asset.relative.includes('/') ? asset.relative.slice(0, asset.relative.lastIndexOf('/')) : ''
    if (dir !== '') {
      const dirTag = document.createElement('div')
      dirTag.className = 'asset-dir'
      dirTag.textContent = dir
      main.appendChild(dirTag)
    }

    const foot = document.createElement('div')
    foot.className = 'asset-foot'

    const refs = document.createElement('span')
    refs.className = `asset-refs${asset.refs.length === 0 ? ' is-none' : ''}`
    refs.textContent = asset.refs.length === 0 ? '未引用' : `引用 ${asset.refs.length}`
    refs.title =
      asset.refs.length === 0
        ? '正文里没有文档引用这张图片'
        : asset.refs.map((ref) => `${ref.doc} · 第 ${ref.line} 行`).join('\n')
    foot.appendChild(refs)

    const activeRel = activeDoc === null ? null : relativePosix(deps.root() ?? '', activeDoc)
    const here = activeRel === null ? undefined : asset.refs.find((ref) => ref.doc.toLowerCase() === activeRel.toLowerCase())
    if (here !== undefined) {
      const locate = document.createElement('button')
      locate.type = 'button'
      locate.className = 'asset-action'
      locate.dataset.action = 'assets-locate'
      locate.textContent = '定位'
      locate.title = `跳到当前文档第 ${here.line} 行`
      locate.addEventListener('click', () => deps.locate(here.line))
      foot.appendChild(locate)
    }

    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'asset-action'
    copy.dataset.action = 'assets-copy'
    copy.textContent = '复制'
    copy.title = '复制图片到剪贴板（统一为 PNG）'
    copy.addEventListener('click', () => void copyAssetImage(asset))
    foot.appendChild(copy)

    const reveal = document.createElement('button')
    reveal.type = 'button'
    reveal.className = 'asset-action'
    reveal.dataset.action = 'assets-reveal'
    reveal.textContent = '文件夹'
    reveal.title = '在文件夹中显示'
    reveal.addEventListener('click', () => deps.reveal(asset.path))
    foot.appendChild(reveal)

    item.append(foot)
    return item
  }

  function emptyBlock(text: string, withButton: boolean): HTMLElement {
    const empty = document.createElement('div')
    empty.className = 'files-empty'
    const line = document.createElement('div')
    line.className = 'files-empty-text'
    line.textContent = text
    empty.appendChild(line)
    if (withButton) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'files-open'
      button.textContent = '打开文件夹…'
      button.addEventListener('click', () => deps.openFolder())
      empty.appendChild(button)
    }
    return empty
  }

  function noteLine(text: string, isError = false, role?: string): HTMLElement {
    const line = document.createElement('div')
    line.className = `files-note${isError ? ' is-error' : ''}`
    if (role) line.dataset.role = role
    line.textContent = text
    return line
  }

  // ---- 批量操作 ----

  function chosenAssets(): ManagedAsset[] {
    if (data === null) return []
    return data.assets.filter((asset) => selected.has(asset.path))
  }

  async function runRename(): Promise<void> {
    const root = deps.root()
    const chosen = chosenAssets()
    if (root === null || chosen.length === 0) return
    const values = await askFormDialog({
      title: '批量重命名图片',
      body: `将重命名选中的 ${chosen.length} 张图片，正文里的引用会一起改写。`,
      fields: [
        { key: 'prefix', label: '文件名前缀', value: 'image' },
        { key: 'start', label: '起始序号', kind: 'number', value: '1', min: 0 }
      ],
      confirmLabel: '重命名',
      validate: (input) => (input.prefix.trim() === '' ? '前缀不能为空' : null)
    })
    if (values === null) return

    const start = Number.parseInt(values.start, 10)
    const names = renamePlan(
      chosen.map((asset) => asset.name),
      values.prefix.trim(),
      Number.isFinite(start) ? start : 1
    )
    busy = true
    render()
    const response = await deps.rename({
      root,
      renames: chosen.map((asset, index) => ({ from: asset.path, to: names[index] })),
      skip: deps.dirtyDocs()
    })
    busy = false
    if (!response.ok) {
      deps.fail(response.error.message)
      render()
      return
    }
    deps.syncAfterWrite(response.value.touched)
    reportOutcome('重命名', response.value.files, response.value.refs)
    selected = new Set()
    await load()
  }

  function reportOutcome(kind: string, files: Array<{ kind: 'ok' | 'error'; detail?: string }>, refs: number): void {
    const ok = files.filter((file) => file.kind === 'ok').length
    const bad = files.filter((file) => file.kind === 'error')
    const parts = [`已${kind} ${ok} 张`]
    if (refs > 0) parts.push(`改写 ${refs} 处引用`)
    if (bad.length > 0) parts.push(`失败 ${bad.length}：${shorten(bad[0].detail ?? '原因不明')}`)
    note = parts.join(' · ')
    if (bad.length > 0 && ok === 0) deps.fail(parts.join(' · '))
    else deps.notify(parts.join(' · '))
  }

  async function runCompress(): Promise<void> {
    const root = deps.root()
    const chosen = chosenAssets()
    if (root === null || chosen.length === 0) return
    const values = await askFormDialog({
      title: '压缩图片',
      body: `将压缩选中的 ${chosen.length} 张图片并替换原文件（引用会指向新文件）。`,
      fields: [
        {
          key: 'format',
          label: '输出格式',
          kind: 'select',
          value: 'keep',
          options: [
            { value: 'keep', label: '保持原格式（PNG 无损重压缩）' },
            { value: 'webp', label: '转为 WebP（体积最小）' },
            { value: 'jpeg', label: '转为 JPEG（照片常用）' }
          ]
        },
        {
          key: 'quality',
          label: '质量',
          kind: 'select',
          value: '85',
          options: [
            { value: '95', label: '95（几乎无损）' },
            { value: '85', label: '85（推荐）' },
            { value: '70', label: '70（更小）' }
          ]
        },
        { key: 'maxWidth', label: '最大宽度', kind: 'number', value: '', placeholder: '如 1600，留空不缩放', min: 0 }
      ],
      note: '被压缩后没有变小的图片会跳过；GIF / SVG / ICO 不支持在应用内压缩。',
      confirmLabel: '开始压缩'
    })
    if (values === null) return

    const maxWidth = Number.parseInt(values.maxWidth, 10)
    const options: CompressOptions = {
      format: values.format === 'webp' || values.format === 'jpeg' ? values.format : 'keep',
      quality: (Number.parseInt(values.quality, 10) || 85) / 100,
      maxWidth: Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : 0
    }

    busy = true
    render()
    let done = 0
    const skipped: string[] = []
    const failed: string[] = []
    let refs = 0
    const saved: string[] = []
    try {
      for (const asset of chosen) {
        const result = await compressOne(asset, options)
        if ('skip' in result) {
          skipped.push(`${asset.name}：${result.skip}`)
          continue
        }
        const response = await deps.replace({
          root,
          path: asset.path,
          bytes: result.bytes,
          newName: result.newName,
          skip: deps.dirtyDocs()
        })
        if (!response.ok) {
          failed.push(`${asset.name}：${response.error.message}`)
          continue
        }
        deps.syncAfterWrite(response.value.touched)
        refs += response.value.refs
        done += 1
        saved.push(`${asset.name} ${formatBytes(asset.size)} → ${formatBytes(response.value.size)}`)
      }
    } finally {
      busy = false
    }

    const parts = [`已压缩 ${done} 张`]
    if (refs > 0) parts.push(`改写 ${refs} 处引用`)
    if (skipped.length > 0) parts.push(`跳过 ${skipped.length}：${shorten(skipped[0])}`)
    if (failed.length > 0) parts.push(`失败 ${failed.length}：${shorten(failed[0])}`)
    note = parts.join(' · ')
    if (done === 0 && (failed.length > 0 || skipped.length > 0)) deps.fail(note)
    else deps.notify(done > 0 && saved.length > 0 ? `${note}（${shorten(saved[0], 60)}）` : note)
    if (done > 0) selected = new Set()
    await load()
  }

  /** 画布重编码：读字节 → 解码 → 按需缩放 → 输出目标格式 */
  async function compressOne(
    asset: ManagedAsset,
    options: CompressOptions
  ): Promise<{ bytes: Uint8Array; newName?: string } | { skip: string }> {
    const ext = extOf(asset.name)
    if (!CANVAS_EXTS.has(ext) && options.format === 'keep') {
      return { skip: '请选择 WebP 或 JPEG 输出' }
    }
    if (ext === '.gif' || ext === '.svg' || ext === '.ico') return { skip: '不支持压缩该格式' }

    const source = await deps.readAsset(asset.path)
    if (!source.ok) return { skip: source.error.message }

    const mime = mimeOfExt(ext)
    // 复制一份拿到 ArrayBuffer 底：IPC 回来的缓冲类型是 ArrayBufferLike，直接进 Blob 通不过类型检查
    const url = URL.createObjectURL(new Blob([new Uint8Array(source.value)], { type: mime }))
    let image: HTMLImageElement
    try {
      image = await loadImage(url)
    } catch {
      return { skip: '图片无法解码' }
    } finally {
      URL.revokeObjectURL(url)
    }

    const scale = options.maxWidth > 0 && image.naturalWidth > options.maxWidth ? options.maxWidth / image.naturalWidth : 1
    const width = Math.max(1, Math.round(image.naturalWidth * scale))
    const height = Math.max(1, Math.round(image.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (context === null) return { skip: '当前环境不支持画布' }

    const targetMime = options.format === 'keep' ? mime : options.format === 'webp' ? 'image/webp' : 'image/jpeg'
    // JPEG 没有透明通道：不铺白底的话透明区域会变成黑块
    if (targetMime === 'image/jpeg') {
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, width, height)
    }
    context.drawImage(image, 0, 0, width, height)

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, targetMime, targetMime === 'image/png' ? undefined : options.quality)
    })
    if (blob === null) return { skip: '编码失败' }
    if (blob.size >= asset.size) return { skip: `没有变小（${formatBytes(asset.size)}）` }

    const bytes = new Uint8Array(await blob.arrayBuffer())
    const newName = targetNameFor(asset.name, targetMime)
    return { bytes, newName }
  }

  function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('图片无法解码'))
      image.src = src
    })
  }

  /** 复制到剪贴板：PNG 原样送出，其余格式经画布统一转成 PNG（系统剪贴板的通用图片格式） */
  async function copyAssetImage(asset: ManagedAsset): Promise<void> {
    const source = await deps.readAsset(asset.path)
    if (!source.ok) {
      deps.fail(source.error.message)
      return
    }
    try {
      const ext = extOf(asset.name)
      const bytes = ext === '.png' ? source.value : await rasterizeToPng(source.value, mimeOfExt(ext))
      const ok = await deps.copyImage(bytes)
      if (ok) deps.notify(`已复制图片：${asset.name}`)
      else deps.fail(`复制图片失败：${asset.name}`)
    } catch {
      deps.fail(`复制图片失败：${asset.name}（这个格式转不成 PNG）`)
    }
  }

  async function rasterizeToPng(bytes: Uint8Array, mime: string): Promise<Uint8Array> {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }))
    let image: HTMLImageElement
    try {
      image = await loadImage(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, image.naturalWidth)
    canvas.height = Math.max(1, image.naturalHeight)
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('当前环境不支持画布')
    context.drawImage(image, 0, 0)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (blob === null) throw new Error('编码失败')
    return new Uint8Array(await blob.arrayBuffer())
  }

  return {
    mount(hostEl) {
      if (box === null) {
        box = document.createElement('div')
        box.className = 'assets-panel-host'
      }
      hostEl.replaceChildren(box)
      void load()
    },
    refresh() {
      void load()
    },
    setMissing(issues) {
      missing = issues
      if (box !== null) render()
    }
  }
}
