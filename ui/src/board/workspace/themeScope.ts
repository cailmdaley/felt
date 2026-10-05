/** CSSOM scopes selectors; only global font definitions and namespaced animations escape. */
export function scopeTheme(css: string, scope: string, namespace: string): string {
  const sheet = new CSSStyleSheet()
  const imports = themeImports(css)
  sheet.replaceSync(imports.body)
  if (imports.body.trim() && !sheet.cssRules.length) throw new Error('No valid CSS rules')
  const names = new Map<string, string>()
  const collect = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if (rule.type === CSSRule.KEYFRAMES_RULE) {
        const keyframes = rule as CSSKeyframesRule
        names.set(keyframes.name, `${namespace}-${keyframes.name}`)
      } else if ('cssRules' in rule) collect((rule as CSSGroupingRule).cssRules)
    }
  }
  collect(sheet.cssRules)
  // Animation values can arrive through custom properties in another rule.
  const aliases = new Map<string, string[]>()
  const animationAliases = new Set<string>()
  const collectAliases = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if ('style' in rule) {
        const style = (rule as CSSStyleRule).style
        for (let i = 0; i < style.length; i++) {
          const property = style.item(i), value = style.getPropertyValue(property)
          if (property.startsWith('--')) aliases.set(property, [...(aliases.get(property) ?? []), value])
        }
        for (const property of ANIMATION_PROPERTIES) for (const name of variables(style.getPropertyValue(property))) animationAliases.add(name)
      }
      if ('cssRules' in rule) collectAliases((rule as CSSGroupingRule).cssRules)
    }
  }
  collectAliases(sheet.cssRules)
  for (const name of animationAliases) for (const value of aliases.get(name) ?? []) for (const dependency of variables(value)) animationAliases.add(dependency)
  const declarations = (style: CSSStyleDeclaration): string => {
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
      return scoped ? `@scope (${scope}) to ([data-part="act"], :scope [data-ws-theme]) { ${text} }` : text
    }
    if (rule.type === CSSRule.FONT_FACE_RULE) return rule.cssText
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
  return imports.allowed.join('\n') + '\n' + emit(sheet.cssRules, true)
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
      const name = value.slice(i + 1, end - 1)
      output += reference() && names.has(name) ? `${c}${names.get(name)}${c}` : value.slice(i, end)
      i = end
    } else if (identifier(c)) {
      let end = i + 1
      while (end < value.length && identifier(value[end])) end++
      const token = value.slice(i, end)
      output += reference() && value[end] !== '(' && names.has(token) ? CSS.escape(names.get(token)!) : token
      functionName = token
      i = end
    } else { output += c; i++ }
  }
  return output
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
      let end = i + 7
      for (; end < css.length; end++) {
        if (css[end] === '"' || css[end] === "'") end = quotedEnd(css, end) - 1
        else if (css[end] === ';') { end++; break }
      }
      const statement = css.slice(i, end)
      let target = statement.slice(7).trim()
      if (target.toLowerCase().startsWith('url(')) target = target.slice(4).trim()
      const url = target[0] === '"' || target[0] === "'" ? target.slice(1, quotedEnd(target, 0) - 1) : target.slice(0, target.indexOf(')'))
      try {
        const parsed = new URL(url)
        if (parsed.protocol === 'https:' && parsed.hostname === 'fonts.googleapis.com' && !parsed.username && !parsed.password) allowed.push(statement)
        else console.info('Shuttle theme: dropped @import (only Google Fonts is allowed)', statement)
      } catch { console.info('Shuttle theme: dropped invalid @import', statement) }
      i = end; continue
    }
    if (css[i] === '{') depth++
    if (css[i] === '}') depth--
    body += css[i++]
  }
  return { body, allowed }
}
