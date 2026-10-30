// Every zone the board reads goes through civilDay.ts.
//
// civilDay.ts is the one module that knows a time zone: it takes the zone as a
// parameter (defaulting to the host's), which is what lets its properties ask
// every zone in one run. A `Date` local-zone getter, setter or multi-argument
// constructor anywhere else reads the process's zone behind that parameter's
// back — and passes every test run in the one zone `npm test` pins. This scan
// fails, naming file:line, on any such read outside civilDay.ts.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

const SRC = resolve('src')

/** The one module allowed to read local time. */
const OWNER = 'board/civilDay.ts'

/** Directories left as they are, with the reason. */
const EXEMPT: Record<string, string> = {
  'board/workspace/': 'being rewritten by another team; it moves onto civilDay.ts as part of that rewrite',
}

/** `Date` methods that read or write the local zone's wall clock. A bare
 *  `toString` is too common a name to flag on its own; it is caught on a
 *  `new Date(…)` receiver below. */
const LOCAL_METHODS = new Set([
  'getFullYear', 'getYear', 'getMonth', 'getDate', 'getDay', 'getHours', 'getMinutes', 'getSeconds',
  'setFullYear', 'setYear', 'setMonth', 'setDate', 'setHours', 'setMinutes', 'setSeconds',
  'getTimezoneOffset', 'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString',
  'toDateString', 'toTimeString',
])

function isNewDate(node: ts.Node): node is ts.NewExpression {
  return ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Date'
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [path] : []
  })
}

/** Every local-zone read in a source file, as `file:line  what`. */
function localZoneReads(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const report = (node: ts.Node, what: string) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    found.push(`${file}:${line + 1}  ${what}`)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text
      if (LOCAL_METHODS.has(name)) report(node, `.${name}`)
      if (name === 'DateTimeFormat' && ts.isIdentifier(node.expression) && node.expression.text === 'Intl') {
        report(node, 'Intl.DateTimeFormat')
      }
    }
    if (isNewDate(node)) {
      if ((node.arguments?.length ?? 0) >= 2) report(node, 'new Date(y, m, …) — a local-zone constructor')
      // A Date said as a string is said in the local zone.
      const parent = node.parent
      const stringified =
        (ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === 'toString')
        || ts.isTemplateSpan(parent)
        || (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === 'String')
      if (stringified) report(node, 'a Date as a string — local-zone text')
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Date') {
      report(node, 'Date() — the local-zone time as a string')
    }
    // `const { getHours } = Date.prototype`, `const { DateTimeFormat } = Intl`.
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      const from = node.initializer.getText(sf)
      if (from === 'Date.prototype' || from === 'Intl') report(node, `destructured from ${from}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

it('reads the local zone only through civilDay.ts', () => {
  const reads = sources(SRC).flatMap((path) => {
    const file = relative(SRC, path).split('\\').join('/')
    if (file === OWNER || Object.keys(EXEMPT).some((dir) => file.startsWith(dir))) return []
    return localZoneReads(file, readFileSync(path, 'utf8'))
  })
  expect(reads, 'route these through a civilDay.ts helper that takes a Zone').toEqual([])
})

/** A clock or relative age formatted by hand: the forms only civilDay.ts may write. */
function clockFormats(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    const clock = ts.isPropertyAccessExpression(node) && /^(toLocaleTimeString|getHours|getMinutes)$/.test(node.name.text)
    const hour = ts.isPropertyAssignment(node) && /^(hour|minute|hour12|timeStyle)$/.test(node.name.getText(sf))
    const relative = (ts.isTemplateExpression(node) && node.templateSpans.some(span => /^\s*(s|m|h|d|mo|w)\s+ago\b/.test(span.literal.text)))
      || (ts.isStringLiteral(node) && /^\s*(s|m|h|d|mo|w)\s+ago\b/.test(node.text))
    if (clock || hour || relative) found.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`)
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

it('formats clocks and relative ages only in civilDay.ts', () => {
  const violations = sources(SRC).flatMap((path) => {
    const file = relative(SRC, path).split('\\').join('/')
    if (file === OWNER) return []
    return clockFormats(file, readFileSync(path, 'utf8'))
  })
  expect(violations).toEqual([])
})

it('sees the clock formats it exists to catch', () => {
  const mustFail = [
    'const t = new Date(ms).toLocaleTimeString()',
    "const o = { hour: '2-digit', minute: '2-digit' }",
    "const o = { hour: 'numeric' }",
    'const t = `${d.getHours()}:${m}`',
    'const a = `${n}m ago`',
    'const a = `${n}h ago`',
    'const a = `${n}d ago`',
    'const a = n + \'s ago\'',
  ]
  expect(mustFail.filter(src => clockFormats('x.ts', src).length === 0)).toEqual([])
  expect(clockFormats('x.ts', "const word = 'a while ago'; const u = d.getUTCHours()")).toEqual([])
})

it('sees the reads it exists to catch', () => {
  // The scan's own canary: each of these must be found, and comments, strings
  // and UTC getters must not be.
  const probe = [
    'const a = new Date(ms).getHours()',
    'd.setDate(d.getDate() + 1)',
    'const b = new Date(2026, 6, 15)',
    'x.toLocaleDateString(undefined, { month: "short" })',
    'const f = new Intl.DateTimeFormat()',
    '// d.getHours() in a comment',
    'const s = "d.getHours()"',
    'const u = new Date(ms).getUTCHours() + new Date(ms).getTime()',
    'const t = new Date(ms).toString()',
    'const now = Date()',
    'const { getHours } = Date.prototype',
    'const { DateTimeFormat } = Intl',
    'const v = `${new Date(ms)}` + String(new Date(ms))',
    'const ok = n.toString(36) + new Date(ms).toISOString() + (5).toString()',
  ].join('\n')
  expect(localZoneReads('probe.ts', probe).map((r) => r.split('  ')[0])).toEqual([
    'probe.ts:1', 'probe.ts:2', 'probe.ts:2', 'probe.ts:3', 'probe.ts:4', 'probe.ts:5',
    'probe.ts:9', 'probe.ts:10', 'probe.ts:11', 'probe.ts:12', 'probe.ts:13', 'probe.ts:13',
  ])
})
