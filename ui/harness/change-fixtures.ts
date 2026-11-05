import dogfood from './generated/dogfood.change.json'
import plain from './generated/dogfood-plain.change.json'
import type { ChangeBundle } from '../src/board/workspace/changeModel.js'
import { WORKSPACE_HOST, WORKSPACE_ID, WORKSPACE_REPORT, WORKSPACE_UID, type WorkspaceExample } from './workspace-fixtures.js'

/** Real repository snapshot plus no-story and long-file reading probes. */
export function addChangeFixtures(fixture: WorkspaceExample, now: number): void {
  const bundle = dogfood as ChangeBundle
  const owner = fixture.feed.fibers.find(row => (row.fiber as { id: string }).id === WORKSPACE_ID)!
  owner.runtime = { state: 'running', phase: 'waiting', tmux_session: 'fixture-review-worker', started_at: now - 60_000 }
  const dir = WORKSPACE_REPORT.slice(0, WORKSPACE_REPORT.lastIndexOf('/'))
  const header = 'diff --git a/src/large.ts b/src/large.ts\n--- a/src/large.ts\n+++ b/src/large.ts\n'
  const windows = Array.from({ length: 84 }, (_, index) => {
    const start = index * 60 + 1, count = Math.min(60, 5001 - start)
    return { old_from: start, old_lines: count, new_from: start, new_lines: count, rows: count * 2, start: index * 120 }
  })
  const hunks = [{ file: 'src/large.ts', old_from: 1, old_lines: 5000, new_from: 1, new_lines: 5000, windows }]
  const large: ChangeBundle = { ...bundle, title: 'A 5,000-line changed file', head: '5'.repeat(40), story: null,
    areas: [{ name: 'Other', role: 'implementation', files: ['src/large.ts'], lines: 10000 }],
    files: [{ path: 'src/large.ts', role: 'implementation', status: 'modified', additions: 5000, deletions: 5000, header,
      lines: Array.from({ length: 5000 }, (_, index) => [
        { kind: 'deletion' as const, old: index + 1, new: 0, text: `export const value${index + 1} = ${index};` },
        { kind: 'addition' as const, old: 0, new: index + 1, text: `export const value${index + 1} = ${index + 1};` },
      ]).flat(), hunks, remaining: hunks }],
  }
  for (const [name, change] of [['family', bundle], ['plain', plain as ChangeBundle], ['large', large]] as const) {
    const path = `${dir}/${name}.change.json`
    fixture.files.push({ owner: WORKSPACE_HOST, path, mime: 'application/json', body: new Blob([JSON.stringify(change)], { type: 'application/json' }) })
    fixture.receipts.push({ ...fixture.receipts[0], uid: WORKSPACE_UID, fiber: WORKSPACE_ID, host: WORKSPACE_HOST, fullPath: path, basename: `${name}.change.json`, timestamp: now - 15_000 })
  }
  const report = fixture.files.find(file => file.path === WORKSPACE_REPORT)!
  report.body = new Blob([`<!doctype html><html><head><title>Read the family change</title><style>body{font:18px/1.6 system-ui;max-width:680px;margin:80px auto;padding:24px;color:light-dark(#272720,#e2e2da);background:light-dark(#f6f5f0,#242421);color-scheme:light dark}a{color:inherit}li{margin:24px 0}small{opacity:.7}</style></head><body><small>FELT / CHANGE REVIEW</small><h1>A family’s root stays in sight.</h1><p>This small committed diff exercises family navigation. Read the story first, then check the tests and the edits the story doesn’t cover.</p><ul><li><a href="./family.change.json">Read the change →</a></li><li><a href="./plain.change.json">The same diff, without a story</a></li><li><a href="./large.change.json">The 5,000-line stress case</a></li></ul></body></html>`], { type: 'text/html' })
}
