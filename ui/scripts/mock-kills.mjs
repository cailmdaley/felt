#!/usr/bin/env node
/**
 * Which board tests that assert on mock calls kill mutants no other test kills.
 *
 *   node scripts/mock-kills.mjs classify > classes.json
 *   node scripts/mock-kills.mjs recheck <bail.json> classes.json <stryker-config> <out-config>
 *   node scripts/mock-kills.mjs report classes.json <report.json>... [--json out.json]
 *
 * `classify` reads every test file's syntax tree and marks each case M when its
 * body asserts on calls (`toHaveBeenCalled*`, `.mock.calls`, a `.calls` recorder
 * inside `expect`), R otherwise, recording whether the file mocks one of the
 * board's own modules (`vi.mock('./…')`) or stubs a boundary (`fetch`).
 *
 * Recording every killer of every mutant (`disableBail`) over the board is days
 * of work, so the measurement runs twice. A bailing run (`stryker.board.config.json`)
 * settles every mutant whose first killer is an R test. `recheck` writes a config
 * for the lines of the rest (first killed by an M test, or timed out) with bail
 * off, and `report` reads those reports: the mutants only M tests kill, each M
 * test's share of them, and the candidates, M tests with none. A timeout names no
 * killer, so it is credited to every test covering it. A runtime title the
 * classifier cannot match counts as M and is never a candidate, so classify the
 * tree the runs measured. Keep one recheck run: Stryker mutates only mutants
 * wholly inside a range, so splitting its ranges across runs loses those that
 * span the split.
 *
 * A candidate's kills are all shared; that is not a verdict. A test that pins an
 * absence, state across calls, an argument passed through, or behaviour in a file
 * left unmutated kills nothing unique by construction. Read before you cut.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const ui = dirname(dirname(fileURLToPath(import.meta.url)))
const [command, ...args] = process.argv.slice(2)
const read = (path) => JSON.parse(readFileSync(path, 'utf8'))

const CALLS = /toHaveBeen(Last|Nth)?Called|toHaveReturned|\.mock\.(calls|lastCall|results|invocationCallOrder)/
const RECORDER = /expect\([^)]*\.calls\b/
const BOUNDARY = /stubGlobal\(\s*['"](fetch|EventSource|WebSocket)|spyOn\((globalThis|window),\s*['"]fetch|(globalThis|window)\.fetch\s*=/

function classify() {
  const ts = createRequire(`${ui}/package.json`)('typescript')
  const files = execSync("find src test -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.mjs'", { cwd: ui, encoding: 'utf8' }).trim().split('\n')
  const out = {}
  for (const file of files) {
    const text = readFileSync(`${ui}/${file}`, 'utf8')
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const cases = []
    const title = (arg) => {
      if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text
      if (ts.isTemplateExpression(arg)) return arg.head.text + arg.templateSpans.map((s) => '*' + s.literal.text).join('')
      return '*'
    }
    const callee = (e) => {
      let x = ts.isCallExpression(e) ? e.expression : e
      const parts = []
      while (ts.isPropertyAccessExpression(x)) { parts.unshift(x.name.text); x = x.expression }
      if (ts.isIdentifier(x)) parts.unshift(x.text)
      return { head: parts[0], each: ts.isCallExpression(e) || parts.includes('each') }
    }
    const visit = (node, stack) => {
      if (ts.isCallExpression(node) && node.arguments.length > 0) {
        const { head, each } = callee(node.expression)
        if (head === 'describe' || head === 'it' || head === 'test') {
          let name = title(node.arguments[0])
          // `.each` formats its titles: printf placeholders and $field.
          if (each) name = name.replace(/%[sdifjoO#%]/g, '*').replace(/\$[\w.]+/g, '*')
          if (head === 'describe') { node.arguments.slice(1).forEach((a) => visit(a, [...stack, name])); return }
          const body = node.arguments[1]?.getText(sf) ?? ''
          cases.push({ name: [...stack, name].join(' '), mock: CALLS.test(body) || RECORDER.test(body), line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 })
          return
        }
      }
      ts.forEachChild(node, (c) => visit(c, stack))
    }
    visit(sf, [])
    out[file] = { internal: /vi\.mock\(\s*['"]\./.test(text), boundary: BOUNDARY.test(text), cases }
  }
  console.log(JSON.stringify(out, null, 1))
}

// A runtime test title's static case: exact, or with `*` standing for what the title interpolates.
function matcher(classes, file) {
  const cases = classes[file]?.cases ?? []
  const patterns = cases.filter((c) => c.name.includes('*')).map((c) => ({ c, re: new RegExp('^' + c.name.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 's') }))
  return (name) => cases.find((c) => c.name === name) ?? patterns.find(({ re }) => re.test(name))?.c
}

const ranges = (lines) => {
  const out = []
  for (const [file, set] of lines) {
    const s = [...set].sort((a, b) => a - b)
    let a = s[0], b = s[0]
    for (const l of s.slice(1)) { if (l === b + 1) b = l; else { out.push(`${file}:${a}-${b}`); a = b = l } }
    out.push(`${file}:${a}-${b}`)
  }
  return out
}

function recheck([reportPath, classesPath, basePath, outPath]) {
  const report = read(reportPath), classes = read(classesPath)
  const mock = new Map()
  for (const [file, { tests }] of Object.entries(report.testFiles)) {
    const match = matcher(classes, file)
    for (const t of tests) mock.set(t.id, match(t.name)?.mock ?? true)
  }
  const lines = new Map()
  for (const [file, { mutants }] of Object.entries(report.files)) for (const m of mutants) {
    if (!(m.status === 'Timeout' || (m.status === 'Killed' && mock.get(m.killedBy[0])))) continue
    const set = lines.get(file) ?? new Set()
    for (let l = m.location.start.line; l <= m.location.end.line; l++) set.add(l)
    lines.set(file, set)
  }
  const config = read(basePath)
  Object.assign(config, { mutate: ranges(lines), disableBail: true, jsonReporter: { fileName: 'reports/mutation/recheck.json' } })
  writeFileSync(outPath, JSON.stringify(config, null, 1))
  console.log(`${config.mutate.length} ranges over ${lines.size} files`)
}

function report(argv) {
  const jo = argv.indexOf('--json')
  const jsonOut = jo >= 0 ? argv.splice(jo, 2)[1] : null
  const [classesPath, ...reportPaths] = argv
  const classes = read(classesPath)
  const tests = new Map(), mutants = new Map()
  let unmatched = 0
  for (const path of reportPaths) {
    const r = read(path)
    // A bailing report names one killer per mutant and would hide the rest.
    if (r.config?.disableBail !== true) { console.error(`${path}: not a disableBail run; pass the rechecks, not the bailing run`); process.exit(2) }
    const key = new Map()
    for (const [file, { tests: list }] of Object.entries(r.testFiles)) {
      const match = matcher(classes, file)
      for (const t of list) {
        const id = `${file} :: ${t.name}`
        key.set(t.id, id)
        if (tests.has(id)) continue
        const c = match(t.name)
        if (!c) unmatched++
        tests.set(id, { id, file, name: t.name, line: c?.line, mock: c ? c.mock : true, unknown: !c, internal: classes[file]?.internal ?? false, boundary: classes[file]?.boundary ?? false, kills: new Set(), covers: 0 })
      }
    }
    for (const [file, { mutants: list }] of Object.entries(r.files)) for (const m of list) {
      const id = `${file}:${m.location.start.line}:${m.location.start.column}:${m.location.end.line}:${m.location.end.column}:${m.mutatorName}:${m.replacement}`
      if (mutants.has(id)) continue
      mutants.set(id, m.status)
      for (const t of m.coveredBy ?? []) tests.get(key.get(t)).covers++
      const killers = m.status === 'Killed' ? m.killedBy : m.status === 'Timeout' ? m.coveredBy ?? [] : []
      for (const t of killers) tests.get(key.get(t)).kills.add(id)
    }
  }
  const byR = new Set(), byM = new Set()
  for (const t of tests.values()) for (const k of t.kills) (t.mock ? byM : byR).add(k)
  const M = [...tests.values()].filter((t) => t.mock && !t.unknown)
  for (const t of M) t.only = [...t.kills].filter((k) => !byR.has(k))
  const only = new Set(M.flatMap((t) => t.only))
  const candidates = M.filter((t) => t.only.length === 0 && t.covers > 0)
  const counts = {}
  for (const s of mutants.values()) counts[s] = (counts[s] ?? 0) + 1
  console.log(`mutants ${JSON.stringify(counts)}`)
  console.log(`tests ${tests.size} (unmatched titles ${unmatched}); M ${M.length}; mutants killed by R ${byR.size}, by M ${byM.size}, by M only ${only.size}`)
  console.log(`M tests with an M-only kill ${M.length - M.filter((t) => t.only.length === 0).length}; candidates (no M-only kill, covering a mutant) ${candidates.length}`)
  for (const t of candidates) console.log(`  ${t.file}:${t.line}  kills ${t.kills.size}  ${t.name}`)
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ counts, tests: [...tests.values()].map((t) => ({ ...t, kills: t.kills.size })) }, null, 1))
}

if (command === 'classify') classify()
else if (command === 'recheck') recheck(args)
else if (command === 'report') report(args)
else { console.error('usage: mock-kills.mjs classify | recheck <bail.json> <classes.json> <config> <out> | report <classes.json> <report.json>... [--json out]'); process.exit(2) }
