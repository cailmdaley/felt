import { WORKSPACE_HOST, type WorkspaceExample } from './workspace-fixtures.js'
import type { HeldSpeech } from '../src/board/outbox.js'

interface Row {
  id: string
  name: string
  role?: string
  seat?: boolean
  parent?: string
  ask?: string
  review?: string
  outcome?: string
  state?: 'working' | 'draft'
  minutes: number
  tapestry?: string
}

/**
 * An audience of four offices blocked on the human: the analyst with a
 * question and a thread marked for review, beside its working threads, a sent
 * plot and report and a held spoken line; the vizier's question; the editor's
 * close awaiting review; and a moving-house constitution with no office,
 * whose thread asks. The surveyor's question was set aside, and the composer
 * has nothing blocked, so neither appears.
 */
const ROWS: Row[] = [
  { id: 'analyst-desk', name: 'Analyst’s desk', role: 'analyst', seat: true, minutes: 9000 },
  { id: 'analyst-desk/mask', name: 'Choose the survey mask', parent: 'analyst-desk', minutes: 190,
    ask: 'The conservative boundary loses **6%** of the footprint but removes the stellar-density gradient in the north. Keep it for the next run, or try the looser cut first?',
    tapestry: 'Two candidate masks for the north patch. The conservative boundary removes the gradient in the residual star–galaxy correlation; the looser one keeps 6% more area at the cost of a 0.4σ shift in S8.' },
  { id: 'analyst-desk/cuts', name: 'Magnitude-cut comparison', parent: 'analyst-desk', outcome: 'The shift stays below 0.2σ for every cut.', review: 'The depth cut is ready for your eyes; the plot is attached.', minutes: 34 },
  { id: 'analyst-desk/covariance', name: 'Covariance pipeline', parent: 'analyst-desk', state: 'working', minutes: 8 },
  { id: 'analyst-desk/redshifts', name: 'Redshift calibration', parent: 'analyst-desk', state: 'draft', minutes: 600 },
  { id: 'vizier', name: 'Vizier', role: 'vizier', seat: true, minutes: 9000 },
  { id: 'vizier/dentist', name: 'Book the dentist', role: 'vizier', minutes: 55, ask: 'Thursday at 9:30 or Friday at 14:00? Friday collides with the group meeting.' },
  { id: 'vizier/accounts', name: 'Weekly accounts', role: 'vizier', state: 'working', minutes: 12 },
  { id: 'paper-section-4', name: 'Paper II, section 4', role: 'editor', outcome: 'Section 4 is rewritten around the null tests; every number is generated from the pipeline.', minutes: 120 },
  { id: 'move', name: 'Moving house', minutes: 30000 },
  { id: 'move/van', name: 'Find a van', parent: 'move', minutes: 1500, ask: 'The 12 m³ van is free on Saturday; the 20 m³ only on Sunday. Which one?' },
  { id: 'move/boxes', name: 'Order boxes', parent: 'move', state: 'working', minutes: 40 },
  { id: 'campaign', name: 'North-field campaign', role: 'surveyor', minutes: 300, ask: 'Extend the campaign by a night?' },
  { id: 'score', name: 'Second movement', role: 'composer', state: 'working', minutes: 3 },
]

export function addOutboxFixtures(example: WorkspaceExample, now: number): { held: HeldSpeech[]; dismissed: string[] } {
  const iso = (minutes: number): string => new Date(now - minutes * 60_000).toISOString()
  const dir = (id: string): string => `/fixture-store/workspace/${id}`
  example.feed.fibers = ROWS.map(row => {
    const closed = !!row.outcome, active = !closed && row.state !== 'draft' && !row.seat
    return {
      origin: WORKSPACE_HOST, felt_store: '/fixture-store/workspace', path: `${row.id}/${row.id.split('/').at(-1)}.md`, dir: dir(row.id), orchestrator: row.parent,
      fiber: { id: row.id, uid: row.id, name: row.name, status: closed ? 'closed' : active ? 'active' : 'open', outcome: row.outcome, created_at: iso(row.minutes + 1440), closed_at: closed ? iso(row.minutes) : undefined,
        shuttle: { kind: 'oneshot', host: WORKSPACE_HOST, project_dir: '/fixture-project', agent: 'claude-opus', role: row.role, seat: row.seat,
          ask: row.ask ? { text: row.ask, at: iso(row.minutes) } : undefined,
          review: row.review ? { note: row.review, at: iso(row.minutes) } : undefined,
          thread_parent: row.parent ? { uid: row.parent, host: WORKSPACE_HOST, slug: row.parent, name: ROWS.find(parent => parent.id === row.parent)!.name } : undefined } },
      runtime: row.state === 'working' ? { state: 'running', phase: 'working', session_uuid: `session-${row.id}`, last_activity_at: now - row.minutes * 60_000 } : null,
    }
  })
  for (const row of ROWS) {
    example.bodies[row.id] = `## Desired State\n\n${row.name}.\n\n## Status\n\n${row.outcome ?? row.ask ?? 'Under way.'}`
    if (row.tapestry) {
      const page = `<!doctype html><html><head><meta charset="utf-8"><title>${row.name}</title><style>body{font:17px/1.6 Georgia,serif;margin:28px;color:#30291f;background:#fbf6e9}.map{height:42vh;display:grid;place-items:center;background:#e4dcc8;border-radius:4px;color:#6b5d45}</style></head><body><div class="map">north patch · two masks</div><h1>${row.name}</h1><p>${row.tapestry}</p></body></html>`
      example.files.push({ owner: WORKSPACE_HOST, path: `${dir(row.id)}/tapestry.html`, mime: 'text/html', body: new Blob([page], { type: 'text/html' }) })
    }
  }
  const sent = (ext: string, uid: string, minutes: number) => ({ ...example.receipts.find(file => String(file.fullPath).endsWith(ext))!, uid, host: WORKSPACE_HOST, timestamp: now - minutes * 60_000 })
  example.receipts = [sent('.png', 'analyst-desk/cuts', 30), sent('.html', 'analyst-desk/cuts', 36), sent('.pdf', 'paper-section-4', 118)]
  example.sessions = []; example.commits = []
  return {
    held: [{ fiber_id: 'analyst-desk/covariance', name: 'Covariance pipeline', n: 2, first: 'The final covariance is ready. One block of it is worth checking together.', at: now - 8 * 60_000 }],
    dismissed: [`office:role:surveyor:${Date.parse(iso(300))}`],
  }
}
