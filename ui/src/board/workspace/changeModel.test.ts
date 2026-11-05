import { describe, expect, it, vi } from 'vitest'
import { assignLanes, changeIdentity, hiddenCharacterFlags, hiddenCharacters, reviewMessage, type ChangeBundle, type ChangeHunk } from './changeModel.js'

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
  it('finds bidi controls and invisible format characters', () => {
    for (const char of ['\u202a', '\u202e', '\u2066', '\u2069', '\u200b', '\u00ad', '\ufeff', '\u{e0041}']) expect(hiddenCharacters(`a${char}b`)).toEqual([char])
    expect(hiddenCharacters('plain \t text é 😀')).toEqual([])
  })
  it('flags hidden characters per file, on the side that has them, regardless of any story', () => {
    const change = bundle()
    const row = (patch: string, lines: NonNullable<ChangeHunk['windows'][number]['lines']>) => ({ ...hunk(patch), windows: [{ old_from: 1, old_lines: 1, new_from: 1, new_lines: 1, rows: 1, patch, lines }] })
    change.files[0].hunks = [row('-a\u202eb\n+c\u2066d\n', [{ kind: 'context', old: 3, new: 3, text: 'clean' }, { kind: 'deletion', old: 4, new: 0, text: 'a\u202eb' }, { kind: 'addition', old: 0, new: 4, text: 'c\u2066d' }])]
    change.files[1].hunks = [{ ...hunk('+x\u200by\n'), windows: [{ old_from: 1, old_lines: 1, new_from: 1, new_lines: 1, rows: 1, patch: '+x\u200by\n' }] }]
    change.story = { overview: '', flags: [], chapters: [] }
    expect(hiddenCharacterFlags(change)).toEqual([
      { file: 'app.ts', from: 4, side: 'old', text: expect.stringMatching(/^2 rows have hidden characters \(U\+202E, U\+2066\)/) },
      { file: 'app.test.ts', text: expect.stringMatching(/^This patch has hidden characters \(U\+200B\)/) },
    ])
    expect(hiddenCharacterFlags(bundle())).toEqual([])
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
