// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, renameSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it, expect } from 'vitest'
import { changedRows, checkChange } from '../scripts/check-change.mjs'
import { buildShuttle, bakeChange } from '../scripts/bake-change-fixture.mjs'
import { assignLanes, type ChangeBundle } from '../src/board/workspace/changeModel.js'

it('reads the public CLI bundles with the reader types, paths and changed-line coverage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'change-contract-'))
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  const put = (path: string, body: string | Uint8Array) => writeFileSync(join(repo, path), body)
  try {
    git('init', '-q'); git('config', 'user.name', 'Fixture Author'); git('config', 'user.email', 'fixture@example.invalid')
    for (const path of ['space name.ts', 'é.ts', 'deleted.ts', 'renamed.ts', 'pure.ts', 'mode.sh', 'app.test.ts', 'type.ts', 'tab\t.ts']) put(path, Array.from({ length: 30 }, (_, n) => `${path} line ${n + 1}\n`).join(''))
    put('image.bin', new Uint8Array([0, 1, 2])); put('cr.ts', 'before\r\ncontext\r\nlast')
    git('add', '.'); git('commit', '-qm', 'Base'); git('tag', 'base')
    for (const path of ['space name.ts', 'é.ts', 'app.test.ts', 'tab\t.ts']) put(path, Array.from({ length: 30 }, (_, n) => `${path} ${n === 2 || n === 25 ? 'changed' : 'line'} ${n + 1}\n`).join(''))
    renameSync(join(repo, 'renamed.ts'), join(repo, 'new name.ts')); put('new name.ts', 'changed\n' + Array.from({ length: 29 }, (_, n) => `renamed.ts line ${n + 2}\n`).join(''))
    renameSync(join(repo, 'pure.ts'), join(repo, 'pure renamed.ts'))
    chmodSync(join(repo, 'mode.sh'), 0o755)
    rmSync(join(repo, 'type.ts')); symlinkSync('renamed.ts', join(repo, 'type.ts'))
    put('cr.ts', 'after\r\ncontext\r\ntail')
    rmSync(join(repo, 'deleted.ts'))
    put('image.bin', new Uint8Array([0, 2, 3])); put('added.ts', Array.from({ length: 9 }, (_, n) => `meaning ${n + 1}\n`).join(''))
    git('add', '.'); git('commit', '-qm', 'Change')
    const binary = buildShuttle(dir)
    const plain = bakeChange(binary, repo, 'base', 'HEAD')
    const minimal = bakeChange(binary, repo, 'base', 'HEAD', { chapters: [{ id: 'empty', title: 'Empty' }] })
    const empty = bakeChange(binary, repo, 'HEAD', 'HEAD')
    const story = bakeChange(binary, repo, 'base', 'HEAD', { overview: 'Read the rename first.', flags: [], chapters: [{ id: 'rename', title: 'Rename', narrative: '', why_here: '', stops: [
      { file: 'new name.ts', from: 1, to: 3, side: 'old', importance: 'important', note: 'Old lines use the destination path too.' },
      { file: 'deleted.ts', side: 'old', importance: 'supporting', note: 'Whole deleted file.' },
      { file: 'added.ts', from: 1, to: 3, importance: 'important', note: 'The first idea.' },
      { file: 'space name.ts', from: 1, to: 1, importance: 'context', note: 'Context does not show a change.' },
    ] }, { id: 'next', title: 'Next', stops: [{ file: 'added.ts', from: 3, to: 4, importance: 'supporting', note: 'A second short excerpt, overlapping once.' }] }] })
    const fixtureDir = new URL('../harness/fixtures/', import.meta.url)
    const fixtureStory = JSON.parse(readFileSync(new URL('dogfood.story.json', fixtureDir), 'utf8'))
    const fixture = JSON.parse(readFileSync(new URL('dogfood.change.json', fixtureDir), 'utf8'))
    const dogfood = bakeChange(binary, fileURLToPath(new URL('../../', import.meta.url)), '0f3a0cdc', 'f629d29c417f20c16b8e4415ebd6e424235060d3', fixtureStory)
    expect({ ...dogfood.bundle, commits: dogfood.bundle.commits.map((commit: object) => ({ ...commit, author: 'Repository contributor' })), repo: { ...dogfood.bundle.repo, dir: '/fixture-repo/felt' } }).toEqual(fixture)
    const dogfoodPlain = bakeChange(binary, fileURLToPath(new URL('../../', import.meta.url)), '0f3a0cdc', 'f629d29c417f20c16b8e4415ebd6e424235060d3')
    const plainFixture = JSON.parse(readFileSync(new URL('dogfood-plain.change.json', fixtureDir), 'utf8'))
    expect({ ...dogfoodPlain.bundle, commits: dogfoodPlain.bundle.commits.map((commit: object) => ({ ...commit, author: 'Repository contributor' })), repo: { ...dogfoodPlain.bundle.repo, dir: '/fixture-repo/felt' } }).toEqual(plainFixture)
    const samples = [plain, minimal, empty, story, dogfood, dogfoodPlain]
    // Type-check JSON literals, not a type assertion: field renames and null arrays must fail.
    const source = join(dir, 'contract.mts')
    writeFileSync(source, `import type { ChangeBundle } from ${JSON.stringify(fileURLToPath(new URL('../src/board/workspace/changeModel.js', import.meta.url)))};\n` + samples.map(({ bundle }, i) => `const bundle${i}: ChangeBundle = ${JSON.stringify(bundle)};`).join('\n'))
    execFileSync(resolve('node_modules/.bin/tsc'), ['--noEmit', '--strict', '--skipLibCheck', '--target', 'es2022', '--module', 'nodenext', source], { encoding: 'utf8', stdio: 'inherit' })
    for (const { bundle, report } of samples as { bundle: ChangeBundle; report: { total: number; covered: number; uncovered: { file: string; old_from: number; old_lines: number; new_from: number; new_lines: number }[] } }[]) {
      const files = bundle.files
      const all = new Set(files.flatMap(file => [...changedRows(file.path, file.hunks)]))
      expect(all.size).toBe(report.total)
      expect(files.reduce((count, file) => count + changedRows(file.path, file.remaining).size, 0) + report.covered).toBe(report.total)
      const lanes = assignLanes(bundle)
      const visible = new Set([
        ...lanes.chapters.flatMap(chapter => chapter.stops.flatMap(stop => [...changedRows(stop.file, stop.hunks)])),
        ...[...lanes.tests, ...lanes.remaining].flatMap(file => [...changedRows(file.path, file.hunks)]),
      ])
      expect(visible).toEqual(all)
      expect(files.reduce((sum, file) => sum + file.additions + file.deletions, 0)).toBe(report.total)
      expect(files.every(file => file.header.startsWith('diff --git '))).toBe(true)
      const remaining = assignLanes(bundle).remaining.flatMap(file => file.hunks.map(hunk => ({ file: file.path, old_from: hunk.old_from, old_lines: hunk.old_lines, new_from: hunk.new_from, new_lines: hunk.new_lines })))
      expect(remaining).toEqual(report.uncovered.filter(hunk => bundle.files.find(file => file.path === hunk.file)?.role !== 'test').map(({ file, old_from, old_lines, new_from, new_lines }) => ({ file, old_from, old_lines, new_from, new_lines })))
    }
    expect(() => checkChange(story.bundle)).not.toThrow()
    const lostRow = structuredClone(story.bundle)
    lostRow.files.find((file: { path: string }) => file.path === 'added.ts').remaining[0].windows = []
    expect(() => checkChange(lostRow)).toThrow(/retain every changed row/)
    const files = (plain.bundle as ChangeBundle).files
    expect(files.find(file => file.path === 'new name.ts')?.status).toBe('renamed')
    expect(files.find(file => file.path === 'new name.ts')?.hunks).toHaveLength(1)
    expect(files.find(file => file.path === 'space name.ts')?.hunks).toHaveLength(2)
    expect(empty.bundle.commits).toEqual([]); expect(empty.bundle.files).toEqual([])
    expect(story.bundle.files.find((file: { path: string }) => file.path === 'deleted.ts').remaining).toEqual([])
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 120_000)
