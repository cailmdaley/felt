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
 * Escape HTML to prevent XSS.
 *
 * Pure string work, deliberately — this used to round-trip through
 * `document.createElement('div').textContent`, which quietly made every
 * function that escapes anything (and so `renderMarkdown` itself) require a
 * DOM. Headless tests of markdown rendering died on `document is not defined`,
 * and the only way to test them was to shim a fake `document`, which is a lot
 * of ceremony for four replacements.
 *
 * The output is byte-identical to the DOM path. Verified against a real browser
 * over 19 cases — quotes, tabs, newlines, emoji, backslashes, U+00A0, already-
 * escaped entities — with zero divergence. Two details carry that equivalence:
 * `&` MUST be replaced first or the entities introduced below get double-
 * escaped, and U+00A0 needs its own clause because HTML fragment serialization
 * emits `&nbsp;` for it where a naive escaper would pass the raw character
 * through. Quotes are deliberately NOT escaped here, matching the DOM — that is
 * what `escapeAttr` adds.
 */
export function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\u00a0/g, '&nbsp;')
}

// Local/relative image paths in rendered markdown resolve through the Shuttle
// daemon's owner-routed file route (GET /api/v1/file?path=&origin=). Relative,
// so both the daemon-served bundle and the dev proxy reach :4000 without CORS.
// Fiber bodies render with a basePath (FiberDetailModal passes the fiber's
// dir), so relative paths resolve through this route; card outcomes render
// without one and leave relative paths untouched.
const FILE_ROUTE = `/api/v1/file`

interface RenderMarkdownOptions {
  /** Base directory for resolving relative image paths (e.g. city path) */
  basePath?: string
  /** Origin ID for remote (owner-routed) file access */
  originId?: string
  /**
   * The fiber's `shuttle.project_dir` — the SECOND place a relative link may
   * mean. A body written by a worker says `[AGENTS.md](AGENTS.md)` meaning the
   * repo it was working in, not the fiber's own folder in the felt store; those
   * are different directories and only one of them holds the file. Emitted as
   * an alternate candidate the host probes; see `installBodyFileLinks`.
   */
  projectDir?: string
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
      // Inherit code/codespan from the global renderer
      localRenderer.code = renderer.code
      localRenderer.codespan = renderer.codespan
      // LINKS resolve like images do. Inheriting the global link renderer left
      // `[AGENTS.md](AGENTS.md)` pointing at the page origin, so every relative
      // link in a fiber body opened a 404 on `localhost:4000/AGENTS.md` — the
      // image beside it worked, because only the image renderer was overridden
      // here. A relative href is a path in the fiber's own directory and
      // belongs on the same owner-routed `/file` route.
      //
      // `data-file-path` carries the resolved absolute path so a host that can
      // do better than a new tab — the detail panel, which has a file viewer —
      // intercepts the click and opens it in place. Without such a host the
      // href alone is already a working URL.
      localRenderer.link = ({ href, text }: { href: string; text: string }) => {
        const external = /^(https?:|mailto:|data:)/i.test(href) || href.startsWith('#')
        const resolved = external ? null : fileUrl(href, opts)
        if (resolved === null) return renderer.link({ href, text } as never)
        // TWO candidates, because a relative link in a fiber body is genuinely
        // ambiguous. The fiber's own directory is the first guess and the right
        // one for an attachment written beside the fiber. But a worker writing
        // `[AGENTS.md](AGENTS.md)` means the repo it was dispatched into —
        // `shuttle.project_dir` — and in the store's one real instance of this
        // the fiber-dir candidate does not exist while the project-dir one is a
        // 44KB file. Which is right cannot be known from the markdown, so both
        // ride out and the host probes; see `installBodyFileLinks`.
        const altBase = opts.projectDir
        const alt =
          altBase && altBase !== opts.basePath
            ? fileUrl(href, { ...opts, basePath: altBase })
            : null
        const altPath =
          alt !== null ? resolveAbs(href, { ...opts, basePath: altBase }) : null
        return (
          `<a href="${escapeAttr(resolved)}" class="md-link md-link-file"` +
          ` data-file-path="${escapeAttr(resolveAbs(href, opts) ?? href)}"` +
          (alt !== null && altPath !== null
            ? ` data-file-url-alt="${escapeAttr(alt)}" data-file-path-alt="${escapeAttr(altPath)}"`
            : '') +
          ` target="_blank" rel="noopener">${text}</a>`
        )
      }
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
function escapeAttr(text: string): string {
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

/** The by-extension image/audio vocabulary, shared by the two dispatches that
 *  key off it: `embedHtml` here (MyST `:::{embed}` blocks) and
 *  `buildFileViewer` in FileViewerPanel (sent deliverables). One vocabulary so
 *  the two can never drift. Read-only — never mutate these. */
export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'])
export const AUDIO_EXTS = new Set(['wav', 'mp3', 'm4a', 'ogg', 'flac', 'aac'])
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
  if (isAstraYaml(path)) {
    const purl = paperUrl(path, opts)
    if (!purl) return embedPlaceholderHtml(path, embedOpts.title)
    const height = heightCss ?? `${EMBED_ASTRA_IFRAME_HEIGHT}px`
    return `<div class="kbn-detail-embed-frame kbn-detail-embed-astra" style="height:${height}"><iframe src="${escapeAttr(purl)}" title="${safeTitle}" loading="lazy"></iframe></div>`
  }

  if (IMAGE_EXTS.has(ext)) {
    const style = heightCss ? ` style="height:${heightCss}"` : ''
    return `<figure class="kbn-detail-embed-figure"><img class="kbn-detail-embed-img" src="${safeSrc}" alt="${safeTitle}" loading="lazy"${style} />${caption}</figure>`
  }

  if (AUDIO_EXTS.has(ext)) {
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

export function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

/** An `astra.yaml` renders as the full Lightcone paper rather than raw YAML,
 *  in a fiber body and in the sent-file viewer alike. */
export function isAstraYaml(path: string): boolean {
  return basename(path) === 'astra.yaml'
}

function dirname(path: string): string {
  const i = path.replace(/\/+$/, '').lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

export function fileExt(path: string): string {
  // Strip a trailing `?query` / `#frag` off the EXTENSION rather than off the
  // whole basename: stripping first is right for a URL embed (`plot.png?v=2`)
  // but loses the extension on a filesystem path (`figure#1.png`), and the
  // sent-file viewer only ever passes filesystem paths.
  const base = basename(path)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).split(/[?#]/)[0].toLowerCase() : ''
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
