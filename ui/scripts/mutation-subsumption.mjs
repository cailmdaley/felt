#!/usr/bin/env node
/**
 * Mutation subsumption over a StrykerJS JSON report.
 *
 *   node scripts/mutation-subsumption.mjs <mutation.json> [classification.json] [--json out.json]
 *
 * The report must come from a run with `coverageAnalysis: "perTest"` and
 * `disableBail: true`; with bail on, `killedBy` holds only the first failing
 * test and every kill set is truncated.
 *
 * For each test it computes the set of mutants it kills, then reports:
 *   - tests that kill no mutant;
 *   - tests whose kill set is contained in one other test's (subsumed);
 *   - tests whose kill set is contained in the union of all the others
 *     (redundant: removing that one test alone leaves the score unchanged);
 *   - a greedy set cover: a small subset of tests that keeps every kill.
 * Redundancy is per test; removing several redundant tests together can lose
 * kills, which is what the set cover accounts for.
 *
 * With a classification file (keyed by repo path, each entry a list of
 * `{ name, intent }`), it cross-tabulates redundancy against intent, matching
 * a test to its entry by the test's own title.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const jsonOutIdx = args.indexOf('--json')
const jsonOut = jsonOutIdx >= 0 ? args.splice(jsonOutIdx, 2)[1] : null
const [reportPath, classificationPath] = args
if (!reportPath) {
  console.error('usage: mutation-subsumption.mjs <mutation.json> [classification.json] [--json out.json]')
  process.exit(2)
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'))

// Tests, keyed by Stryker's test id.
const tests = new Map()
for (const [file, { tests: list }] of Object.entries(report.testFiles ?? {})) {
  for (const t of list) tests.set(t.id, { id: t.id, file, name: t.name, kills: new Set() })
}

// Mutants and their kills.
const counts = {}
const mutants = []
for (const [file, { mutants: list }] of Object.entries(report.files)) {
  for (const m of list) {
    counts[m.status] = (counts[m.status] ?? 0) + 1
    mutants.push({ ...m, file })
    if (m.status !== 'Killed') continue
    for (const id of m.killedBy ?? []) tests.get(id)?.kills.add(m.id)
  }
}
const killed = counts.Killed ?? 0
const timeout = counts.Timeout ?? 0
const survived = counts.Survived ?? 0
const noCov = counts.NoCoverage ?? 0
const detected = killed + timeout
const valid = detected + survived + noCov
const coveredValid = detected + survived

// How many tests kill each mutant.
const killers = new Map()
for (const t of tests.values()) for (const m of t.kills) killers.set(m, (killers.get(m) ?? 0) + 1)

const isSubset = (a, b) => {
  if (a.size > b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

const list = [...tests.values()]
for (const t of list) {
  t.zero = t.kills.size === 0
  t.unique = [...t.kills].filter((m) => killers.get(m) === 1).length
  t.redundant = t.unique === 0
  t.subsumedBy = null
  if (!t.zero) {
    // The smallest other test that contains this one's kill set; ties broken
    // by id so a pair with identical sets names one as the keeper.
    const sup = list
      .filter((o) => o !== t && isSubset(t.kills, o.kills))
      .filter((o) => o.kills.size > t.kills.size || o.id < t.id)
      .sort((a, b) => a.kills.size - b.kills.size)[0]
    t.subsumedBy = sup?.id ?? null
  }
}

// Greedy set cover over killed mutants.
const uncovered = new Set(list.flatMap((t) => [...t.kills]))
const cover = []
while (uncovered.size > 0) {
  let best = null
  let gain = 0
  for (const t of list) {
    if (cover.includes(t)) continue
    let g = 0
    for (const m of t.kills) if (uncovered.has(m)) g++
    if (g > gain || (g === gain && best && t.id < best.id)) { best = t; gain = g }
  }
  cover.push(best)
  for (const m of best.kills) uncovered.delete(m)
}
const inCover = new Set(cover.map((t) => t.id))

// Classification, matched by title within the file.
const intentOf = new Map()
if (classificationPath) {
  const cls = JSON.parse(readFileSync(classificationPath, 'utf8'))
  for (const t of list) {
    const entries = Object.entries(cls).find(([k]) => t.file.endsWith(k) || k.endsWith(t.file))?.[1] ?? []
    const hit = entries.find((e) => t.name === e.name || t.name.endsWith(' ' + e.name))
    intentOf.set(t.id, hit?.intent ?? 'unclassified')
  }
}

const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) + '%' : '-')
const short = (t) => `${t.file.split('/').pop()} :: ${t.name}`
const out = []
out.push(`mutants: ${JSON.stringify(counts)}`)
out.push(`mutation score: ${pct(detected, valid)} (${detected}/${valid}); on covered code: ${pct(detected, coveredValid)} (${detected}/${coveredValid})`)
out.push(`tests: ${list.length}; zero-kill: ${list.filter((t) => t.zero).length}; subsumed by one other: ${list.filter((t) => t.subsumedBy).length}; redundant by union: ${list.filter((t) => !t.zero && t.redundant).length}; greedy cover: ${cover.length}`)
out.push('')
out.push('per test (kills / unique / status):')
for (const t of [...list].sort((a, b) => a.file.localeCompare(b.file) || a.kills.size - b.kills.size)) {
  const status = t.zero ? 'ZERO' : t.subsumedBy ? `SUBSUMED by [${short(tests.get(t.subsumedBy))}]` : t.redundant ? 'REDUNDANT(union)' : 'unique'
  const intent = intentOf.size ? ` {${intentOf.get(t.id)}}` : ''
  out.push(`  ${String(t.kills.size).padStart(4)} ${String(t.unique).padStart(3)}  ${inCover.has(t.id) ? 'C' : ' '} ${status.padEnd(9)} ${short(t)}${intent}`)
}
if (intentOf.size) {
  out.push('')
  out.push('redundancy by intent (redundant = zero-kill or every kill shared):')
  const by = {}
  for (const t of list) {
    const b = (by[intentOf.get(t.id)] ??= { n: 0, zero: 0, subsumed: 0, redundant: 0, cover: 0 })
    b.n++
    if (t.zero) b.zero++
    if (t.subsumedBy) b.subsumed++
    if (t.redundant) b.redundant++
    if (inCover.has(t.id)) b.cover++
  }
  out.push('  intent          n  zero  subsumed  redundant  in-cover')
  for (const [k, b] of Object.entries(by).sort((a, b) => b[1].n - a[1].n)) {
    out.push(`  ${k.padEnd(13)} ${String(b.n).padStart(3)}  ${String(b.zero).padStart(4)}  ${String(b.subsumed).padStart(8)}  ${String(b.redundant).padStart(5)} ${pct(b.redundant, b.n).padStart(6)}  ${String(b.cover).padStart(6)}`)
  }
}
console.log(out.join('\n'))

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({
    counts,
    score: detected / valid,
    coveredScore: detected / coveredValid,
    cover: cover.map((t) => t.id),
    tests: list.map((t) => ({
      id: t.id, file: t.file, name: t.name, intent: intentOf.get(t.id) ?? null,
      kills: [...t.kills], unique: t.unique, zero: t.zero, redundant: t.redundant,
      subsumedBy: t.subsumedBy, inCover: inCover.has(t.id),
    })),
  }, null, 2))
}
