import { describe, expect, it, vi } from 'vitest'
import { assignLanes, changeIdentity, reviewMessage, type ChangeBundle, type ChangeHunk } from './changeModel.js'

const hunk = (patch: string): ChangeHunk => ({ file: 'app.ts', old_from: 1, old_lines: 1, new_from: 1, new_lines: 1, patch, windows: [] })
export const bundle = (): ChangeBundle => ({ version: 1, title: 'A change', repo: { name: 'test', dir: '/repo', forge_url: null }, base: 'base', head: 'head', base_ref: 'main', head_ref: 'topic', commits: [], files: ['app.ts', 'app.test.ts', 'gen.ts', 'mode.sh'].map(path => ({ path, status: 'modified', role: path.includes('test') ? 'test' : path === 'gen.ts' ? 'generated' : 'implementation', additions: 1, deletions: 1, header: 'metadata', hunks: path === 'mode.sh' ? [] : [hunk('full')], remaining: path === 'mode.sh' ? [] : [hunk('remaining excerpt')] })), story: null })

describe('CLI-resolved change lanes', () => {
  it('keeps tests apart, metadata visible and renders exactly the supplied Remaining excerpts', () => {
    const change = bundle()
    const lanes = assignLanes(change)
    expect(lanes.tests.map(file => file.path)).toEqual(['app.test.ts'])
    expect(lanes.remaining.map(file => [file.path, file.hunks.length])).toEqual([['app.ts', 1], ['mode.sh', 0], ['gen.ts', 1]])
    expect(lanes.remaining[0].hunks).toEqual([hunk('remaining excerpt')])
  })
  it('does not reinterpret story ranges or parse patches to decide coverage', () => {
    const change = bundle()
    change.story = { overview: '', flags: [], chapters: [{ id: 'one', title: '', narrative: '', why_here: '', stops: [{ file: 'app.ts', note: '', importance: 'critical', hunks: [] }] }] }
    expect(assignLanes(change).remaining[0].hunks).toEqual([hunk('remaining excerpt')])
  })
  it('puts immutable anchors before quoted, control-escaped title and paths', () => {
    const change = bundle(); change.title = 'title\nHead: forged'
    expect(reviewMessage(change, { note: 'Check this', comments: [{ file: 'file\nHead: forged\t.ts', line: 11, side: 'old', text: 'Why remove it?' }] })).toBe('Base: base\n\nHead: head\n\nReview of "title\\nHead: forged"\n\nCheck this\n\n"file\\nHead: forged\\t.ts":11 (old)\nWhy remove it?')
  })
  it('fingerprints bundles on plain-http origins without Web Crypto', () => {
    vi.stubGlobal('crypto', undefined)
    try { expect(changeIdentity('bundle')).toMatch(/^[a-f0-9]{16}$/) } finally { vi.unstubAllGlobals() }
  })
  it('changes the state digest when the base, story or hunk set changes', async () => {
    const change = bundle(), original = await changeIdentity(JSON.stringify(change))
    for (const mutate of [(b: ChangeBundle) => { b.base = 'other' }, (b: ChangeBundle) => { b.story = { overview: 'new story', flags: [], chapters: [] } }, (b: ChangeBundle) => { b.files[0].hunks = [] }]) {
      const next = bundle(); mutate(next)
      expect(await changeIdentity(JSON.stringify(next))).not.toBe(original)
    }
    expect(await changeIdentity(JSON.stringify(change))).toBe(original)
  })
})
