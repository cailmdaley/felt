// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { createChangeGitFixture } from '../scripts/change-git-fixture.mjs'
import { assertDOMConservation, gitChangedRows, parseGitRows, rowID } from '../scripts/change-dom-contract.mjs'

it('independently parses real Git coordinates, hostile names, renames, CRLF and unterminated lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'change-oracle-'))
  try {
    const { repo, base, head, hostile } = createChangeGitFixture(dir)
    const rows = gitChangedRows(repo, base, head)
    for (const path of hostile) {
      expect(rows.get(rowID(path, 'old', 3))).toBe(`before ${path} 3\t <tag> & "quoted"  `)
      expect(rows.get(rowID(path, 'new', 3))).toBe(`after ${path} 3\t <tag> & "quoted"  `)
    }
    expect(rows.get(rowID('after.ts', 'old', 3))).toContain('before.ts')
    expect(rows.has(rowID('before.ts', 'old', 3))).toBe(false)
    expect(rows.get(rowID('crlf.txt', 'old', 1))).toBe('before')
    expect(rows.get(rowID('crlf.txt', 'new', 3))).toBe('changed last')
    expect(rows.get(rowID('added.txt', 'new', 2))).toBe('')
    expect(rows.get(rowID('added.txt', 'new', 3))).toBe('new last without newline')
    expect(rows.get(rowID('deleted.ts', 'old', 12))).toContain('12')
    expect(rows.get(rowID('large.txt', 'new', 160))).toBe('new large row 160')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('does not confuse source text that looks like patch headers with Git metadata', () => {
  const rows = parseGitRows('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1,2 @@\n--- old source\n+++ new source\n+@@ not a hunk header\n\\ No newline at end of file\n', 'a')
  expect([...rows]).toEqual([
    [rowID('a', 'old', 1), '-- old source'],
    [rowID('a', 'new', 1), '++ new source'],
    [rowID('a', 'new', 2), '@@ not a hunk header'],
  ])
  expect(() => parseGitRows('@@ -1 +1 @@\n-old\n', 'a')).toThrow(/Git hunk/)
})

it('rejects missing, blanked, invented, misnumbered, wrong-side and text-corrupted DOM rows', () => {
  const truth = new Map([[rowID('source.ts', 'old', 7), 'old  '], [rowID('source.ts', 'new', 8), '\tnew']])
  const windows = [{ index: 0, lane: 'Remaining', file: 'source.ts', rows: [
    { type: 'change-deletion', line: '7', text: 'old  \n' },
    { type: 'change-addition', line: '8', text: '\tnew\n' },
  ] }]
  expect(assertDOMConservation(truth, windows)).toEqual({ rows: 2, windows: 1 })
  const mutate = (change: (copy: typeof windows) => void) => {
    const copy = structuredClone(windows); change(copy)
    expect(() => assertDOMConservation(truth, copy)).toThrow()
  }
  mutate(copy => { copy[0].rows.pop() })
  mutate(copy => { copy[0].rows = [] })
  mutate(copy => { copy[0].rows[1].line = '9' })
  mutate(copy => { copy[0].rows[1].type = 'change-deletion' })
  mutate(copy => { copy[0].rows[1].text = 'new' })
  mutate(copy => { copy[0].file = 'other.ts' })
  mutate(copy => { copy.push({ index: 1, lane: 'Story', file: 'source.ts', rows: [] }) })
  // A correct duplicate cannot mask a wrong-text copy in a different lane.
  mutate(copy => { const duplicate = structuredClone(copy[0]); duplicate.rows[0].text = 'wrong'; copy.push(duplicate) })
})
