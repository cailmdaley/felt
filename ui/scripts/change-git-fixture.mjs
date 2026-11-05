import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const fill = '\\rule{20em}{20em}'.repeat(4), lowered = '\\rule[-20em]{20em}{20em}'.repeat(4)
/**
 * Valid TeX whose ink leaves its layout box, by the file whose rows it can cover.
 * A note lies inside its file's clipped card, where only plain rows paint below it,
 * so these four sit above hidden-character rows. A chapter narrative has no card,
 * so `large.txt`, the last stop of the chapter before it, is reached from below.
 */
export const MATH_PAYLOADS = {
  'raisebox.js': `\\colorbox{white}{\\smash{\\raisebox{-20em}{${fill}}}}`,
  'colorbox.js': `\\colorbox{white}{\\smash{\\raisebox{-20em}{\\colorbox{#e1f4e4}{${fill}}}}}`,
  'rule.js': `\\smash{${lowered}}`,
  'kern.js': `\\smash{\\kern-30em${lowered}}`,
  'large.txt': `\\colorbox{white}{\\smash{\\raisebox{10em}{${fill}}}}`,
}
const NOTE_PAYLOADS = ['raisebox.js', 'colorbox.js', 'rule.js', 'kern.js']
const WIDE_DISPLAY = `\\int_0^\\infty ${'\\frac{\\sin x}{x} + '.repeat(30)}1\\,dx`

/** A two-commit, no-origin repo; none of the gate's history comes from this checkout. */
export function createChangeGitFixture(dir) {
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  const put = (path, text) => writeFileSync(join(repo, path), text)
  git('init', '-q')
  git('config', 'user.name', 'Fixture Author'); git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.autocrlf', 'false')
  const hostile = ['evil.constructor', 'evil.__proto__', 'evil.toString', '__proto__', 'constructor', 'toString', 'space "quote".ts', 'tab\tname.ts', 'é.ts', '<img onerror=alert(1)>.ts']
  const ordinary = ['main.go', 'plain.txt', 'reader.test.ts', 'generated.ts', 'deleted.ts', 'before.ts']
  const body = (path, changed) => Array.from({ length: 12 }, (_, i) => `${changed && (i === 2 || i === 9) ? 'after' : 'before'} ${path} ${i + 1}\t <tag> & \"quoted\"  \n`).join('')
  for (const path of [...hostile, ...ordinary]) put(path, body(path, false))
  put('large.txt', Array.from({ length: 160 }, (_, i) => `old large row ${i + 1}\n`).join(''))
  put('crlf.txt', 'before\r\nunchanged\r\nlast')
  const hidden = { 'gate.js': 'U+202E', 'midline-cr.txt': 'U+000D', ...Object.fromEntries(NOTE_PAYLOADS.map(file => [file, 'U+202E'])) }
  mkdirSync(join(repo, 'docs')); mkdirSync(join(repo, 'config'))
  put('docs/guide.md', '# Guide\n\nOld guidance.\n'); put('config/app.yaml', 'mode: old\nretries: 3\n')
  put('gate.js', 'function gate(isAdmin) {\n  log()\n  return secret()\n}\n')
  for (const file of NOTE_PAYLOADS) put(file, 'function gate(isAdmin) {\n  return secret()\n}\n')
  put('midline-cr.txt', 'first\nalpha\rold\nlast\n')
  git('add', '.'); git('commit', '-qm', 'Fixture base')
  const base = git('rev-parse', 'HEAD')
  for (const path of [...hostile, ...ordinary.filter(path => path !== 'deleted.ts' && path !== 'before.ts')]) put(path, body(path, true))
  renameSync(join(repo, 'before.ts'), join(repo, 'after.ts'))
  put('after.ts', body('before.ts', true))
  rmSync(join(repo, 'deleted.ts'))
  put('added.txt', 'new first\n\nnew last without newline')
  put('crlf.txt', 'after\r\nunchanged\r\nchanged last')
  put('docs/guide.md', '# Guide\n\nNew guidance.\n'); put('config/app.yaml', 'mode: new\nretries: 3\n')
  // CVE-2021-42574: the whole line is a comment that displays as a guard.
  for (const file of ['gate.js', ...NOTE_PAYLOADS]) put(file, 'function gate(isAdmin) {\n  /*\u202e } \u2066if (isAdmin)\u2069 \u2066 begin admins only */ {\n  return secret()\n}\n')
  put('midline-cr.txt', 'first\nalpha\rnew\nlast\n')
  put('large.txt', Array.from({ length: 160 }, (_, i) => `new large row ${i + 1}\n`).join(''))
  git('add', '.'); git('commit', '-qm', 'Fixture head')
  const head = git('rev-parse', 'HEAD')
  const story = {
    overview: `Conserve source rows across story excerpts, tests, remaining hunks and folded generated files. The estimator is $C_\\ell^{\\kappa\\gamma}$.\n\n$$\n${WIDE_DISPLAY}\n$$\n\nUnbroken: $\\mathrm{${'x'.repeat(200)}}$.`,
    roles: { 'generated.ts': 'generated' },
    chapters: [{ id: 'excerpts', title: 'Small excerpts', stops: [
      ...NOTE_PAYLOADS.map(file => ({ file, from: 2, to: 2, side: 'new', importance: 'supporting', note: `Hidden characters here. $${MATH_PAYLOADS[file]}$` })),
      { file: 'plain.txt', from: 2, to: 4, side: 'new', importance: 'important', note: 'One change, not the whole file.' },
      { file: 'reader.test.ts', from: 2, to: 4, side: 'new', importance: 'supporting', note: 'This also appears in Tests.' },
      { file: 'deleted.ts', from: 1, to: 4, side: 'old', importance: 'supporting', note: 'Old-side coordinates.' },
      { file: 'large.txt', from: 1, to: 3, side: 'new', importance: 'supporting', note: 'Remaining needs multiple virtual windows.' },
    ] }, { id: 'config', title: 'Configuration', narrative: `Below the excerpts. $${MATH_PAYLOADS['large.txt']}$`, stops: [
      { file: 'config/app.yaml', from: 1, to: 2, side: 'new', importance: 'supporting', note: 'Set by the new mode.' },
    ] }],
  }
  return { repo, base, head, story, hostile, hidden }
}
