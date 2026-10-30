// Every text the board draws takes its size and family from src/styles/type.css.
//
// The type file names eight size roles, their leadings and two families. A
// `font-size`, `font-family`, `line-height` or `font` shorthand anywhere else
// in ui/src (CSS, or a style string or object in TypeScript) may only name
// those tokens (or inherit). A raw px, rem, em, %, calc(), unitless leading or
// family name is a parallel scale in waiting, and this scan fails on it,
// naming file:line. A line-height in px is a box's height, not type: it is
// layout, and passes.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { expect, it } from 'vitest'

const SRC = resolve('src')
const OWNER = 'styles/type.css'

/** Files left as they are, with the reason. */
const EXEMPT: Record<string, string> = {}

const SIZE = /^var\(--(type|glyph)-[a-z-]+\)$/
const FAMILY = /^var\(--font-(serif|mono|initials|initials-frill)\)$/
const LEADING = /^var\(--leading-[a-z]+\)$/
const BOX = /^(\d+(\.\d+)?px|calc\(.*var\(--.*\)|var\(--[a-z-]+-(h|height|target)\)|normal)$/
const KEYWORD = /^(inherit|unset|initial)$/

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path)
    return /\.(css|tsx?)$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [path] : []
  })
}

/** Splits a `font` shorthand into its size and family; style, variant and weight may lead. */
function shorthand(value: string): { size?: string; leading?: string; family?: string } {
  const tokens = value.split(/\s+/)
  while (tokens.length && /^(italic|oblique|normal|small-caps|bold|bolder|lighter|\d00)$/.test(tokens[0])) tokens.shift()
  const [size, ...family] = tokens
  const [head, leading] = (size ?? '').split('/')
  return { size: head || undefined, leading, family: family.join(' ') || undefined }
}

function violations(file: string, text: string): string[] {
  const found: string[] = []
  // Comments say what a rule does; they are not rules. Blank them, keeping lines.
  const lines = text.replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' ')).split('\n')
  // CSS declarations (also inside TS template strings) and JS style objects.
  const decl = /(?<![\w-])(font-size|font-family|font|line-height|fontSize|fontFamily|lineHeight)\s*:\s*('[^']*'|"[^"]*"|[^;\n}]+)|\.(fontSize|fontFamily|lineHeight)\s*=\s*('[^']*'|"[^"]*"|[^;\n]+)/g
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
    for (const m of line.matchAll(decl)) {
      const prop = m[1] ?? m[3]
      const quoted = (m[2] ?? m[4]).match(/^\s*(['"])(.*?)\1/)
      let value = (quoted ? quoted[2] : (m[2] ?? m[4])).replace(/!important/, '').trim().replace(/[,'"`]+$/g, '').replace(/^['"`]/, '').trim()
      if (prop === 'font') {
        if (KEYWORD.test(value) || value.startsWith('var(--font-')) continue
        const { size, leading, family } = shorthand(value)
        if (size && !SIZE.test(size)) found.push(`${file}:${i + 1}  font: ${value}`)
        else if (leading && !LEADING.test(leading) && !BOX.test(leading)) found.push(`${file}:${i + 1}  font: ${value}`)
        else if (family && !FAMILY.test(family)) found.push(`${file}:${i + 1}  font: ${value}`)
        continue
      }
      const ok = /size/i.test(prop) ? SIZE.test(value)
        : /height/i.test(prop) ? LEADING.test(value) || BOX.test(value)
        : FAMILY.test(value)
      if (!ok && !KEYWORD.test(value)) found.push(`${file}:${i + 1}  ${prop}: ${value}`)
    }
  })
  return found
}

it('every font size, leading and family names a role from styles/type.css', () => {
  const found = files(SRC).flatMap((path) => {
    const file = relative(SRC, path)
    if (file === OWNER || Object.keys(EXEMPT).some(prefix => file.startsWith(prefix))) return []
    return violations(file, readFileSync(path, 'utf8'))
  })
  expect(found, `raw type outside ${OWNER}:\n${found.join('\n')}`).toEqual([])
})

it('the scan catches the shapes it guards', () => {
  const sample = [
    '.a { font-size: 13px; }',
    '.b { font-size: calc(11px * var(--kbn-type-scale, 1)); }',
    '.c { font-family: var(--ws-mono); }',
    '.d { font: italic 12px/1.4 var(--font-serif); }',
    "el.style.fontSize = '0.9em'",
    "{ fontFamily: 'var(--font-main, serif)' }",
    '.e { font: var(--type-label)/1.4 var(--font-serif); }',
    '.f { line-height: 1.5; }',
    "{ lineHeight: 1.2 }",
    '.ok { font-size: var(--type-row); font-family: var(--font-serif); line-height: var(--leading-ui); }',
    '.ok2 { font: italic 500 var(--type-label)/var(--leading-prose) var(--font-serif); }',
    '.ok4 { line-height: 24px; }',
    '.ok3 { font: inherit; }',
    '.g { line-height: calc(1.5); }',
  ].join('\n')
  expect(violations('x.css', sample).map(v => v.split('  ')[0].split(':')[1])).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '14'])
})

it('only styles/type.css defines the type tokens', () => {
  const define = /(?<![\w-])--(type|leading|font|glyph|rhythm)-[a-z-]+\s*:/
  const found = files(SRC).flatMap((path) => {
    const file = relative(SRC, path)
    if (file === OWNER) return []
    return readFileSync(path, 'utf8').split('\n').flatMap((line, i) => define.test(line) ? [`${file}:${i + 1}  ${line.trim()}`] : [])
  })
  expect(found, `type tokens redefined outside ${OWNER}:\n${found.join('\n')}`).toEqual([])
})
