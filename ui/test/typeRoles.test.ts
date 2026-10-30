// Every text the board draws takes its type from src/styles/type.css.
//
// The type file names the size roles, leadings, families, the kicker's caps and
// the tracking tokens. Anywhere else in ui/src (CSS, CSS inside TS template
// strings, style objects, style assignments, setProperty, setAttribute, SVG
// attributes, canvas fonts) a size, family, leading, tracking or case may only
// name those tokens (or inherit). Anything raw is a parallel scale in waiting,
// and this scan fails on it, naming file:line.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { expect, it } from 'vitest'

const SRC = resolve('src')
const OWNER = 'styles/type.css'

const SIZE = /^var\(--type-[a-z-]+\)$/
const GLYPH = /^var\(--glyph-[a-z-]+\)$/
const FAMILY = /^var\(--font-(serif|mono|initials|initials-frill)\)$/
const LEADING = /^var\(--leading-[a-z]+\)$/
const TRACK = /^var\(--track-[a-z]+\)$/
/** A line box set by geometry rather than leading: a length, or a box token. */
const BOX = /^(\d+(\.\d+)?px|calc\(.*\)|var\(--[a-z-]+-(h|height|target)\))$/
const KEYWORD = /^(inherit|unset|initial|revert)$/
/** Family names belong to type.css alone, in any string. */
const FAMILY_NAME = /\b(EB Garamond|Garamond|Georgia|IBM Plex|Plex Mono|SF Mono|Menlo|Monaco|Consolas|Courier|ui-monospace|ui-serif|ui-sans-serif|system-ui|-apple-system|BlinkMacSystemFont|Helvetica|Arial|sans-serif|monospace|cursive|fantasy)\b|(?<![\w-])serif\b/
/** Selectors that draw a mark from a font rather than text. */
const MARK = /::?(before|after|marker)|cap\b|initial|ornament|glyph|mark|chevron|close|caret|arrow|icon|bullet/

type Prop = 'size' | 'family' | 'leading' | 'font' | 'track' | 'case' | 'caps'
const PROPS: Record<string, Prop> = {
  'font-size': 'size', fontSize: 'size',
  'font-family': 'family', fontFamily: 'family',
  'line-height': 'leading', lineHeight: 'leading',
  font: 'font',
  'letter-spacing': 'track', letterSpacing: 'track',
  'text-transform': 'case', textTransform: 'case',
  'font-variant': 'caps', fontVariant: 'caps', 'font-variant-caps': 'caps', fontVariantCaps: 'caps',
}
const CSS_PROP = '(?<![\\w$-])(font-size|font-family|font-variant-caps|font-variant|font|line-height|letter-spacing|text-transform)'
const JS_PROP = '(fontSize|fontFamily|fontVariantCaps|fontVariant|font|lineHeight|letterSpacing|textTransform|font-size|font-family|font-variant-caps|font-variant|line-height|letter-spacing|text-transform)'

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path)
    return /\.(css|tsx?)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [path] : []
  })
}

type Ctx = 'code' | 'str' | 'css'
/**
 * Blanks comments (keeping offsets and newlines) and marks what each character
 * is: TS code, a quoted TS string, or CSS (a .css file, or a TS template
 * string, whose `${…}` holes are code again). Quotes do not open comments, in
 * TS or in CSS; a quoted string ends at its line's end, so a regex literal
 * holding a quote cannot unbalance the rest of the file.
 */
function scan(text: string, css: boolean): { text: string; ctx: Ctx[] } {
  const out = text.split('')
  const ctx: Ctx[] = new Array(text.length).fill(css ? 'css' : 'code')
  // The mode stack: code, a template, or a `${` hole (code that returns to its template at its closing brace).
  const stack: ('code' | 'tpl' | 'hole')[] = [css ? 'tpl' : 'code']
  let depth = 0 // braces open inside the innermost hole
  const blank = (from: number, to: number) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ' }
  let i = 0
  while (i < text.length) {
    const mode = stack[stack.length - 1]
    const c = text[i], n = text[i + 1]
    const inCss = mode === 'tpl'
    const here: Ctx = inCss ? 'css' : 'code'
    if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end < 0 ? text.length : end + 2
      for (let k = i; k < stop; k++) ctx[k] = here
      blank(i, stop); i = stop; continue
    }
    if (!inCss && c === '/' && n === '/') {
      const end = text.indexOf('\n', i)
      const stop = end < 0 ? text.length : end
      for (let k = i; k < stop; k++) ctx[k] = here
      blank(i, stop); i = stop; continue
    }
    if (!inCss && c === '/' && /(^|[(,=:[!&|?{};+\-*%<>~^]|\breturn|\btypeof)\s*$/.test(text.slice(Math.max(0, i - 12), i))) {
      // A regex literal: its quotes and backticks are pattern, not strings. It ends at its line.
      let k = i + 1, cls = false
      while (k < text.length && text[k] !== '\n' && (cls || text[k] !== '/')) {
        if (text[k] === '\\') k++
        else if (text[k] === '[') cls = true
        else if (text[k] === ']') cls = false
        k++
      }
      for (let j = i; j <= k && j < text.length; j++) ctx[j] = 'code'
      i = k + 1; continue
    }
    if (c === "'" || c === '"') {
      // A quoted string, in TS or in CSS: no comments inside, ends at its quote or its line.
      let k = i + 1
      while (k < text.length && text[k] !== c && text[k] !== '\n') k += text[k] === '\\' ? 2 : 1
      const stop = Math.min(k + 1, text.length)
      for (let j = i; j < stop; j++) ctx[j] = inCss ? 'css' : 'str'
      i = stop; continue
    }
    ctx[i] = here
    if (inCss) {
      if (c === '\\') { ctx[i + 1] = here; i += 2; continue }
      if (c === '`' && !css) stack.pop()
      else if (c === '$' && n === '{') { stack.push('hole'); depth = 0; ctx[i + 1] = 'code'; i += 2; continue }
    } else if (c === '`') stack.push('tpl')
    else if (mode === 'hole' && c === '{') depth++
    else if (mode === 'hole' && c === '}') { if (depth === 0) stack.pop(); else depth-- }
    i++
  }
  return { text: out.join(''), ctx }
}

function lineOf(text: string, offset: number): number {
  let line = 1
  for (let k = 0; k < offset; k++) if (text.charCodeAt(k) === 10) line++
  return line
}

/** Splits a `font` shorthand into its size, leading and family; style, variant and weight may lead. */
function shorthand(value: string): { size?: string; leading?: string; family?: string; caps?: string } {
  const tokens = value.split(/\s+/)
  let caps: string | undefined
  while (tokens.length && /^(italic|oblique|normal|small-caps|all-small-caps|bold|bolder|lighter|\d00)$/.test(tokens[0])) {
    if (/small-caps/.test(tokens[0])) caps = tokens[0]
    tokens.shift()
  }
  const [size, ...family] = tokens
  const [head, leading] = (size ?? '').split('/')
  return { size: head || undefined, leading, family: family.join(' ') || undefined, caps }
}

function clean(value: string): string {
  return value.replace(/!important/, '').trim().replace(/^['"`]|['"`]$/g, '').trim()
}

interface Decl { prop: Prop; value: string; offset: number }

/** Why a declaration's value is off the system, or undefined when it is on it. */
function judge(prop: Prop, value: string): string | undefined {
  if (KEYWORD.test(value) || value === '') return undefined
  switch (prop) {
    case 'size': return SIZE.test(value) || GLYPH.test(value) ? undefined : 'raw size'
    case 'family': return FAMILY.test(value) ? undefined : 'raw family'
    case 'leading': return LEADING.test(value) || BOX.test(value) || value === 'normal' ? undefined : 'raw leading'
    case 'track': return TRACK.test(value) || /^(0|normal)$/.test(value) ? undefined : 'raw tracking'
    case 'case': return value === 'none' ? undefined : 'case is the kicker role, not text-transform'
    case 'caps': return /(?<!all-)small-caps/.test(value) ? 'mixed small caps: the kicker is all-small-caps'
      : /^[a-z- ]+$/.test(value) ? undefined : 'raw caps'
    case 'font': {
      if (value.startsWith('var(--font-')) return undefined
      const { size, leading, family, caps } = shorthand(value)
      if (caps && caps !== 'all-small-caps') return 'mixed small caps: the kicker is all-small-caps'
      if (size && !SIZE.test(size) && !GLYPH.test(size)) return 'raw size'
      if (leading && !LEADING.test(leading) && !BOX.test(leading)) return 'raw leading'
      if (family && !FAMILY.test(family)) return 'raw family'
      return undefined
    }
  }
}

const JS_VALUE = `('(?:[^'\\\\\\n]|\\\\.)*'|"(?:[^"\\\\\\n]|\\\\.)*"|\`[^\`]*\`|[^,;}\\n)]+)`
const JS_FORMS = [
  // Object keys, bare or quoted: { fontSize: '12px' }, { 'font-size': '12px' }.
  new RegExp(`(?<![\\w$.\\-'"])(['"]?)${JS_PROP}\\1\\s*:\\s*${JS_VALUE}`, 'g'),
  // Assignment, dotted or bracketed: el.style.fontSize = …, ctx.font = …, style['font-size'] = ….
  new RegExp(`(?:\\.|\\[\\s*)(['"]?)${JS_PROP}\\1\\s*\\]?\\s*=(?!=)\\s*${JS_VALUE}`, 'g'),
  // style.setProperty('font-size', …), setAttribute('font-size', …), setAttributeNS(null, 'font-size', …).
  new RegExp(`(?:setProperty|setAttribute|setAttributeNS)\\(\\s*(?:null\\s*,\\s*)?(['"])${JS_PROP}\\1\\s*,\\s*${JS_VALUE}`, 'g'),
]

function declarations(text: string, ctx: Ctx[]): Decl[] {
  const found: Decl[] = []
  const push = (name: string, value: string, offset: number) => {
    const prop = PROPS[name]
    if (prop) found.push({ prop, value: clean(value), offset })
  }
  // CSS: a .css file, or a template string. The value runs to `;`, `}` or the string's end, across lines.
  for (const m of text.matchAll(new RegExp(`${CSS_PROP}\\s*:\\s*([^;{}\`]*)`, 'g'))) {
    if (ctx[m.index] === 'css') push(m[1], m[2], m.index)
  }
  // SVG and HTML attributes in markup strings: font-size="11".
  for (const m of text.matchAll(/(?<![\w-])(font-size|font-family|letter-spacing|text-transform)\s*=\s*(\\?['"])(.*?)\2/g)) {
    if (ctx[m.index] !== 'code') push(m[1], m[3], m.index)
  }
  // JSX attributes: fontSize={11}.
  for (const m of text.matchAll(/(?<![\w-])(fontSize|fontFamily|letterSpacing)=\{([^}]*)\}/g)) {
    if (ctx[m.index] === 'code') push(m[1], m[2], m.index)
  }
  for (const re of JS_FORMS) {
    for (const m of text.matchAll(re)) {
      if (ctx[m.index] !== 'code' && !(ctx[m.index] === 'str' && /^['"]/.test(m[0]))) continue
      // A TypeScript type annotation (`font: string`) is not a style.
      if (!/^['"`]/.test(m[3]) && /^(string|number|boolean|undefined|null|[A-Z]\w*(<.*>)?|\w+\[\])\s*$/.test(m[3].trim())) continue
      push(m[2], m[3], m.index)
    }
  }
  return found
}

/** The innermost CSS blocks: selector and body, with the body's offset. */
function blocks(text: string, ctx: Ctx[]): { selector: string; body: string; offset: number }[] {
  const found: { selector: string; body: string; offset: number }[] = []
  for (const m of text.matchAll(/([^{};`]*)\{([^{}]*)\}/g)) {
    if (ctx[m.index + m[1].length] !== 'css') continue
    found.push({ selector: m[1].trim(), body: m[2], offset: m.index + m[1].length })
  }
  return found
}

function violations(file: string, source: string, defined: Set<string>): string[] {
  const found: string[] = []
  const { text, ctx } = scan(source, file.endsWith('.css'))
  const at = (offset: number, what: string) => found.push(`${file}:${lineOf(text, offset)}  ${what}`)

  for (const d of declarations(text, ctx)) {
    const why = judge(d.prop, d.value)
    if (why) at(d.offset, `${why}: ${d.value}`)
  }

  // Family names live in type.css alone, in any string or stylesheet.
  for (const m of text.matchAll(new RegExp(FAMILY_NAME, 'g'))) {
    if (ctx[m.index] !== 'code') at(m.index, `family name: ${m[0]}`)
  }

  // Every type token used exists.
  for (const m of text.matchAll(/var\(\s*(--(?:type|leading|font|glyph|track|rhythm)-[a-z0-9-]+)/g)) {
    if (!defined.has(m[1])) at(m.index, `undefined token: ${m[1]}`)
  }

  for (const b of blocks(text, ctx)) {
    const own = declarations(b.body, b.body.split('').map(() => 'css' as Ctx))
    const get = (prop: Prop) => own.filter(d => d.prop === prop)
    const fonts = get('font').map(d => shorthand(d.value))
    const sizes = [...get('size').map(d => d.value), ...fonts.flatMap(f => f.size ? [f.size] : [])]
    const leadings = [...get('leading').map(d => d.value), ...fonts.flatMap(f => f.leading ? [f.leading] : [])]
    const families = [...get('family').map(d => d.value), ...fonts.flatMap(f => f.family ? [f.family] : [])]
    const caps = [...get('caps').map(d => d.value), ...fonts.flatMap(f => f.caps ? [f.caps] : [])]

    // A glyph token sizes a mark, never text.
    if (sizes.some(s => GLYPH.test(s)) && !MARK.test(b.selector)) at(b.offset, `glyph token on text: ${b.selector}`)

    // A line box from geometry is for a box: a mark, or one line that cannot wrap.
    const nowrap = /white-space\s*:\s*(nowrap|pre)\b/.test(b.body)
    const empty = /content\s*:\s*(''|"")/.test(b.body)
    if (leadings.some(l => BOX.test(l)) && !nowrap && !empty && !MARK.test(b.selector)) {
      at(b.offset, `box line-height on wrapping text, use a leading role: ${b.selector}`)
    }

    // The kicker is all-small-caps at its tracking token, never at meta size (its caps render near 8px).
    if (caps.some(c => /all-small-caps/.test(c))) {
      if (!get('track').some(d => TRACK.test(d.value))) at(b.offset, `kicker without its tracking token: ${b.selector}`)
      if (sizes.includes('var(--type-meta)')) at(b.offset, `kicker at meta size: ${b.selector}`)
    }

    // A bare count is mono meta.
    const last = b.selector.split(',').pop() ?? ''
    if (/-count\b/.test(last) && (families.length || sizes.length) && !families.includes('var(--font-mono)')) {
      at(b.offset, `a count is mono: ${b.selector}`)
    }
  }
  return found
}

function definedTokens(): Set<string> {
  const text = readFileSync(join(SRC, OWNER), 'utf8')
  return new Set([...text.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1]))
}

it('every font size, leading, family, tracking and case names a role from styles/type.css', () => {
  const defined = definedTokens()
  const found = files(SRC).flatMap((path) => {
    const file = relative(SRC, path)
    if (file === OWNER) return []
    return violations(file, readFileSync(path, 'utf8'), defined)
  })
  expect(found, `type outside ${OWNER}:\n${found.join('\n')}`).toEqual([])
})

/** Each form the scan guards: a source that must fail, read as the named file. */
const MUST_FAIL: [string, string][] = [
  ['x.css', '.a { font-size: 13px; }'],
  ['x.css', '.b { font-size: calc(11px * var(--kbn-type-scale, 1)); }'],
  ['x.css', '.c { font-family: var(--ws-mono); }'],
  ['x.css', '.d { font: italic 12px/1.4 var(--font-serif); }'],
  ['x.css', '.e { font: var(--type-label)/1.4 var(--font-serif); }'],
  ['x.css', '.f { line-height: 1.5; }'],
  ['x.css', '.g { line-height: calc(1.5); }'],
  ['x.ts', "el.style.fontSize = '0.9em'"],
  ['x.ts', "const s = { fontFamily: 'var(--font-main, serif)' }"],
  ['x.ts', 'const s = { lineHeight: 1.2 }'],
  ['x.ts', "el.style.setProperty('font-size', '13px')"],
  ['x.ts', "text.setAttribute('font-size', '11')"],
  ['x.ts', "text.setAttributeNS(null, 'font-family', 'Georgia')"],
  ['x.ts', 'const svg = `<text x="0" font-size="11">a</text>`'],
  ['x.ts', "const svg = '<text font-family=\"Menlo\">a</text>'"],
  ['x.ts', "el.style.font = '12px var(--font-mono)'"],
  ['x.ts', "ctx.font = '11px sans-serif'"],
  ['x.ts', "el.style['font-size'] = '12px'"],
  ['x.ts', "const s = { 'font-size': '12px' }"],
  ['x.tsx', '<text fontSize={11}>a</text>'],
  ['x.css', '.h {\n  color: red;\n* font-size: 13px; }'],
  ['x.css', '.i {\n  font:\n    italic 12px/1.4 var(--font-serif);\n}'],
  ['x.ts', 'const s = {\n  fontSize:\n    12,\n}'],
  ['x.ts', "const family = 'IBM Plex Mono'"],
  ['x.ts', 'const family = "EB Garamond, serif"'],
  ['x.css', '.j { font-size: var(--type-nonexistent); }'],
  ['x.css', '.k { font: var(--type-meta)/var(--leading-nope) var(--font-serif); }'],
  ['x.css', '.l { font-size: var(--glyph-small); }'],
  ['x.ts', "import.meta.glob('./themes/*.css')\nconst css = `.m { font-size: 13px; }`"],
  ['x.css', '.n { letter-spacing: .06em; }'],
  ['x.ts', "const s = { letterSpacing: '0.1em' }"],
  ['x.css', '.o { text-transform: uppercase; }'],
  ['x.css', '.p { font-variant: small-caps; letter-spacing: var(--track-kicker); }'],
  ['x.css', '.q { font-variant-caps: all-small-caps; }'],
  ['x.css', '.r { font: var(--type-meta)/var(--leading-ui) var(--font-serif); font-variant-caps: all-small-caps; letter-spacing: var(--track-kicker); }'],
  ['x.css', '.s { font-size: var(--type-prose); line-height: 24px; }'],
  ['x.css', '.t { font: var(--type-prose)/var(--ctl-line-height) var(--font-serif); }'],
  ['x.css', '.ws-col-count { font: var(--type-meta)/var(--leading-ui) var(--font-serif); }'],
  ['x.ts', "const css = `.u { content: '/*'; font-size: 13px; }`"],
  ['x.css', '.ws-group-count { font-size: var(--type-meta); }'],
  ['x.ts', "const re = /`/g\nconst css = `.v { font-size: 13px; }`"],
]

const MUST_PASS: [string, string][] = [
  ['x.css', '.ok { font-size: var(--type-row); font-family: var(--font-serif); line-height: var(--leading-ui); }'],
  ['x.css', '.ok { font: italic 500 var(--type-label)/var(--leading-prose) var(--font-serif); }'],
  ['x.css', '.ok { font: inherit; letter-spacing: 0; text-transform: none; }'],
  ['x.css', '.ok { height: 24px; line-height: 24px; white-space: nowrap; }'],
  ['x.css', ".ok::before { content: ''; line-height: 10px; }"],
  ['x.css', '.ok { font-size: var(--type-note); font-variant-caps: all-small-caps; letter-spacing: var(--track-kicker); }'],
  ['x.css', '.ok-cap::first-letter { font-size: var(--glyph-initial); }'],
  ['x.ts', "const url = 'https://example.com/*'; // a comment: font-size: 13px"],
  ['x.ts', 'interface A { font: string; fontSize?: number }'],
  ['x.ts', "el.style.fontSize = ''"],
  ['x.css', '.ws-col-count { font: var(--type-meta)/var(--leading-ui) var(--font-mono); }'],
]

it('the scan catches every form it guards, and passes the system', () => {
  const defined = new Set(['--type-row', '--type-label', '--type-note', '--type-meta', '--type-prose', '--leading-ui', '--leading-prose',
    '--font-serif', '--font-mono', '--glyph-small', '--glyph-initial', '--track-kicker'])
  const missed = MUST_FAIL.filter(([file, src]) => violations(file, src, defined).length === 0).map(([, src]) => src)
  expect(missed, 'forms the scan let through').toEqual([])
  const flagged = MUST_PASS.flatMap(([file, src]) => violations(file, src, defined))
  expect(flagged, 'the system, flagged').toEqual([])
})

it('only styles/type.css defines the type tokens', () => {
  const define = /(?<![\w-])--(type|leading|font|glyph|rhythm|track)-[a-z-]+\s*:/
  const found = files(SRC).flatMap((path) => {
    const file = relative(SRC, path)
    if (file === OWNER) return []
    return readFileSync(path, 'utf8').split('\n').flatMap((line, i) => define.test(line) ? [`${file}:${i + 1}  ${line.trim()}`] : [])
  })
  expect(found, `type tokens redefined outside ${OWNER}:\n${found.join('\n')}`).toEqual([])
})
