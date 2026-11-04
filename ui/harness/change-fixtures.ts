import dogfood from './fixtures/dogfood.change.json'
import type { ChangeBundle } from '../src/board/workspace/changeModel.js'
import { WORKSPACE_HOST, WORKSPACE_ID, WORKSPACE_REPORT, WORKSPACE_UID, type WorkspaceExample } from './workspace-fixtures.js'

/** Real repository snapshot plus no-story and long-file reading probes. */
export function addChangeFixtures(fixture: WorkspaceExample, now: number): void {
  const bundle = dogfood as ChangeBundle
  const dir = WORKSPACE_REPORT.slice(0, WORKSPACE_REPORT.lastIndexOf('/'))
  const large: ChangeBundle = { ...bundle, title: 'A 5,000-line changed file', head: '5'.repeat(40), story: null,
    patch: `diff --git a/src/large.ts b/src/large.ts\n--- a/src/large.ts\n+++ b/src/large.ts\n@@ -1,5000 +1,5000 @@\n${Array.from({ length: 5000 }, (_, n) => `-export const value${n + 1} = ${n};\n+export const value${n + 1} = ${n + 1};`).join('\n')}\n`,
    files: [{ path: 'src/large.ts', role: 'implementation', status: 'modified', additions: 5000, deletions: 5000 }],
  }
  for (const [name, change] of [['family', bundle], ['plain', { ...bundle, title: 'The same snapshot, without a story', story: null }], ['large', large]] as const) {
    const path = `${dir}/${name}.change.json`
    fixture.files.push({ owner: WORKSPACE_HOST, path, mime: 'application/json', body: new Blob([JSON.stringify(change)], { type: 'application/json' }) })
    fixture.receipts.push({ ...fixture.receipts[0], uid: WORKSPACE_UID, fiber: WORKSPACE_ID, host: WORKSPACE_HOST, fullPath: path, basename: `${name}.change.json`, timestamp: now - 15_000 })
  }
  const report = fixture.files.find(file => file.path === WORKSPACE_REPORT)!
  report.body = new Blob([`<!doctype html><html><head><title>Read the family change</title><style>body{font:18px/1.6 system-ui;max-width:680px;margin:80px auto;padding:24px;color:light-dark(#272720,#e2e2da);background:light-dark(#f6f5f0,#242421);color-scheme:light dark}a{color:inherit}li{margin:24px 0}small{opacity:.7}</style></head><body><small>FELT / CHANGE REVIEW</small><h1>A family’s root stays in sight.</h1><p>This is a real five-commit snapshot of felt. Read the story first, then check the tests and the edits the story doesn’t cover.</p><ul><li><a href="./family.change.json">Read the change →</a></li><li><a href="./plain.change.json">The same diff, without a story</a></li><li><a href="./large.change.json">The 5,000-line stress case</a></li></ul></body></html>`], { type: 'text/html' })
  fixture.bodies[WORKSPACE_ID] += '\n\n:::{embed} family.change.json\n:title: Family change\n:::\n'
}
