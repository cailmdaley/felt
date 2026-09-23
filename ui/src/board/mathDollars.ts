import katex from 'katex'
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

function render(token: MathToken, trailing = ''): string {
  return katex.renderToString(token.text, {
    throwOnError: false,
    output: 'html',
    displayMode: token.displayMode,
  }) + trailing
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
