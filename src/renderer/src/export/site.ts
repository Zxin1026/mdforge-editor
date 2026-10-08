import { DEFAULT_EXPORT_OPTIONS, type BatchFileInput, type ExportOptions } from '../../../shared/ipc'
import { dirOfPath, relativeBetween, relativePosix, resolvePath } from '../paths'
import { buildDocHtml, deriveTitle, escapeHtml, renderText } from './html'
import { applyTemplate, BUILTIN_TEMPLATE_HTML } from './page-template'
import { cssForRef, templateHtmlForRef } from './style-lib'

export interface SiteDocInput {
  path: string
  text: string
}

/** 导航页与 search-index.json 共用的一条检索记录 */
export interface SearchEntry {
  /** 站点内的 html 相对路径 */
  path: string
  title: string
  text: string
}

export interface SiteExportPlan {
  title: string
  files: BatchFileInput[]
  extras: Array<{ relative: string; content: string }>
  /** 成功渲染的页数 */
  pages: number
  /** 渲染失败被跳过的文档 */
  skipped: string[]
}

export interface SiteExportInput {
  root: string
  docs: readonly SiteDocInput[]
  options: ExportOptions
  /** true：生成导航页、搜索索引，页内加"返回目录" */
  site: boolean
}

const MD_EXT = /\.(md|markdown|mdown|mkd|txt)$/i

export function htmlRelativeOf(rel: string): string {
  return MD_EXT.test(rel) ? rel.replace(MD_EXT, '.html') : `${rel}.html`
}

function baseName(target: string): string {
  const parts = target.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || target
}

/**
 * 批量导出/静态站点的页面计划：渲染每个文档、改写站内链接、
 * 需要时生成导航页与搜索索引，最后交给主进程写盘。
 */
export async function buildSitePlan(input: SiteExportInput): Promise<SiteExportPlan> {
  const options = input.options ?? DEFAULT_EXPORT_OPTIONS
  const entries = input.docs.map((doc) => {
    const rel = relativePosix(input.root, doc.path) ?? baseName(doc.path)
    const htmlRel = htmlRelativeOf(rel)
    const fallback = (htmlRel.split('/').pop() ?? htmlRel).replace(/\.html$/i, '')
    return { path: doc.path, text: doc.text, rel, htmlRel, title: deriveTitle(doc.text, fallback) }
  })
  const map = new Map(entries.map((entry) => [entry.path.toLowerCase(), entry.htmlRel]))

  const files: BatchFileInput[] = []
  const search: SearchEntry[] = []
  const skipped: string[] = []

  for (const entry of entries) {
    try {
      const nav = input.site
        ? { href: relativeBetween(dirOfPath(entry.htmlRel), 'index.html') ?? 'index.html', label: '← 返回目录' }
        : undefined
      const html = await buildDocHtml(entry.text, entry.title, options, {
        links: { pagePath: entry.htmlRel, docDir: dirOfPath(entry.path), map, resolve: resolvePath },
        nav
      })
      files.push({ relative: entry.htmlRel, html, docPath: entry.path })
      if (input.site) {
        const text = await renderText(entry.text)
        search.push({ path: entry.htmlRel, title: entry.title, text: text.slice(0, 2000) })
      }
    } catch (error) {
      skipped.push(`${entry.rel}：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const extras: Array<{ relative: string; content: string }> = []
  const title = baseName(input.root)
  if (input.site) {
    extras.push({ relative: 'index.html', content: buildIndexHtml({ title, entries, options, search }) })
    extras.push({
      relative: 'search-index.json',
      content: JSON.stringify({ title, generated: new Date().toISOString(), docs: search }, null, 2)
    })
  }

  return { title, files, extras, pages: files.length, skipped }
}

/** 导航页里的搜索脚本：数据内联，file:// 直开也能搜 */
const SEARCH_SCRIPT = `(function(){
  var data = window.__MDF_INDEX__ || [];
  var input = document.getElementById('mdf-q');
  var hits = document.getElementById('mdf-hits');
  var list = document.getElementById('mdf-list');
  if (!input || !hits || !list) return;
  function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function render(){
    var query = input.value.trim().toLowerCase();
    if (query === '') { hits.innerHTML = ''; list.style.display = ''; return; }
    var out = [];
    for (var i = 0; i < data.length && out.length < 30; i++) {
      var item = data[i];
      var text = (item.text || '').toLowerCase();
      var at = text.indexOf(query);
      if (at < 0 && (item.title || '').toLowerCase().indexOf(query) < 0) continue;
      var snippet = '';
      if (at >= 0) {
        var from = Math.max(0, at - 30);
        snippet = (from > 0 ? '…' : '') + item.text.slice(from, at + query.length + 60) + (at + query.length + 60 < item.text.length ? '…' : '');
      }
      out.push('<li><a href="' + esc(item.path) + '">' + esc(item.title || item.path) + '</a>' + (snippet ? '<div class="mdf-site-snippet">' + esc(snippet) + '</div>' : '') + '</li>');
    }
    list.style.display = 'none';
    hits.innerHTML = out.length > 0 ? '<ul class="mdf-site-list">' + out.join('') + '</ul>' : '<div class="mdf-site-empty">没有找到匹配</div>';
  }
  input.addEventListener('input', render);
})();`

const INDEX_CSS = `
.mdf-site-head { margin-bottom: 1.4em; }
.mdf-site-search input { width: 100%; padding: 8px 12px; font: inherit; font-size: 15px; color: inherit; background: transparent; border: 1px solid currentColor; border-radius: 6px; opacity: .9; box-sizing: border-box; }
.mdf-site-search input::placeholder { color: inherit; opacity: .45; }
.mdf-site-hits { margin-top: .8em; }
.mdf-site-list { list-style: none; padding-left: 0; }
.mdf-site-list li { display: flex; align-items: baseline; gap: 10px; padding: .35em 0; border-bottom: 1px dashed currentColor; border-color: color-mix(in srgb, currentColor 25%, transparent); }
.mdf-site-list a { flex: 1; }
.mdf-site-list .mdf-site-rel { flex: none; font-size: 12px; opacity: .5; font-family: 'Cascadia Mono', Consolas, monospace; }
.mdf-site-group { margin: 1.4em 0 .4em; font-size: 1em; opacity: .7; }
.mdf-site-snippet { margin-top: .2em; font-size: 13px; opacity: .7; }
.mdf-site-empty { opacity: .6; }
.mdf-site-meta { font-size: 13px; opacity: .6; }
`

export function buildIndexHtml(input: {
  title: string
  entries: ReadonlyArray<{ htmlRel: string; rel: string; title: string }>
  options: ExportOptions
  search: readonly SearchEntry[]
}): string {
  const groups = new Map<string, Array<{ htmlRel: string; rel: string; title: string }>>()
  for (const entry of input.entries) {
    const dir = dirOfPath(entry.htmlRel)
    const list = groups.get(dir) ?? []
    list.push(entry)
    groups.set(dir, list)
  }

  const parts: string[] = []
  for (const [dir, items] of groups) {
    if (groups.size > 1) {
      parts.push(`<h2 class="mdf-site-group">${escapeHtml(dir === '' ? '根目录' : dir)}</h2>`)
    }
    const links = items
      .map(
        (entry) =>
          `<li><a href="${escapeHtml(encodeURI(entry.htmlRel))}">${escapeHtml(entry.title)}</a><span class="mdf-site-rel">${escapeHtml(
            entry.rel
          )}</span></li>`
      )
      .join('\n')
    parts.push(`<ul class="mdf-site-list">\n${links}\n</ul>`)
  }

  // 内联检索数据时把 < 转义掉，避免正文里出现 </script> 之类的序列截断脚本
  const data = JSON.stringify(input.search).replace(/</g, '\\u003c')
  const generated = new Date().toLocaleString('zh-CN')

  const content = `<article class="mdf-doc">
<header class="mdf-site-head">
<h1>${escapeHtml(input.title)}</h1>
<p class="mdf-site-meta">由 MDForge 导出 · ${input.entries.length} 篇文档 · ${escapeHtml(generated)}</p>
</header>
<div class="mdf-site-search">
<input id="mdf-q" type="search" placeholder="搜索标题与正文…" autocomplete="off">
<div id="mdf-hits" class="mdf-site-hits"></div>
</div>
<div id="mdf-list">
${parts.join('\n')}
</div>
</article>
<script>window.__MDF_INDEX__=${data};</script>
<script>${SEARCH_SCRIPT}</script>`

  const css = cssForRef(input.options.theme, input.options.highlight)
  const template = templateHtmlForRef(input.options.template) ?? BUILTIN_TEMPLATE_HTML
  return applyTemplate(template, {
    title: escapeHtml(input.title),
    lang: 'zh-CN',
    style: `<style>${css}
${INDEX_CSS}</style>`,
    nav: '',
    content
  })
}
