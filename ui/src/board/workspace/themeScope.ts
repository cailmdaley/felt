/** CSSOM scopes selectors; only global font definitions and namespaced animations escape. */
export function scopeTheme(css: string, scope: string, namespace: string, defaults: ReadonlyMap<string, string> = new Map(), assetBase?: string): string {
  const sheet = new CSSStyleSheet()
  const imports = themeImports(css)
  sheet.replaceSync(imports.body)
  if (imports.body.trim() && !sheet.cssRules.length) throw new Error('No valid CSS rules')
  const names = new Map<string, string>()
  const fonts = new Map<string, string>()
  const collect = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if (rule.type === CSSRule.KEYFRAMES_RULE) {
        const keyframes = rule as CSSKeyframesRule
        names.set(keyframes.name, `${namespace}-${keyframes.name}`)
      } else if (rule.type === CSSRule.FONT_FACE_RULE) {
        const family = cssName((rule as CSSFontFaceRule).style.getPropertyValue('font-family'))
        if (family) fonts.set(family.toLowerCase(), `${namespace}-${family}`)
      } else if ('cssRules' in rule) collect((rule as CSSGroupingRule).cssRules)
    }
  }
  collect(sheet.cssRules)
  // Animation values can arrive through custom properties in another rule.
  const aliases = new Map<string, string[]>()
  const animationAliases = new Set<string>()
  const fontAliases = new Set(['--ws-serif', '--ws-mono', '--font-main', '--font-serif', '--font-mono'])
  const collectAliases = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if ('style' in rule) {
        const style = (rule as CSSStyleRule).style
        for (let i = 0; i < style.length; i++) {
          const property = style.item(i), value = style.getPropertyValue(property)
          if (property.startsWith('--')) aliases.set(property, [...(aliases.get(property) ?? []), value])
        }
        for (const property of ANIMATION_PROPERTIES) for (const name of variables(style.getPropertyValue(property))) animationAliases.add(name)
        for (const property of ['font', 'font-family']) for (const name of variables(style.getPropertyValue(property))) fontAliases.add(name)
      }
      if ('cssRules' in rule) collectAliases((rule as CSSGroupingRule).cssRules)
    }
  }
  collectAliases(sheet.cssRules)
  for (const name of animationAliases) for (const value of aliases.get(name) ?? []) for (const dependency of variables(value)) animationAliases.add(dependency)
  for (const name of fontAliases) for (const value of aliases.get(name) ?? []) for (const dependency of variables(value)) fontAliases.add(dependency)
  const declarations = (style: CSSStyleDeclaration): string => {
    // Font aliases may be consumed by the bundled skin or by other scoped rules.
    for (const property of Array.from({ length: style.length }, (_, i) => style.item(i))) {
      const original = style.getPropertyValue(property)
      if (!original) continue
      let value = original
      const safe = themeUrls(value, assetBase)
      if (safe === null) { style.removeProperty(property); continue }
      value = safe
      if (property === 'font' || property === 'font-family' || fontAliases.has(property)) value = fontNames(value, fonts)
      if (value !== original) style.setProperty(property, value, style.getPropertyPriority(property))
    }
    for (const property of [...ANIMATION_PROPERTIES, ...animationAliases]) {
      const value = style.getPropertyValue(property)
      if (value) style.setProperty(property, animationNames(value, names), style.getPropertyPriority(property))
    }
    // CSSOM retains var()-containing shorthands in cssText. Their expanded
    // longhand getters return empty strings until substitution at computed time.
    return style.cssText
  }
  const emit = (rules: CSSRuleList, scoped: boolean): string => Array.from(rules).map(rule => {
    if (rule.type === CSSRule.STYLE_RULE) {
      const style = rule as CSSStyleRule
      const nested = 'cssRules' in style ? emit(style.cssRules, false) : ''
      const text = `${style.selectorText} { ${declarations(style.style)} ${nested} }`
      // @scope uses the browser's selector parser, including :scope, selector lists,
      // nesting and functional pseudo-classes. No selector is rewritten as text.
      return scoped ? `@scope (${scope}) to ([data-part="act"], :scope [data-ws-theme], :scope [data-ws-theme-boundary]) { ${text} }` : text
    }
    if (rule.type === CSSRule.FONT_FACE_RULE) return `@font-face { ${declarations((rule as CSSFontFaceRule).style)} }`
    if (rule.type === CSSRule.KEYFRAMES_RULE) {
      const frames = rule as CSSKeyframesRule
      return `@keyframes ${CSS.escape(names.get(frames.name)!)} { ${Array.from(frames.cssRules).map(frame => `${(frame as CSSKeyframeRule).keyText} { ${declarations((frame as CSSKeyframeRule).style)} }`).join('\n')} }`
    }
    if ('cssRules' in rule && (rule.type === CSSRule.MEDIA_RULE || rule.type === CSSRule.SUPPORTS_RULE || rule.constructor.name === 'CSSLayerBlockRule')) {
      const group = rule as CSSGroupingRule
      return `${rule.cssText.slice(0, rule.cssText.indexOf('{'))} { ${emit(group.cssRules, scoped)} }`
    }
    // Nested declaration blocks retain properties written after nested selectors.
    if (!scoped && 'style' in rule) return declarations((rule as CSSStyleRule).style)
    // Layer order statements have no selectors or declarations to escape.
    if (rule.constructor.name === 'CSSLayerStatementRule') return rule.cssText
    console.info('Shuttle theme: omitted unsupported rule', rule.cssText)
    return ''
  }).join('\n')
  // Custom properties inherit independently of all: initial. Every channel,
  // including a Plain one, starts authored variables at the document defaults.
  const resetDeclarations = (names: string[]): string => names.map(name => `${CSS.escape(name)}: ${defaults.get(name)?.trim() || 'initial'};`).join('\n')
  // An earliest layer lets even layered :scope declarations beat the defaults.
  const reset = aliases.size ? `@layer shuttle-theme-defaults {
    :where([data-ws-theme-boundary]) { ${resetDeclarations([...aliases.keys()])} }
    :where([data-ws-theme] [data-part="act"]) { ${resetDeclarations([...aliases.keys()].filter(name => name !== '--ws-paper' && name !== '--ws-ink'))} }
  }` : ''
  return [imports.allowed.join('\n'), reset, emit(sheet.cssRules, true)].join('\n')
}

/** CSS escapes are decoded before either family matching or URL policy checks. */
function cssUnescape(value: string): string {
  return value.replace(/\\(?:([0-9a-f]{1,6})(?:\r\n|[ \t\n\r\f])?|([^\n\r\f])|(?:\r\n|[\n\r\f]))/gi, (_match, hex: string | undefined, char: string | undefined) => {
    if (!hex) return char ?? ''
    const code = parseInt(hex, 16)
    return code === 0 || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff ? '\ufffd' : String.fromCodePoint(code)
  })
}
function cssName(value: string): string {
  const text = value.trim()
  return cssUnescape(text[0] === '"' || text[0] === "'" ? text.slice(1, -1) : text.replace(/\s+/g, ' '))
}

/** Rewrite quoted and multi-word families, including font shorthands and aliases. */
function fontNames(value: string, names: Map<string, string>): string {
  let output = ''
  for (let i = 0; i < value.length;) {
    if (value[i] === '"' || value[i] === "'") {
      const end = quotedEnd(value, i), token = value.slice(i, end)
      output += names.has(cssName(token).toLowerCase()) ? JSON.stringify(names.get(cssName(token).toLowerCase())) : token
      i = end; continue
    }
    if (identifier(value[i]) || value[i] === '\\') {
      let end = i
      while (end < value.length && (identifier(value[end]) || value[end] === '\\')) end = value[end] === '\\' ? escapeEnd(value, end) : end + 1
      // Functions and their string arguments aren't font-family references.
      if (value[end] === '(' && cssUnescape(value.slice(i, end)).toLowerCase() !== 'var') {
        let depth = 1, close = end + 1
        for (; close < value.length && depth; close++) {
          if (value[close] === '"' || value[close] === "'") close = quotedEnd(value, close) - 1
          else if (value[close] === '(') depth++
          else if (value[close] === ')') depth--
        }
        output += value.slice(i, close); i = close; continue
      }
      let candidateEnd = end, matched: { end: number; name: string } | undefined
      for (;;) {
        const name = names.get(cssName(value.slice(i, candidateEnd)).toLowerCase())
        if (name) matched = { end: candidateEnd, name }
        let next = candidateEnd
        while (/\s/.test(value[next] ?? '') && next < value.length) next++
        if (next === candidateEnd || !value[next] || !identifier(value[next]) && value[next] !== '\\') break
        candidateEnd = next
        while (candidateEnd < value.length && (identifier(value[candidateEnd]) || value[candidateEnd] === '\\')) candidateEnd = value[candidateEnd] === '\\' ? escapeEnd(value, candidateEnd) : candidateEnd + 1
        if (value[candidateEnd] === '(') break
      }
      output += matched ? JSON.stringify(matched.name) : value.slice(i, end)
      i = matched?.end ?? end
    } else output += value[i++]
  }
  return output
}

/** A relative URL is resolved against the owning fiber, never the board's URL. */
function safeThemeUrl(raw: string, assetBase?: string): string | null {
  const value = cssName(raw)
  if (!value || /[\u0000-\u001f\u007f\\]/.test(value)) return null
  if (/^data:/i.test(value)) return value
  try {
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('/')
    if (absolute) {
      const url = new URL(value)
      return url.protocol === 'https:' && ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)
        && !url.username && !url.password && !url.port ? url.href : null
    }
    // Encoded separators and residual escapes cannot alter the daemon's path decoding.
    if (/%(?:2f|5c|25)/i.test(value)) return null
    const base = new URL(assetBase ?? 'https://theme.invalid/fiber/theme.css')
    const directory = new URL('.', base)
    const url = new URL(value, base)
    if (url.origin !== directory.origin || !url.pathname.startsWith(directory.pathname)) return null
    return assetBase ? url.href : value
  } catch { return null }
}
function themeUrls(value: string, assetBase?: string): string | null {
  let output = ''
  for (let i = 0; i < value.length;) {
    if (value[i] === '"' || value[i] === "'") {
      const end = quotedEnd(value, i); output += value.slice(i, end); i = end; continue
    }
    if (identifier(value[i]) || value[i] === '\\') {
      let end = i
      while (end < value.length && (identifier(value[end]) || value[end] === '\\')) end = value[end] === '\\' ? escapeEnd(value, end) : end + 1
      const name = cssUnescape(value.slice(i, end)).toLowerCase()
      // image-set accepts URL strings without url(); keep it out of the styling surface.
      if (value[end] === '(' && ['image-set', '-webkit-image-set'].includes(name)) {
        console.info('Shuttle theme: dropped image-set declaration'); return null
      }
      if (name !== 'url' || value[end] !== '(') { output += value.slice(i, end); i = end; continue }
      let close = end + 1
      for (; close < value.length; close++) {
        if (value[close] === '"' || value[close] === "'") close = quotedEnd(value, close) - 1
        else if (value[close] === '\\') close = escapeEnd(value, close) - 1
        else if (value[close] === ')') break
      }
      const url = close < value.length ? safeThemeUrl(value.slice(end + 1, close), assetBase) : null
      if (url === null) { console.info('Shuttle theme: dropped URL outside the fiber folder or Google Fonts', value); return null }
      output += `url(${JSON.stringify(url)})`; i = close + 1
    } else output += value[i++]
  }
  return output
}

const ANIMATION_PROPERTIES = ['animation', 'animation-name', '-webkit-animation', '-webkit-animation-name']
function variables(value: string): string[] {
  const names: string[] = []
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '"' || value[i] === "'") { i = quotedEnd(value, i) - 1; continue }
    if (value.slice(i, i + 4).toLowerCase() !== 'var(') continue
    let start = i + 4
    while (value[start] === ' ' || value[start] === '\n' || value[start] === '\t') start++
    let end = start
    while (end < value.length && identifier(value[end])) end++
    if (value.slice(start, end).startsWith('--')) names.push(value.slice(start, end))
  }
  return names
}

/** Rewrite whole animation-name tokens, including var() fallbacks, never timing-function arguments. */
function animationNames(value: string, names: Map<string, string>): string {
  let output = '', functionName = ''
  const functions: Array<{ name: string; fallback: boolean }> = []
  const reference = (): boolean => functions.every(fn => fn.name === 'var' && fn.fallback)
  for (let i = 0; i < value.length;) {
    const c = value[i]
    if (c === '(') functions.push({ name: functionName.toLowerCase(), fallback: false })
    if (c === ')') functions.pop()
    if (c === ',' && functions.at(-1)?.name === 'var') functions.at(-1)!.fallback = true
    if (c === '"' || c === "'") {
      const end = quotedEnd(value, i)
      const token = value.slice(i, end)
      const name = keyframeName(token)
      output += reference() && names.has(name) ? CSS.escape(names.get(name)!) : token
      i = end
    } else if (identifier(c) || c === '\\') {
      let end = i
      while (end < value.length && (identifier(value[end]) || value[end] === '\\')) end = value[end] === '\\' ? escapeEnd(value, end) : end + 1
      const token = value.slice(i, end)
      const name = token.includes('\\') ? keyframeName(token) : token
      output += reference() && value[end] !== '(' && names.has(name) ? CSS.escape(names.get(name)!) : token
      functionName = name
      i = end
    } else { output += c; i++ }
  }
  return output
}
/** CSSOM gives escaped identifiers and strings the same identity as their declarations. */
function keyframeName(token: string): string {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(`@keyframes ${token} {}`)
  return (sheet.cssRules[0] as CSSKeyframesRule | undefined)?.name ?? token
}
function escapeEnd(value: string, start: number): number {
  let end = start + 1
  while (end < value.length && end < start + 7 && '0123456789abcdef'.includes(value[end].toLowerCase())) end++
  if (end === start + 1) return Math.min(value.length, end + 1)
  if (' \t\n\r\f'.includes(value[end] ?? '_')) {
    if (value[end] === '\r' && value[end + 1] === '\n') end++
    end++
  }
  return end
}
function identifier(c: string): boolean {
  const code = c.charCodeAt(0)
  return code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || c === '-' || c === '_' || code >= 128
}
function quotedEnd(value: string, start: number): number {
  for (let i = start + 1; i < value.length; i++) {
    if (value[i] === '\\') i++
    else if (value[i] === value[start]) return i + 1
  }
  return value.length
}

/** replaceSync discards imports. Read their top-level statements before parsing. */
function themeImports(css: string): { body: string; allowed: string[] } {
  let body = '', depth = 0
  const allowed: string[] = []
  for (let i = 0; i < css.length;) {
    if (css[i] === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2)
      const end = close < 0 ? css.length : close + 2
      body += css.slice(i, end); i = end; continue
    }
    if (css[i] === '"' || css[i] === "'") {
      const end = quotedEnd(css, i)
      body += css.slice(i, end); i = end; continue
    }
    if (depth === 0 && css.slice(i, i + 7).toLowerCase() === '@import' && !identifier(css[i + 7] ?? ' ')) {
      let end = i + 7, parentheses = 0
      for (; end < css.length; end++) {
        if (css[end] === '"' || css[end] === "'") end = quotedEnd(css, end) - 1
        else if (css[end] === '(') parentheses++
        else if (css[end] === ')') parentheses--
        else if (css[end] === ';' && parentheses === 0) { end++; break }
      }
      const statement = css.slice(i, end)
      let target = statement.slice(7).trim()
      const functional = target.toLowerCase().startsWith('url(')
      if (functional) target = target.slice(4).trim()
      const quoted = target[0] === '"' || target[0] === "'"
      const urlEnd = quoted ? quotedEnd(target, 0) : target.indexOf(')')
      const url = quoted ? target.slice(1, urlEnd - 1) : target.slice(0, urlEnd)
      const modifiers = target.slice(urlEnd + (quoted ? 0 : 1)).trim().replace(/^\)\s*/, '').replace(/;$/, '').trim()
      try {
        const parsed = new URL(cssUnescape(url))
        if (parsed.protocol === 'https:' && parsed.hostname === 'fonts.googleapis.com' && !parsed.username && !parsed.password && !parsed.port) {
          // Emit the validated URL, never the authored spelling decoded by the browser.
          allowed.push(`@import url(${JSON.stringify(parsed.href)})${modifiers ? ` ${modifiers}` : ''};`)
        } else console.info('Shuttle theme: dropped @import (only Google Fonts is allowed)', statement)
      } catch { console.info('Shuttle theme: dropped invalid @import', statement) }
      i = end; continue
    }
    if (css[i] === '{') depth++
    if (css[i] === '}') depth--
    body += css[i++]
  }
  return { body, allowed }
}
