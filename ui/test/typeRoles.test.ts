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
import ts from 'typescript'
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
/** Pseudo-elements that draw a mark rather than text. */
const MARK_PSEUDO_ELEMENTS = new Set(['before', 'after', 'marker', 'first-letter'])
/** A glyph token may size only the board's named illuminated initial spans. */
const GLYPH_TEXT_SELECTORS = new Set([
  '.kbn-cap',
  '.kbn-col-title .kbn-cap',
  '.kbn-view-title .kbn-cap',
  '.ws-overview-heading h1 .kbn-cap',
  '.kbn-ctl-history-chevron',
])

type Prop = 'size' | 'family' | 'leading' | 'font' | 'track' | 'case' | 'caps' | 'feature'
const PROPS: Record<string, Prop> = {
  'font-size': 'size', fontSize: 'size',
  'font-family': 'family', fontFamily: 'family',
  'line-height': 'leading', lineHeight: 'leading',
  font: 'font',
  'letter-spacing': 'track', letterSpacing: 'track',
  'text-transform': 'case', textTransform: 'case',
  'font-variant': 'caps', fontVariant: 'caps', 'font-variant-caps': 'caps', fontVariantCaps: 'caps',
  'font-feature-settings': 'feature', fontFeatureSettings: 'feature',
}
const CSS_PROP = '(?<![\\w$-])(font-size|font-family|font-variant-caps|font-variant|font-feature-settings|font|line-height|letter-spacing|text-transform)'

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
  while (tokens.length && /^(italic|oblique|normal|small-caps|all-small-caps|petite-caps|all-petite-caps|unicase|titling-caps|bold|bolder|lighter|\d00)$/.test(tokens[0])) {
    if (/caps|unicase/.test(tokens[0])) caps = tokens[0]
    tokens.shift()
  }
  const [size, ...family] = tokens
  const [head, leading] = (size ?? '').split('/')
  return { size: head || undefined, leading, family: family.join(' ') || undefined, caps }
}

function clean(value: string): string {
  return value.replace(/!important/, '').trim().replace(/^['"`]|['"`]$/g, '').trim()
}

interface Decl { prop: Prop; value: string; offset: number; code: boolean }

/** Case variants other than the kicker's, in font-variant(-caps) or as OpenType features. */
const OFF_CAPS = /(?<![\w-])(small-caps|all-petite-caps|petite-caps|unicase|titling-caps)\b/
const CAPS_FEATURE = /(?<![\w-])(smcp|c2sc|pcap|c2pc|unic|titl)\b/

function capsWhy(value: string): string | undefined {
  if (OFF_CAPS.test(value)) return 'off-system caps: the kicker is all-small-caps'
  return /^[a-z- ]+$/.test(value) ? undefined : 'raw caps'
}

/** Why a declaration's value is off the system, or undefined when it is on it. */
function judge(prop: Prop, value: string): string | undefined {
  if (KEYWORD.test(value) || value === '') return undefined
  switch (prop) {
    case 'size': return SIZE.test(value) || GLYPH.test(value) ? undefined : 'raw size'
    case 'family': return FAMILY.test(value) ? undefined : 'raw family'
    case 'leading': return LEADING.test(value) || BOX.test(value) || value === 'normal' ? undefined : 'raw leading'
    case 'track': return TRACK.test(value) || /^(0(px|em)?|normal)$/.test(value) ? undefined : 'raw tracking'
    case 'case': return value === 'none' ? undefined : 'case is the kicker role, not text-transform'
    case 'caps': return capsWhy(value)
    case 'feature': return CAPS_FEATURE.test(value) ? 'caps by feature: the kicker is font-variant-caps: all-small-caps' : undefined
    case 'font': {
      if (value.startsWith('var(--font-')) return undefined
      const { size, leading, family, caps } = shorthand(value)
      if (caps) { const why = capsWhy(caps); if (why) return why }
      if (size && !SIZE.test(size) && !GLYPH.test(size)) return 'raw size'
      if (leading && !LEADING.test(leading) && !BOX.test(leading)) return 'raw leading'
      if (family && !FAMILY.test(family)) return 'raw family'
      return undefined
    }
  }
}

function declarations(text: string, ctx: Ctx[], file = ''): Decl[] {
  const found: Decl[] = []
  const push = (name: string, value: string, offset: number, code = false) => {
    const prop = PROPS[name]
    if (prop) found.push({ prop, value: clean(value), offset, code })
  }
  // CSS: a .css file, or a template string. The value runs to `;`, `}` or the string's end, across lines.
  for (const m of text.matchAll(new RegExp(`${CSS_PROP}\\s*:\\s*([^;{}\`]*)`, 'g'))) {
    // A style string in code (cssText, setAttribute('style', …), style="…") is CSS too; its value ends at the quote.
    if (ctx[m.index] === 'css') push(m[1], m[2], m.index)
    else if (ctx[m.index] === 'str') push(m[1], m[2].split(/['"]/)[0], m.index)
  }
  // SVG and HTML attributes in markup strings: font-size="11".
  for (const m of text.matchAll(/(?<![\w-])(font-size|font-family|letter-spacing|text-transform)\s*=\s*(\\?['"])(.*?)\2/g)) {
    if (ctx[m.index] !== 'code') push(m[1], m[3], m.index)
  }
  // JSX attributes: fontSize={11}.
  for (const m of text.matchAll(/(?<![\w-])(fontSize|fontFamily|letterSpacing)=\{([^}]*)\}/g)) {
    if (ctx[m.index] === 'code') push(m[1], m[2], m.index)
  }
  if (/\.tsx?$/.test(file)) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    type Scope = { parent?: Scope; variable: Scope; bindings: Map<string, ts.Expression | null> }
    const root = {} as Scope
    root.variable = root
    root.bindings = new Map()
    const scopeAt = new WeakMap<ts.Node, Scope>()
    const add = (scope: Scope, name: string, initializer: ts.Expression | null = null) => {
      scope.bindings.set(name, scope.bindings.has(name) ? null : initializer)
    }
    const names = (name: ts.BindingName, out: string[] = []): string[] => {
      if (ts.isIdentifier(name)) out.push(name.text)
      else for (const element of name.elements) if (ts.isBindingElement(element)) names(element.name, out)
      return out
    }
    const scoped = (node: ts.Node): boolean => ts.isSourceFile(node) || ts.isBlock(node) || ts.isFunctionLike(node)
      || ts.isModuleBlock(node) || ts.isClassLike(node) || ts.isCaseBlock(node) || ts.isCatchClause(node)
      || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)
    const collect = (node: ts.Node, parent: Scope): void => {
      const createsScope = scoped(node)
      const scope = createsScope ? { parent, variable: parent.variable, bindings: new Map<string, ts.Expression | null>() } : parent
      if (ts.isSourceFile(node) || ts.isFunctionLike(node)) scope.variable = scope
      scopeAt.set(node, scope)

      if (ts.isVariableDeclaration(node)) {
        const list = node.parent && ts.isVariableDeclarationList(node.parent) ? node.parent : undefined
        const isConst = !!list && (list.flags & ts.NodeFlags.Const) !== 0
        const isVar = !!list && (list.flags & ts.NodeFlags.BlockScoped) === 0
        const target = isVar ? scope.variable : scope
        for (const name of names(node.name)) add(target, name, isConst && ts.isIdentifier(node.name) ? node.initializer ?? null : null)
      } else if (ts.isParameter(node)) {
        const literal = node.type && ts.isLiteralTypeNode(node.type) && ts.isStringLiteral(node.type.literal) ? node.type.literal : null
        for (const name of names(node.name)) add(scope, name, ts.isIdentifier(node.name) ? literal : null)
      } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)
        || ts.isModuleDeclaration(node)) && node.name) add(parent, node.name.text)
      else if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) add(scope, node.name.text)
      else if (ts.isImportClause(node) && node.name) add(scope, node.name.text)
      else if (ts.isImportSpecifier(node)) add(scope, node.name.text)
      else if (ts.isNamespaceImport(node)) add(scope, node.name.text)
      else if (ts.isImportEqualsDeclaration(node)) add(scope, node.name.text)

      ts.forEachChild(node, child => collect(child, scope))
    }
    collect(sf, root)

    const unwrap = (node: ts.Expression): ts.Expression => {
      while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
        || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression
      return node
    }
    const staticString = (expression: ts.Expression, seen = new Set<ts.Expression>()): string | undefined => {
      const node = unwrap(expression)
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
      if (ts.isIdentifier(node)) {
        let scope = scopeAt.get(node)
        while (scope) {
          if (scope.bindings.has(node.text)) {
            const initializer = scope.bindings.get(node.text)
            if (initializer && !seen.has(initializer)) {
              seen.add(initializer)
              return staticString(initializer, seen)
            }
            return undefined
          }
          scope = scope.parent
        }
      }
      return undefined
    }
    const key = (node: ts.PropertyName | ts.Expression): string | undefined => {
      if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text
      if (ts.isComputedPropertyName(node)) return staticString(node.expression)
      if (ts.isElementAccessExpression(node) && node.argumentExpression) return staticString(node.argumentExpression)
      return undefined
    }
    const value = (node: ts.Expression): string => staticString(node) ?? node.getText(sf)
    const computedFontRead = (node: ts.Expression): boolean => ts.isPropertyAccessExpression(node)
      && node.name.text === 'font' && ts.isCallExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'getComputedStyle'
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent) && ctx[node.parent.getStart(sf)] === 'code') {
        const name = key(node.name)
        if (name && PROPS[name]) push(name, value(node.initializer), node.name.getStart(sf), true)
      } else if (ts.isShorthandPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent) && ctx[node.parent.getStart(sf)] === 'code') {
        const name = node.name.text
        if (PROPS[name]) push(name, value(node.name), node.name.getStart(sf), true)
      } else if (ts.isJsxAttribute(node) && node.initializer && ts.isJsxExpression(node.initializer)
        && node.initializer.expression && ctx[node.getStart(sf)] === 'code') {
        const name = node.name.getText(sf)
        if (PROPS[name]) push(name, value(node.initializer.expression), node.name.getStart(sf), true)
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = node.left
        const name = ts.isPropertyAccessExpression(left) ? left.name.text
          : ts.isElementAccessExpression(left) && left.argumentExpression ? key(left) : undefined
        if (name && PROPS[name] && ctx[left.getStart(sf)] === 'code'
          && !(PROPS[name] === 'font' && computedFontRead(node.right))) {
          push(name, value(node.right), left.getStart(sf), true)
        }
      } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text
        const index = method === 'setAttributeNS' ? 1 : 0
        const nameArg = node.arguments[index]
        const valueArg = node.arguments[index + 1]
        if (['setProperty', 'setAttribute', 'setAttributeNS'].includes(method) && nameArg && valueArg && ctx[node.getStart(sf)] === 'code') {
          const name = staticString(nameArg)
          if (name && PROPS[name] && !(PROPS[name] === 'font' && computedFontRead(valueArg))) push(name, value(valueArg), nameArg.getStart(sf), true)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
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

/** Splits a selector list without splitting commas inside functional selectors or attributes. */
function selectorList(selector: string): string[] {
  const parts: string[] = []
  let start = 0, round = 0, square = 0, quote = ''
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '(') round++
    else if (c === ')') round--
    else if (c === '[') square++
    else if (c === ']') square--
    else if (c === ',' && round === 0 && square === 0) { parts.push(selector.slice(start, i).trim()); start = i + 1 }
  }
  parts.push(selector.slice(start).trim())
  return parts.filter(Boolean)
}

/** A rule exempts only selectors whose actual target is a named pseudo-element. */
function markSelector(selector: string): boolean {
  const names = [...MARK_PSEUDO_ELEMENTS].join('|')
  const pseudo = new RegExp(`::?(${names})\\s*$`)
  const selectors = selectorList(selector)
  return selectors.length > 0 && selectors.every(part => pseudo.test(part))
}

function violations(file: string, source: string, defined: Set<string>): string[] {
  const found: string[] = []
  const { text, ctx } = scan(source, file.endsWith('.css'))
  const at = (offset: number, what: string) => found.push(`${file}:${lineOf(text, offset)}  ${what}`)

  for (const d of declarations(text, ctx, file)) {
    let why = judge(d.prop, d.value)
    if (d.code && ((d.prop === 'leading' && BOX.test(d.value))
      || (d.prop === 'font' && !!shorthand(d.value).leading && BOX.test(shorthand(d.value).leading!)))) why = 'raw leading'
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

  const all = blocks(text, ctx)
  const kickers = new Set(all.filter(b => /all-small-caps/.test(b.body)).map(b => b.selector))
  for (const b of all) {
    const own = declarations(b.body, b.body.split('').map(() => 'css' as Ctx))
    const get = (prop: Prop) => own.filter(d => d.prop === prop)
    const fonts = get('font').map(d => shorthand(d.value))
    const sizes = [...get('size').map(d => d.value), ...fonts.flatMap(f => f.size ? [f.size] : [])]
    const leadings = [...get('leading').map(d => d.value), ...fonts.flatMap(f => f.leading ? [f.leading] : [])]
    const caps = [...get('caps').map(d => d.value), ...fonts.flatMap(f => f.caps ? [f.caps] : [])]

    // A glyph token sizes a mark, never text.
    if (sizes.some(s => GLYPH.test(s)) && !markSelector(b.selector) && !GLYPH_TEXT_SELECTORS.has(b.selector)) at(b.offset, `glyph token on text: ${b.selector}`)

    // A line box from geometry is for a box: a mark, or one line that cannot wrap.
    const nowrap = /white-space\s*:\s*(nowrap|pre)(?![\w-])/.test(b.body)
    const empty = /content\s*:\s*(''|"")/.test(b.body)
    if (leadings.some(l => BOX.test(l)) && !nowrap && !empty && !markSelector(b.selector)) {
      at(b.offset, `box line-height on wrapping text, use a leading role: ${b.selector}`)
    }

    // The kicker is all-small-caps at its tracking token, never at meta size (its caps render near 8px).
    // Tracking belongs to the caps: a tracking token only beside all-small-caps, never on mono.
    const families = [...get('family').map(d => d.value), ...fonts.flatMap(f => f.family ? [f.family] : [])]
    const tracked = get('track').some(d => TRACK.test(d.value))
    if (tracked && !caps.some(c => /all-small-caps/.test(c))) at(b.offset, `tracking without the kicker's caps: ${b.selector}`)
    if (tracked && families.some(f => /--font-mono/.test(f))) at(b.offset, `tracking on mono: ${b.selector}`)
    if (get('track').some(d => d.value === 'var(--track-nav)') && !sizes.includes('var(--type-title)')) at(b.offset, `nav tracking off the nav size: ${b.selector}`)
    // The cascade can split a kicker across rules: meta size on a selector some other rule here sets as a kicker.
    if (sizes.includes('var(--type-meta)') && kickers.has(b.selector)) at(b.offset, `kicker at meta size: ${b.selector}`)
    if (caps.some(c => /all-small-caps/.test(c))) {
      if (!get('track').some(d => TRACK.test(d.value))) at(b.offset, `kicker without its tracking token: ${b.selector}`)
      if (sizes.includes('var(--type-meta)')) at(b.offset, `kicker at meta size: ${b.selector}`)
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
}, 30_000)

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
  ['x.ts', "const s = { lineHeight: '24px' }"],
  ['x.ts', "const SIZE_PX = '12px'; const s = { fontSize: SIZE_PX }"],
  ['x.ts', "const FONT_SIZE = 'fontSize'; const s = { [FONT_SIZE]: 12 }"],
  ['x.ts', "const FONT_SIZE = 'fontSize'; el.style[FONT_SIZE] = '12px'"],
  ['x.ts', "const KEY = 'font-size'; el.style.setProperty(KEY, '12px')"],
  ['x.ts', "const KEY = 'fontSize'; el.style.setProperty(KEY, '12px')"],
  ['x.ts', "const SIZE = 'var(--type-note)'; function style(SIZE: string) { return { fontSize: SIZE } }"],
  ['x.ts', "const KEY = 'color'; function style(KEY: 'fontSize') { return { [KEY]: '12px' } }"],
  ['x.ts', "const KEY = 'fontSize'; function one() { return { [KEY]: '12px' } } function two() { const KEY = 'color'; return { [KEY]: 'x' } }"],
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
  ['x.ts', "const css = `.u { content: '/*'; font-size: 13px; }`"],
  ['x.ts', "const re = /`/g\nconst css = `.v { font-size: 13px; }`"],
  ['x.css', '.w { font-feature-settings: "smcp", "c2sc"; }'],
  ['x.css', '.x { font-variant-caps: all-small-caps; font-feature-settings: "pcap"; letter-spacing: var(--track-kicker); font-size: var(--type-note); }'],
  ['x.css', '.y { font-variant-caps: petite-caps; }'],
  ['x.css', '.z { font-variant-caps: unicase; }'],
  ['x.ts', "el.style.fontFeatureSettings = '\"smcp\"'"],
  ['x.css', '.aa { letter-spacing: var(--track-kicker); font-size: var(--type-note); }'],
  ['x.css', '.ab { font: var(--type-note)/var(--leading-ui) var(--font-mono); font-variant-caps: all-small-caps; letter-spacing: var(--track-kicker); }'],
  ['x.ts', "el.style.cssText = 'color: red; font-size: 13px'"],
  ['x.ts', "el.setAttribute('style', 'letter-spacing: .1em')"],
  ['x.ts', "const html = '<span style=\"font-family: Menlo\">a</span>'"],
  ['x.ts', 'el.style.fontSize = getComputedStyle(other).fontSize'],
  ['x.ts', "ruler.font = getComputedStyle(message).font + ' 12px'"],
  ['x.css', '.ac { font-size: var(--type-prose); line-height: 24px; white-space: pre-wrap; }'],
  ['x.css', '.markdown p { font-size: var(--type-prose); line-height: 24px; }'],
  ['x.css', '.ws-bookmark-title { font-size: var(--glyph-small); }'],
  ['x.css', '.ws-icon-label { font-size: var(--glyph-small); }'],
  ['x.css', '.ws-rail-chevron { font-size: var(--glyph-small); }'],
  ['x.css', '.ornament::before, .label { font-size: var(--glyph-small); }'],
  ['x.css', '.kbn-cap, .kbn-cap::before { font-size: var(--glyph-small); }'],
  ['x.ts', "const s = { ['letterSpacing']: '.1em' }"],
  ['x.css', '.ad { font-size: var(--type-note); font-variant-caps: all-small-caps; letter-spacing: var(--track-kicker); }\n.ad { font-size: var(--type-meta); }'],
  ['x.css', '.ae { font-size: var(--type-note); font-variant-caps: all-small-caps; letter-spacing: var(--track-nav); }'],
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
  ['x.ts', 'ruler.font = getComputedStyle(message).font'],
  ['x.css', '.ws-col-count { font: var(--type-meta)/var(--leading-ui) var(--font-mono); }'],
  ['x.ts', "const SIZE = 'var(--type-note)'; const s = { fontSize: SIZE }"],
  ['x.ts', "const KEY = 'fontSize'; function style() { const KEY = 'color'; return { [KEY]: '12px' } }"],
  ['x.ts', "const KEY = 'fontSize'; el.style.setProperty(KEY, 'var(--type-note)')"],
  ['x.css', '.ok { font-feature-settings: "onum"; }'],
  ['x.ts', "el.style.cssText = 'color: red; font-size: var(--type-note)'"],
  ['x.css', '.ok { letter-spacing: 0px; }'],
  ['x.css', '.ws-rail-chevron::before { font-size: var(--glyph-small); }'],
  ['x.css', '.decoration::before, .decoration::after { font-size: var(--glyph-small); }'],
  ['x.css', '.ok { font-size: var(--type-title); font-variant-caps: all-small-caps; letter-spacing: var(--track-nav); }'],
]

const PROBE_TOKENS = new Set(['--type-row', '--type-label', '--type-note', '--type-meta', '--type-prose', '--leading-ui', '--leading-prose',
  '--font-serif', '--font-mono', '--glyph-small', '--glyph-initial', '--track-kicker', '--track-nav', '--type-title'])
it.each(MUST_FAIL)('the type scan rejects off-system form #%#', (file, source) => {
  expect(violations(file, source, PROBE_TOKENS), `${file}: ${source}`).not.toEqual([])
})
it.each(MUST_PASS)('the type scan accepts role form #%#', (file, source) => {
  expect(violations(file, source, PROBE_TOKENS), `${file}: ${source}`).toEqual([])
})

it('only styles/type.css defines the type tokens', () => {
  const define = /(?<![\w-])--(type|leading|font|glyph|rhythm|track)-[a-z-]+\s*:|setProperty\(\s*['"`]--(type|leading|font|glyph|rhythm|track)-/
  const found = files(SRC).flatMap((path) => {
    const file = relative(SRC, path)
    if (file === OWNER) return []
    return readFileSync(path, 'utf8').split('\n').flatMap((line, i) => define.test(line) ? [`${file}:${i + 1}  ${line.trim()}`] : [])
  })
  expect(found, `type tokens redefined outside ${OWNER}:\n${found.join('\n')}`).toEqual([])
})
