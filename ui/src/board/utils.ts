import { marked } from 'marked'
import markedKatex from 'marked-katex-extension'
import 'katex/dist/katex.min.css'

// Configure marked for safe rendering with KaTeX math support.
// `breaks` stays OFF (CommonMark): a fiber's outcome/body is real markdown —
// often a hard-wrapped paragraph stored as a `|-` block scalar — so a soft
// newline must fold to a space, not a `<br>`. With `breaks:true` a wrapped
// outcome (e.g. science/cmbx's) rendered as a ragged wall of forced line
// breaks; CommonMark folding matches the vellum/PretextProse render the
// Portolan web-app shows, which is the parity target. Intentional breaks
// still work via GFM (two trailing spaces / backslash); blank lines still
// separate paragraphs.
marked.setOptions({
  gfm: true,        // GitHub Flavored Markdown
})

// $..$ for inline math, $$...$$ for display math
marked.use(markedKatex({
  throwOnError: false,
  output: 'html',
  nonStandard: true, // allow $...$ after punctuation like hyphen (pseudo-$C_\ell$)
}))

// Custom renderer for code blocks to integrate with Prism
const renderer = new marked.Renderer()
renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
  const language = lang || 'plaintext'
  // Prism will highlight after DOM insertion
  const escapedCode = escapeHtml(text)
  return `<pre class="md-code-block language-${language}"><code class="language-${language}">${escapedCode}</code></pre>`
}

renderer.codespan = ({ text }: { text: string }) => {
  return `<code class="md-inline-code">${escapeHtml(text)}</code>`
}

renderer.link = ({ href, text }: { href: string; text: string }) => {
  return `<a href="${escapeHtml(href)}" class="md-link" target="_blank" rel="noopener">${text}</a>`
}

// Strip KaTeX HTML from image alt text (marked-katex-extension processes $ inside alt)
renderer.image = ({ href, text: alt }: { href: string; text?: string }) => {
  const cleanAlt = (alt || '').replace(/<[^>]*>/g, '')
  return `<img src="${escapeHtml(href)}" alt="${escapeHtml(cleanAlt)}" loading="lazy" />`
}

marked.use({ renderer })

// GFM del rule matches ~text~ (single tilde) as well as ~~text~~ (double).
// Tilde is common as an approximation sign (~2 days), so escape lone tildes
// before parsing — but only outside code spans and fenced code blocks.
marked.use({
  hooks: {
    preprocess(src: string): string {
      // Split on code regions (fenced blocks or backtick spans) and only
      // process the non-code segments.
      const CODE_REGION = /(```[\s\S]*?```|`[^`]*`)/g
      const parts = src.split(CODE_REGION)
      return parts.map((part, i) => {
        // Odd indices are the captured code regions — leave untouched
        if (i % 2 === 1) return part
        // Even indices are plain text — escape lone tildes
        return part.replace(/~+/g, (m) => {
          const pairs = Math.floor(m.length / 2)
          const rem = m.length % 2
          return '~~'.repeat(pairs) + (rem ? '&#126;' : '')
        })
      }).join('')
    },
  },
})

/**
 * Escape HTML to prevent XSS
 */
export function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

// Local/relative image paths in rendered markdown resolve through the Shuttle
// daemon's owner-routed file route (GET /api/v1/file?path=&origin=). Relative,
// so both the daemon-served bundle and the dev proxy reach :4000 without CORS.
// The kanban board renders outcomes without a basePath, so this branch is
// dormant for the board today; the file route itself lands with the backend
// slice. (Portolan's :4004 /file-content service is eliminated per the
// Shuttle-UI constitution.)
const FILE_ROUTE = `/api/v1/file`

interface RenderMarkdownOptions {
  /** Base directory for resolving relative image paths (e.g. city path) */
  basePath?: string
  /** Origin ID for remote (owner-routed) file access */
  originId?: string
}

/**
 * Render markdown to HTML with syntax highlighting.
 * Relative image paths resolve through the Shuttle /file route when basePath is provided.
 */
export function renderMarkdown(text: string, opts?: RenderMarkdownOptions): string {
  try {
    // Use a per-call renderer to handle image path resolution
    if (opts?.basePath) {
      const localRenderer = new marked.Renderer()
      // Inherit code/codespan/link from the global renderer
      localRenderer.code = renderer.code
      localRenderer.codespan = renderer.codespan
      localRenderer.link = renderer.link
      localRenderer.image = ({ href, text: alt }: { href: string; text?: string }) => {
        // Relative/absolute local paths resolve through /file; http(s)/data
        // URLs (and an unresolvable relative path) pass through unchanged.
        const src = fileUrl(href, opts) ?? href
        const cleanAlt = (alt || '').replace(/<[^>]*>/g, '')
        return `<img src="${escapeAttr(src)}" alt="${escapeAttr(cleanAlt)}" loading="lazy" />`
      }
      return marked.parse(text, { renderer: localRenderer }) as string
    }
    return marked.parse(text) as string
  } catch (e) {
    console.error('Markdown render error:', e)
    return escapeHtml(text)
  }
}

/**
 * Attribute-safe escape: `escapeHtml` (textContent→innerHTML) escapes `<`, `>`,
 * and `&` but NOT quotes, so a value with a `"` could break out of a double-
 * quoted attribute. Escaping the quote too makes the result safe inside
 * `attr="…"`.
 */
export function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;')
}

/**
 * Build the URL a relative or absolute artifact path resolves to through the
 * Shuttle daemon's owner-routed file route (`GET /api/v1/file?path=&origin=`).
 * `http(s)`/`data` URLs pass through unchanged. A relative path needs
 * `opts.basePath` (the fiber's absolute dir) to become the absolute path the
 * route requires; without one it returns `null` so the caller can fall back to
 * a placeholder. `origin` is appended only for a remote-owned fiber, mirroring
 * the route's local-when-absent contract.
 */
export function fileUrl(rawPath: string, opts?: RenderMarkdownOptions): string | null {
  if (/^https?:\/\//.test(rawPath) || /^data:/.test(rawPath)) return rawPath
  const abs = resolveAbs(rawPath, opts)
  if (abs === null) return null
  let url = `${FILE_ROUTE}?path=${encodePathParam(abs)}`
  if (opts?.originId && opts.originId !== 'local') {
    url += `&origin=${encodeURIComponent(opts.originId)}`
  }
  return url
}

/**
 * HTML artifacts render inside same-origin `/api/v1/file` iframes. Treat
 * absolute web links as departures from the artifact, not in-frame navigation:
 * a report that omits `target="_blank"` should not strand the reader on arXiv
 * inside the fiber panel. Relative links and hash links stay under the
 * artifact's control.
 */
export function prepareIframeExternalLinks(iframe: HTMLIFrameElement): void {
  try {
    const doc = iframe.contentDocument
    if (!doc) return
    doc.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((anchor) => {
      const href = anchor.getAttribute('href')?.trim() ?? ''
      if (!/^https?:\/\//i.test(href)) return
      if (!anchor.hasAttribute('target')) anchor.target = '_blank'

      const rel = new Set((anchor.getAttribute('rel') ?? '').split(/\s+/).filter(Boolean))
      rel.add('noopener')
      anchor.setAttribute('rel', Array.from(rel).join(' '))
    })
  } catch {
    // Cross-origin/PDF frames are unreadable; leave their native behavior alone.
  }
}

/**
 * Resolve a relative or absolute artifact path to the absolute path the daemon
 * routes require. Absolute (`/…`) passes through; relative needs `opts.basePath`
 * (the fiber's dir); otherwise `null`.
 */
function resolveAbs(rawPath: string, opts?: RenderMarkdownOptions): string | null {
  if (rawPath.startsWith('/')) return rawPath
  if (opts?.basePath) return `${opts.basePath}/${rawPath}`
  return null
}

/**
 * Percent-encode a path for a query param. `encodeURIComponent` leaves `~` raw
 * (an unreserved mark), but the body is fed through `marked`, whose tilde-
 * preprocess hook rewrites a lone `~` to `&#126;` outside code regions — which
 * would corrupt a path under `~user`. Percent-encode it so the URL survives.
 */
function encodePathParam(abs: string): string {
  return encodeURIComponent(abs).replace(/~/g, '%7E')
}

/**
 * Build the URL a sent deliverable's *raw bytes* resolve to through the
 * daemon's owner-routed file route (`GET /api/v1/file?path=<ABSOLUTE>&origin=`).
 * This is the single repoint away from Portolan's retired `:4004`
 * `/project-file/…?standalone=1`: the daemon streams html/pdf/image/audio/text
 * with the right Content-Type, and HTML served as `text/html` is natively
 * iframe-scrollable — no `standalone` height-handshake. `origin` is appended
 * only for a remote-owned file, mirroring the route's local-when-absent
 * contract. `base` is the shuttle daemon base (`:4000`), '' for a same-origin
 * (daemon-served) bundle.
 */
export function fileBytesUrl(base: string, fullPath: string, originId: string): string {
  const abs = fullPath.startsWith('/') ? fullPath : `/${fullPath}`
  let url = `${base}${FILE_ROUTE}?path=${encodePathParam(abs)}`
  if (originId && originId !== 'local') url += `&origin=${encodeURIComponent(originId)}`
  return url
}

/**
 * Build the URL for the ASTRA paper render of an `astra.yaml`. The paper entry
 * (`paper.html`) bakes a project *dir* — the dir holding the astra.yaml — so we
 * resolve the file path, take its dirname, and pass it (owner-routed by origin)
 * to the entry, which fetches `/api/v1/astra` and renders via @lightcone/
 * renderer. Returns `null` when the path can't be resolved to an absolute dir.
 */
export function paperUrl(astraPath: string, opts?: RenderMarkdownOptions): string | null {
  const abs = resolveAbs(astraPath, opts)
  if (abs === null) return null
  const dir = dirname(abs)
  let url = `paper.html?path=${encodePathParam(dir)}`
  if (opts?.originId && opts.originId !== 'local') {
    url += `&origin=${encodeURIComponent(opts.originId)}`
  }
  return url
}

const EMBED_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'])
const EMBED_AUDIO_EXTS = new Set(['wav', 'mp3', 'm4a', 'ogg', 'flac', 'aac'])
const EMBED_DEFAULT_IFRAME_HEIGHT = 600
// An ASTRA paper render is the full lightcone chrome (masthead + scope rail) —
// it earns more vertical room than a generic file preview; it scrolls inside.
const EMBED_ASTRA_IFRAME_HEIGHT = 820

/**
 * Replace MyST `:::{embed} <path>` blocks with real artifact embeds resolved
 * through the `/file` route, by extension — images → `<img>`, audio →
 * `<audio>`, everything else (PDF, HTML, text) → a fixed-height scrolling
 * `<iframe>`, mirroring the sent-file viewer's dispatch. The `:height:` (px or
 * a unit-carrying length) and `:title:` options are honored. A relative path
 * needs the fiber's dir (`opts.basePath`) to resolve; without it — or for an
 * unresolvable path — the block degrades to a labelled placeholder, so a
 * report.html-style fiber on a host that can't resolve the dir still reads
 * cleanly. Runs BEFORE `marked`, injecting block-level HTML the renderer passes
 * through untouched.
 */
export function renderEmbeds(md: string, opts?: RenderMarkdownOptions): string {
  // `:::{embed} <path>` then optional `:key: val` option lines, closed by `:::`.
  const EMBED_RE =
    /^:::\{embed\}[ \t]+(\S+)[^\n]*\n((?:[ \t]*:[a-zA-Z-]+:[^\n]*\n)*)[ \t]*:::[ \t]*$/gim
  return md.replace(EMBED_RE, (_match, path: string, optionBlock: string) => {
    return '\n\n' + embedHtml(path, parseEmbedOptions(optionBlock), opts) + '\n\n'
  })
}

function parseEmbedOptions(block: string): { height?: string; title?: string } {
  const out: { height?: string; title?: string } = {}
  for (const line of block.split('\n')) {
    const m = line.match(/^[ \t]*:([a-zA-Z-]+):[ \t]*(.*)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    const val = m[2].trim()
    if (key === 'height') out.height = val
    else if (key === 'title') out.title = val
  }
  return out
}

function embedPlaceholderHtml(path: string, title?: string): string {
  const label = title ? escapeHtml(title) : 'embedded artifact'
  return `<div class="kbn-detail-embed kbn-detail-embed-missing"><span class="kbn-detail-embed-glyph">⧉</span><code>${escapeHtml(path)}</code><span class="kbn-detail-embed-note">${label} · couldn’t resolve a path to render</span></div>`
}

function embedHtml(
  path: string,
  embedOpts: { height?: string; title?: string },
  opts?: RenderMarkdownOptions,
): string {
  const src = fileUrl(path, opts)
  if (!src) return embedPlaceholderHtml(path, embedOpts.title)

  const ext = fileExt(path)
  const safeSrc = escapeAttr(src)
  const safeTitle = escapeAttr(embedOpts.title ?? basename(path))
  const caption = embedOpts.title ? `<figcaption>${escapeHtml(embedOpts.title)}</figcaption>` : ''
  const heightCss = cssLength(embedOpts.height)

  // An embedded `astra.yaml` opens the full Lightcone paper render in the paper
  // entry (isolated React + Tailwind), not the generic /file iframe. The paper
  // entry bakes the project dir and renders via @lightcone/renderer.
  if (basename(path) === 'astra.yaml') {
    const purl = paperUrl(path, opts)
    if (!purl) return embedPlaceholderHtml(path, embedOpts.title)
    const height = heightCss ?? `${EMBED_ASTRA_IFRAME_HEIGHT}px`
    return `<div class="kbn-detail-embed-frame kbn-detail-embed-astra" style="height:${height}"><iframe src="${escapeAttr(purl)}" title="${safeTitle}" loading="lazy"></iframe></div>`
  }

  if (EMBED_IMAGE_EXTS.has(ext)) {
    const style = heightCss ? ` style="height:${heightCss}"` : ''
    return `<figure class="kbn-detail-embed-figure"><img class="kbn-detail-embed-img" src="${safeSrc}" alt="${safeTitle}" loading="lazy"${style} />${caption}</figure>`
  }

  if (EMBED_AUDIO_EXTS.has(ext)) {
    return `<figure class="kbn-detail-embed-figure"><audio class="kbn-detail-embed-audio" controls src="${safeSrc}"></audio>${caption}</figure>`
  }

  // An embedded HTML artifact (report.html and friends) reads as part of the
  // page, not a porthole into another doc — so unless the author pins a
  // `:height:`, render it FULL-LENGTH: the iframe grows to its own content
  // height (measured post-load by FiberDetailModal.autosizeEmbeds — same-origin
  // through /file) and the panel page scrolls as one column, no nested
  // scrollbar. An explicit `:height:` opts back into the fixed, internally
  // scrolling frame.
  if (ext === 'html' || ext === 'htm') {
    if (heightCss) {
      return `<div class="kbn-detail-embed-frame" style="height:${heightCss}"><iframe src="${safeSrc}" title="${safeTitle}" loading="lazy"></iframe></div>`
    }
    return `<div class="kbn-detail-embed-frame kbn-detail-embed-autosize"><iframe src="${safeSrc}" title="${safeTitle}" loading="lazy" data-autosize="1"></iframe></div>`
  }

  const height = heightCss ?? `${EMBED_DEFAULT_IFRAME_HEIGHT}px`
  return `<div class="kbn-detail-embed-frame" style="height:${height}"><iframe src="${safeSrc}" title="${safeTitle}" loading="lazy"></iframe></div>`
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

function dirname(path: string): string {
  const i = path.replace(/\/+$/, '').lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

function fileExt(path: string): string {
  const base = basename(path).split(/[?#]/)[0]
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/**
 * Normalize a `:height:` option for an inline `style`. A bare number → `px`; a
 * value already carrying a CSS unit passes through; anything else → undefined.
 * The whitelist guards against style-attribute injection from the option text.
 */
function cssLength(value?: string): string | undefined {
  if (!value) return undefined
  const v = value.trim()
  if (/^\d+(\.\d+)?$/.test(v)) return `${v}px`
  if (/^\d+(\.\d+)?(px|em|rem|vh|vw|%)$/.test(v)) return v
  return undefined
}

/**
 * Resolve config[key] / config.x.y / config.yaml: x.y references in rendered markdown.
 * Appends " = value" annotations to matching inline code elements.
 */
export function interpolateConfig(container: HTMLElement, config: Record<string, string>): void {
  container.querySelectorAll<HTMLElement>('p code, td code, li code, h1 code, h2 code, h3 code').forEach(code => {
    const text = code.textContent?.trim() || ''
    const key = text
      .replace(/^config\.yaml:\s*/, '')
      .replace(/^config\[["']?/, '').replace(/["']?\]$/, '')
      .replace(/["']?\]\[["']?/g, '.')
      .replace(/^config\./, '')
    const value = config[key]
    if (value !== undefined) {
      const display = value.length > 60 ? value.slice(0, 57) + '...' : value
      code.textContent = display
      code.classList.add('config-resolved')
      code.title = key  // hover shows original key
    }
  })
}

// Matches inline code that looks like a file path, e.g. server/src/index.ts or ./foo/bar.py:42
// Also accepts :L42 or :L42-55 (GitHub-style line range) — both colon-digit and colon-L-digit forms work.
const INLINE_PATH_RE = /^(?:\.{0,2}\/)?[\w.\-/]+\/[\w.\-]+\.[a-zA-Z]{1,10}(?::L?\d+(?:-\d+)?)?$|^\.\/[\w.\-/]+\.[a-zA-Z]{1,10}(?::L?\d+(?:-\d+)?)?$/

function parsePathReference(value: string): { path: string; line?: number } | null {
  const text = value.trim()
  const m = text.match(/^(.*?)(?::L?(\d+)(?:-\d+)?)?$/)
  if (!m || !INLINE_PATH_RE.test(text)) return null
  return {
    path: m[1],
    line: m[2] ? parseInt(m[2], 10) : undefined,
  }
}

/**
 * Find inline <code> elements whose text looks like a file path and make them clickable.
 * `openFile(path, line)` is called with the resolved relative path and optional line number.
 */
export function attachInlinePathListeners(
  container: HTMLElement,
  openFile: (path: string, line?: number) => void,
): void {
  container.querySelectorAll<HTMLElement>('code.md-inline-code').forEach(code => {
    const parsed = parsePathReference(code.textContent || '')
    if (!parsed) return
    const { path, line } = parsed
    code.style.cursor = 'pointer'
    code.title = line ? `Open ${path} at line ${line}` : `Open ${path}`
    code.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      openFile(path, line)
    })
  })
}

export function attachMarkdownPathLinkListeners(
  container: HTMLElement,
  openFile: (path: string, line?: number) => void,
): void {
  container.querySelectorAll<HTMLAnchorElement>('a.md-link').forEach(link => {
    const href = link.getAttribute('href') || ''
    const parsed = parsePathReference(href)
    if (!parsed) return
    const { path, line } = parsed
    link.target = ''
    link.rel = ''
    link.title = line ? `Open ${path} at line ${line}` : `Open ${path}`
    link.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      openFile(path, line)
    })
  })
}

/**
 * Apply Prism syntax highlighting to code blocks in a container
 * Call after inserting markdown HTML into the DOM
 */
export function highlightCodeBlocks(container: HTMLElement): void {
  if (typeof window !== 'undefined' && (window as unknown as { Prism?: { highlightAllUnder: (el: HTMLElement) => void } }).Prism) {
    (window as unknown as { Prism: { highlightAllUnder: (el: HTMLElement) => void } }).Prism.highlightAllUnder(container)
  }
}

/**
 * Format a timestamp as relative time (e.g., "5m ago", "2h ago")
 * Returns empty string for invalid timestamps
 */
export function formatTimeAgo(timestamp: number): string {
  // Handle NaN/invalid timestamps (e.g., from malformed date strings)
  if (!Number.isFinite(timestamp)) return ''

  const diffMs = Date.now() - timestamp
  const diffMins = Math.floor(diffMs / 60000)

  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`

  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`

  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) return `${diffDays}d ago`

  return new Date(timestamp).toLocaleDateString()
}

/**
 * Format an ISO date string as "20 Feb 2026".
 */
export function formatFiberDate(iso: string | null | undefined): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  } catch { return iso }
}


/**
 * Map fiber status to a compact icon glyph.
 * active = half-filled, open = hollow, closed = filled, statusless = diamond
 * (structural container, not a task state).
 */
export function fiberStatusIcon(status: string): string {
  if (status === 'active') return '◐'
  if (status === 'closed') return '●'
  if (status === 'open') return '○'
  return '◇'
}

/**
 * Show a toast notification
 */
export function showToast(message: string, type: 'success' | 'error' = 'success', duration = 3000): void {
  // Remove existing toasts
  const existing = document.querySelector('.portolan-toast')
  if (existing) existing.remove()

  const toast = document.createElement('div')
  toast.className = 'portolan-toast'
  toast.innerHTML = `
    <span class="toast-icon">${type === 'success' ? '✓' : '✕'}</span>
    <span class="toast-message">${escapeHtml(message)}</span>
  `

  // Inject styles if not present
  if (!document.getElementById('portolan-toast-styles')) {
    const style = document.createElement('style')
    style.id = 'portolan-toast-styles'
    style.textContent = `
      .portolan-toast {
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%) translateY(100px);
        background: #1a1a1a;
        color: #f5f5f0;
        padding: 12px 20px;
        border-radius: 8px;
        display: flex;
        align-items: center;
        gap: 10px;
        font-family: 'EB Garamond', Garamond, serif;
        font-size: 14px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.4);
        z-index: 10000;
        opacity: 0;
        animation: toast-in 0.3s ease forwards;
      }
      .portolan-toast.toast-out {
        animation: toast-out 0.3s ease forwards;
      }
      .portolan-toast .toast-icon {
        font-size: 16px;
        font-weight: bold;
      }
      .portolan-toast.success .toast-icon { color: #c9a959; }
      .portolan-toast.error .toast-icon { color: #d9534f; }
      @keyframes toast-in {
        from { opacity: 0; transform: translateX(-50%) translateY(100px); }
        to { opacity: 1; transform: translateX(-50%) translateY(0); }
      }
      @keyframes toast-out {
        from { opacity: 1; transform: translateX(-50%) translateY(0); }
        to { opacity: 0; transform: translateX(-50%) translateY(100px); }
      }
    `
    document.head.appendChild(style)
  }

  toast.classList.add(type)
  document.body.appendChild(toast)

  setTimeout(() => {
    toast.classList.add('toast-out')
    setTimeout(() => toast.remove(), 300)
  }, duration)
}
