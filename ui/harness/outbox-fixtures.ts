import { WORKSPACE_HOST, WORKSPACE_UID, type WorkspaceExample } from './workspace-fixtures.js'
import type { HeldSpeech } from '../src/board/outbox.js'

/** Two questions, two reviews, three deliverables and a voice held out of view. */
export function addOutboxFixtures(example: WorkspaceExample, now: number): { held: HeldSpeech[]; dismissed: string[] } {
  const iso = (minutes: number): string => new Date(now - minutes * 60_000).toISOString()
  const rows = [
    { id: 'mask', name: 'Choose the survey mask', ask: 'Keep the conservative boundary for the next run?', minutes: 3 },
    { id: 'redshifts', name: 'Redshift calibration', ask: 'Can you check the high-redshift tail before I freeze the bins?', minutes: 17 },
    { id: 'null-tests', uid: WORKSPACE_UID, name: 'Shear null tests', outcome: 'All five null tests pass; the footprint comparison is ready.', minutes: 26 },
    { id: 'null-tests/cuts', name: 'Magnitude-cut comparison', parent: WORKSPACE_UID, outcome: 'The shift stays below 0.2 sigma.', note: 'The depth cut is ready for your eyes.', minutes: 48 },
    { id: 'pipeline', name: 'Covariance pipeline', minutes: 8 },
    { id: 'answered', name: 'A dismissed question', ask: 'This item must not appear.', minutes: 1 },
  ]
  example.feed.fibers = rows.map(row => ({
    origin: WORKSPACE_HOST, felt_store: '/fixture-store/workspace', orchestrator: row.parent,
    path: `/fixture-store/workspace/.felt/${row.id}/constitution.md`,
    fiber: { id: row.id, uid: row.uid ?? row.id, name: row.name, status: row.outcome ? 'closed' : 'active', outcome: row.outcome, created_at: iso(1440), closed_at: row.outcome ? iso(row.minutes) : undefined,
      shuttle: { kind: 'oneshot', host: WORKSPACE_HOST, project_dir: '/fixture-project', agent: 'codex-sol',
        ask: row.ask ? { text: row.ask, at: iso(row.minutes) } : undefined,
        review: row.note ? { note: row.note, at: iso(row.minutes) } : undefined,
        thread_parent: row.parent ? { uid: row.parent, host: WORKSPACE_HOST, slug: 'null-tests', name: 'Shear null tests' } : undefined } },
    runtime: row.outcome ? null : { state: 'running', phase: 'working' },
  }))
  for (const row of rows) example.bodies[row.id] = `## Desired State\n\n${row.name}.\n\n## Status\n\n${row.outcome ?? row.ask ?? 'The covariance run is ready to discuss.'}`
  const receipts = ['.png', '.html', '.pdf'].map((ext, i) => ({ ...example.receipts.find(file => String(file.fullPath).endsWith(ext))!, uid: WORKSPACE_UID, host: WORKSPACE_HOST, timestamp: now - (i * 11 + 12) * 60_000 }))
  example.receipts = receipts
  example.sessions = []; example.commits = []
  return { held: [{ fiber_id: 'pipeline', name: 'Covariance pipeline', n: 3, first: 'The final covariance is ready. I found one thing worth checking together.', at: now - 8 * 60_000 }], dismissed: [`ask:answered:${iso(1)}`] }
}
