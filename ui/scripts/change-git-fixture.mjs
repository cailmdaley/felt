import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

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
  mkdirSync(join(repo, 'docs')); mkdirSync(join(repo, 'config'))
  put('docs/guide.md', '# Guide\n\nOld guidance.\n'); put('config/app.yaml', 'mode: old\nretries: 3\n')
  git('add', '.'); git('commit', '-qm', 'Fixture base')
  const base = git('rev-parse', 'HEAD')
  for (const path of [...hostile, ...ordinary.filter(path => path !== 'deleted.ts' && path !== 'before.ts')]) put(path, body(path, true))
  renameSync(join(repo, 'before.ts'), join(repo, 'after.ts'))
  put('after.ts', body('before.ts', true))
  rmSync(join(repo, 'deleted.ts'))
  put('added.txt', 'new first\n\nnew last without newline')
  put('crlf.txt', 'after\r\nunchanged\r\nchanged last')
  put('docs/guide.md', '# Guide\n\nNew guidance.\n'); put('config/app.yaml', 'mode: new\nretries: 3\n')
  put('large.txt', Array.from({ length: 160 }, (_, i) => `new large row ${i + 1}\n`).join(''))
  git('add', '.'); git('commit', '-qm', 'Fixture head')
  const head = git('rev-parse', 'HEAD')
  const story = {
    overview: 'Conserve source rows across story excerpts, tests, remaining hunks and folded generated files.',
    roles: { 'generated.ts': 'generated' },
    chapters: [{ id: 'excerpts', title: 'Small excerpts', stops: [
      { file: 'plain.txt', from: 2, to: 4, side: 'new', importance: 'important', note: 'One change, not the whole file.' },
      { file: 'reader.test.ts', from: 2, to: 4, side: 'new', importance: 'supporting', note: 'This also appears in Tests.' },
      { file: 'deleted.ts', from: 1, to: 4, side: 'old', importance: 'supporting', note: 'Old-side coordinates.' },
      { file: 'large.txt', from: 1, to: 3, side: 'new', importance: 'supporting', note: 'Remaining needs multiple virtual windows.' },
    ] }],
  }
  return { repo, base, head, story, hostile }
}
