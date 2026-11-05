import type Katex from 'katex'
import type { MarkedExtension, Tokens } from 'marked'

// Dollar-delimited TeX for marked, with Pandoc's `tex_math_dollars` rules so
// prose about money stays prose. A `$…$` span is math only when the opening
// `$` is followed by a non-space, the closing `$` follows a non-space, and the
// closing `$` is not followed by a digit. "$5,866 (CapOne $1,232 …" therefore
// never pairs up — every candidate closer sits after a space — while
// `$C_\ell$`, `pseudo-$C_\ell$` and `$x$` all render. `\$` is a literal dollar
// (marked's escape tokenizer consumes it before this rule is tried).
//
// `$$…$$` inside a line is display math; `$$` alone on the lines above and
// below a block is display math as a block.

const INLINE_DISPLAY = /^\$\$(?!\$)((?:\\.|[^\\\n])+?)\$\$/
const INLINE = /^\$(?![\s$])((?:\\.|[^\\\n$])*?(?:\\.|[^\\\s$]))\$(?!\d)/
const BLOCK = /^\$\$\n((?:\\[^]|[^\\])+?)\n\$\$(?:\n|$)/

type MathToken = Tokens.Generic & { text: string; displayMode: boolean }

function matchInline(src: string): RegExpMatchArray | null {
  return src.match(INLINE_DISPLAY) ?? src.match(INLINE)
}

// A formula is a placeholder until after sanitizing, in every mode: the sanitizer
// sees only a span holding the source, and KaTeX's styled output never passes
// through it. KaTeX is most of the bundle's weight and few pages carry math, so
// it loads on first need; renderMarkdown typesets placeholders once it is here,
// and the placeholders of a page drawn earlier are typeset when it arrives.
let katex: typeof Katex | undefined
let loading: Promise<void> | undefined

// `maxSize` caps user-specified sizes in em. It does not cap `\kern`, so the box
// in math.css, not this bound, is what keeps a formula on its own part of the page.
const typeset = (tex: string, displayMode: boolean): string => {
  const formula = katex!.renderToString(tex, {
    throwOnError: false, output: 'html', displayMode, trust: false, maxSize: 20, maxExpand: 1000,
  })
  return `<span class="math-box${displayMode ? ' math-box-display' : ''}">${formula}</span>`
}

// The source stays readable where a placeholder lost its `data-tex` to the sanitizer,
// and where KaTeX throws: nesting that overflows the stack is not a ParseError.
function typesetPlaceholders(root: ParentNode): void {
  for (const pending of root.querySelectorAll<HTMLElement>('.math-pending')) {
    const tex = pending.dataset.tex
    if (tex === undefined) continue
    try { pending.outerHTML = typeset(tex, pending.dataset.display === 'true') } catch { /* See above. */ }
  }
}

/** Load KaTeX and typeset any formula drawn while it was loading. */
export function loadMath(): Promise<void> {
  loading ??= import('katex').then(module => {
    katex = module.default
    if (typeof document !== 'undefined') typesetPlaceholders(document)
  }, (error: unknown) => {
    loading = undefined
    throw error
  })
  return loading
}

/** Typeset the placeholders in sanitized HTML; until KaTeX arrives they stay for `loadMath`. */
export function typesetSanitized(html: string): string {
  if (!katex || !html.includes('math-pending')) return html
  const template = document.createElement('template')
  template.innerHTML = html
  typesetPlaceholders(template.content)
  return template.innerHTML
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function render(token: MathToken, trailing = ''): string {
  if (!katex) void loadMath().catch(() => { /* The source stays readable; the next render retries. */ })
  return `<span class="math-pending" data-tex="${escapeHtml(token.text)}" data-display="${token.displayMode}">${escapeHtml(token.raw)}</span>${trailing}`
}

export function mathDollars(): MarkedExtension {
  return {
    extensions: [
      {
        name: 'inlineMath',
        level: 'inline',
        start(src: string) {
          for (let i = src.indexOf('$'); i !== -1; i = src.indexOf('$', i + 1)) {
            if (i > 0 && src[i - 1] === '\\') continue
            if (matchInline(src.slice(i))) return i
          }
          return undefined
        },
        tokenizer(src: string) {
          const m = matchInline(src)
          if (!m) return undefined
          return {
            type: 'inlineMath',
            raw: m[0],
            text: m[1].trim(),
            displayMode: m[0].startsWith('$$'),
          }
        },
        renderer: (token) => render(token as MathToken),
      },
      {
        name: 'blockMath',
        level: 'block',
        tokenizer(src: string) {
          const m = src.match(BLOCK)
          if (!m) return undefined
          return { type: 'blockMath', raw: m[0], text: m[1].trim(), displayMode: true }
        },
        renderer: (token) => render(token as MathToken, '\n'),
      },
    ],
  }
}
