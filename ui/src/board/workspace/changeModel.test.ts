import { describe, expect, it } from 'vitest'
import { assignLanes, changeFiles, diffWindows, overlaps, reviewMessage, stopHunks, type ChangeBundle } from './changeModel.js'

const patch = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -10,3 +10,3 @@\n before\n-old\n+new\n after\n@@ -90,1 +90,1 @@\n-old tail\n+new tail\n`
const bundle = (): ChangeBundle => ({ version: 1, title: 'A change', repo: { name: 'test', dir: '/repo', forge_url: null }, base: 'base', head: 'head', base_ref: 'main', head_ref: 'topic', commits: [], patch: ['app.ts', 'app.test.ts', 'gen.ts'].map(patch).join(''), files: ['app.ts', 'app.test.ts', 'gen.ts'].map(path => ({ path, status: 'modified', role: path.includes('test') ? 'test' : 'implementation', additions: 2, deletions: 2 })), story: null })

describe('change lanes and coverage', () => {
  it('keeps tests apart and uncovered hunks visible, applying story role overrides', () => {
    const change = bundle()
    change.story = { overview: '', flags: [], roles: { 'gen.ts': 'generated' }, chapters: [{ id: 'first', title: 'First', narrative: '', why_here: '', stops: [{ file: 'app.ts', from: 11, to: 11 }] }] }
    const lanes = assignLanes(change)
    expect(lanes.tests.map(f => f.path)).toEqual(['app.test.ts'])
    expect(lanes.remaining.map(f => [f.path, f.role, f.hunks.length])).toEqual([['app.ts', 'implementation', 1], ['gen.ts', 'generated', 2]])
    expect(lanes.remaining[0].hunks[0].newStart).toBe(90)
  })
  it('uses inclusive file-side ranges, never covering a zero-line deletion from the new side', () => {
    const hunk = changeFiles(bundle())[0].hunks[0]
    expect(overlaps(hunk, { file: 'app.ts', from: 12, to: 15 })).toBe(true)
    expect(overlaps(hunk, { file: 'app.ts', from: 13 })).toBe(false)
    expect(overlaps({ ...hunk, newCount: 0 }, { file: 'app.ts', from: 10 })).toBe(false)
    expect(overlaps(hunk, { file: 'app.ts', side: 'old', from: 10 })).toBe(true)
    expect(overlaps(hunk, { file: 'app.ts' })).toBe(true)
  })
  it('covers whole files without ranges, but flags do not hide a hunk', () => {
    const change = bundle()
    change.story = { overview: '', flags: [{ file: 'gen.ts', text: 'Look' }], chapters: [{ id: 'a', title: '', narrative: '', why_here: '', stops: [{ file: 'app.ts' }, { file: 'app.test.ts' }] }] }
    expect(assignLanes(change).remaining.map(f => f.path)).toEqual(['gen.ts'])
    expect(assignLanes(change).tests).toHaveLength(1)
  })
  it('falls back to implementation-first files without a story', () => {
    const change = bundle(); change.files[0].role = 'docs'
    expect(assignLanes(change).remaining.map(f => f.path)).toEqual(['gen.ts', 'app.ts'])
  })
  it('retains metadata-only changes in Remaining', () => {
    const change = bundle(); change.patch = 'diff --git a/app.ts b/app.ts\nold mode 100644\nnew mode 100755\n'; change.files = change.files.slice(0, 1)
    expect(assignLanes(change).remaining[0].header).toContain('new mode 100755')
  })
  it('selects an exact line range out of file order and preserves anchors in windowed patches', () => {
    const file = changeFiles(bundle())[0]
    const late = stopHunks(file, { file: file.path, from: 90 })
    const early = stopHunks(file, { file: file.path, from: 11, to: 11 })
    expect(late[0].rows.map(r => r.text)).toEqual(['-old tail', '+new tail'])
    expect(early[0].rows.map(r => r.text)).toEqual(['-old', '+new'])
    expect(diffWindows(file, early)[0].patch).toContain('@@ -11,1 +11,1 @@')
    expect(diffWindows(file, file.hunks, 2).every(w => w.rows <= 2)).toBe(true)
  })
  it('preserves a final empty context line and decodes Git’s quoted UTF-8 paths', () => {
    const change = bundle(); change.files = [{ ...change.files[0], path: 'é.ts' }]
    change.patch = 'diff --git "a/\\303\\251.ts" "b/\\303\\251.ts"\n--- "a/\\303\\251.ts"\n+++ "b/\\303\\251.ts"\n@@ -1,2 +1,2 @@\n-old\n+new\n \n'
    const file = changeFiles(change)[0]
    expect(file.hunks[0].rows.at(-1)?.text).toBe(' ')
    expect(diffWindows(file)[0].patch).toContain('@@ -1,2 +1,2 @@')
  })
  it('round-trips every row, side and no-newline marker through independent windows', () => {
    const change = bundle(); change.files = change.files.slice(0, 1)
    change.patch = 'diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1,3 +1,3 @@\n same\n-old\n+new\n-tail\n\\ No newline at end of file\n+tail\n\\ No newline at end of file\n'
    const file = changeFiles(change)[0]
    for (const size of [1, 2, 3, 120]) {
      const rows = diffWindows(file, file.hunks, size).flatMap(window => changeFiles({ ...change, patch: window.patch })[0].hunks.flatMap(hunk => hunk.rows))
      expect(rows).toEqual(file.hunks[0].rows)
    }
  })
  it('keeps a deletion-only hunk visible until an old-side stop covers it', () => {
    const change = bundle(); change.files = change.files.slice(0, 1)
    change.patch = 'diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -10,1 +9,0 @@\n-old\n'
    change.story = { overview: '', flags: [], chapters: [{ id: 'remove', title: '', narrative: '', why_here: '', stops: [{ file: 'app.ts', from: 10 }] }] }
    expect(assignLanes(change).remaining).toHaveLength(1)
    change.story.chapters[0].stops[0].side = 'old'
    expect(assignLanes(change).remaining).toHaveLength(0)
    expect(stopHunks(changeFiles(change)[0], change.story.chapters[0].stops[0])[0].rows[0].text).toBe('-old')
  })
  it('sends one review with the exact head and old-side anchors', () => {
    expect(reviewMessage(bundle(), { note: 'Check this', comments: [{ file: 'app.ts', line: 11, side: 'old', text: 'Why remove it?' }] })).toBe('Review of A change\n\nHead: head\n\nCheck this\n\napp.ts:11 (old)\nWhy remove it?')
  })
})
