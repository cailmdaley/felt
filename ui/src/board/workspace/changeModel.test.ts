import { describe, expect, it } from 'vitest'
import { assignLanes, changeIdentity, reviewMessage, type ChangeBundle, type ChangeHunk } from './changeModel.js'

const hunk = (start: number): ChangeHunk => ({ file: 'app.ts', old_from: start, old_lines: 1, new_from: start, new_lines: 1, windows: [] })
export const bundle = (): ChangeBundle => ({
  version: 2, title: 'A change', repo: { name: 'test', dir: '/repo', forge_url: null }, base: 'base', head: 'head', base_ref: 'main', head_ref: 'topic', commits: [],
  files: ['app.ts', 'app.test.ts', 'gen.ts', 'mode.sh'].map(path => ({
    path, status: 'modified', role: path.includes('test') ? 'test' : path === 'gen.ts' ? 'generated' : 'implementation',
    additions: 1, deletions: 1, header: 'metadata', lines: [],
    hunks: path === 'mode.sh' ? [] : [hunk(1)], remaining: path === 'mode.sh' ? [] : [hunk(2)],
  })), story: null,
})

describe('CLI-resolved change lanes', () => {
  it('keeps tests apart, metadata visible and uses the supplied Remaining references', () => {
    const lanes = assignLanes(bundle())
    expect(lanes.tests.map(file => file.path)).toEqual(['app.test.ts'])
    expect(lanes.remaining.map(file => [file.path, file.hunks.length])).toEqual([['app.ts', 1], ['mode.sh', 0], ['gen.ts', 1]])
    expect(lanes.remaining[0].hunks).toEqual([hunk(2)])
  })
  it('does not reinterpret story ranges to decide coverage', () => {
    const change = bundle()
    change.story = { overview: '', flags: [], chapters: [{ id: 'one', title: '', narrative: '', why_here: '', stops: [{ file: 'app.ts', note: '', importance: 'critical', hunks: [] }] }] }
    expect(assignLanes(change).remaining[0].hunks).toEqual([hunk(2)])
  })
  it('sends plain text with snapshot anchors', () => {
    expect(reviewMessage(bundle(), { note: 'Check this', comments: [{ file: 'app.ts', line: 11, side: 'old', text: 'Why remove it?' }] }))
      .toBe('Base: base\n\nHead: head\n\nReview of A change\n\nCheck this\n\napp.ts:11 (old)\nWhy remove it?')
  })
  it('resets viewed marks when the source changes', () => {
    expect(changeIdentity('bundle')).toBe(changeIdentity('bundle'))
    expect(changeIdentity('rebaked')).not.toBe(changeIdentity('bundle'))
  })
})
