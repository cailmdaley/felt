import { WORKSPACE_HOST, type WorkspaceExample } from './workspace-fixtures.js'
import type { HeldSpeech } from '../src/board/channels.js'

interface Row {
  id: string
  name: string
  role?: string
  seat?: boolean
  parent?: string
  ask?: string
  review?: string
  outcome?: string
  /** A live worker: mid-turn, or idle at the end of its turn (the Desk's Your turn). */
  state?: 'working' | 'idle' | 'draft'
  minutes: number
  tapestry?: string
}

const DAY = 1440

/**
 * Channels as the Channels view draws them. The analyst office's cosmic-shear
 * orchestrator is idle at the end of its turn, with a thread asking, one
 * closed for review, one idle, quiet threads beside them (one of them an
 * editor's), a sent plot and report and a held spoken line. The vizier office
 * holds four top-level constitutions: the seat idle at the end of its turn, a
 * deed form asking, the morning post closed for review, and the dream at
 * work. The editor's paper section waits for review; the composer is idle;
 * moving house (no office) last asked five days ago, so it has gone cold; the
 * garden plan waits on nothing but is pinned. The surveyor's question was set
 * aside.
 */
const ROWS: Row[] = [
  { id: 'shear', name: 'UNIONS cosmic shear', role: 'analyst', state: 'idle', minutes: 12,
    outcome: 'The B-mode null passes on every scale; the mask choice and the depth cut are the last two calls before the S8 unblinding.',
    tapestry: 'Cosmic shear from UNIONS, as it stands. The two-point functions are measured on 3500 deg²; B modes pass the null; the north mask and the depth cut wait on decisions before unblinding.' },
  { id: 'shear/mask', name: 'Choose the survey mask', parent: 'shear', minutes: 25,
    ask: 'The conservative boundary loses **6%** of the footprint but removes the stellar-density gradient in the north. Keep it for the next run, or try the looser cut first?',
    tapestry: 'Two candidate masks for the north patch. The conservative boundary removes the gradient in the residual star–galaxy correlation; the looser one keeps 6% more area at the cost of a 0.4σ shift in S8.' },
  { id: 'shear/cuts', name: 'Magnitude-cut comparison', parent: 'shear', outcome: 'The shift stays below 0.2σ for every cut.', review: 'The depth cut is ready for your eyes; the plot is attached.', minutes: 34 },
  { id: 'shear/psf', name: 'PSF leakage', parent: 'shear', state: 'idle', minutes: 95, outcome: 'Leakage α is 0.012 ± 0.004; the correction is applied and the residual is flat.' },
  { id: 'shear/covariance', name: 'Covariance pipeline', parent: 'shear', state: 'working', minutes: 8 },
  { id: 'shear/methods', name: 'Methods section', role: 'editor', parent: 'shear', state: 'working', minutes: 160, outcome: 'The estimator and the blinding are written up; the mask paragraph waits on the mask.' },
  { id: 'shear/redshifts', name: 'Redshift calibration', parent: 'shear', state: 'draft', minutes: 600 },
  { id: 'shear/rho', name: 'Rho statistics', parent: 'shear', outcome: 'ρ₁ through ρ₅ are consistent with zero.', minutes: 300 },
  { id: 'life-vizier', name: 'Vizier', role: 'vizier', seat: true, state: 'idle', minutes: 6, outcome: 'Your week: the dentist is booked for Thursday; rent goes out Monday; two forms need you.',
    tapestry: 'The week at a glance: Thursday the dentist at 9:30, Friday the group meeting, Monday the rent. Two forms wait on a signature.' },
  { id: 'deed-form', name: 'Sign the deed form', role: 'vizier', minutes: 50, ask: 'The notary needs the deed form back by Wednesday. Sign the scan I put in your Documents folder, or shall I book a slot to sign it in person?' },
  { id: 'morning-post', name: 'Morning post', role: 'vizier', outcome: 'Eleven letters sorted; two need a reply from you, the rest are filed.', review: 'Two letters need your reply; drafts are attached.', minutes: 140 },
  { id: 'dream', name: 'Dream', role: 'vizier', state: 'working', minutes: 20 },
  { id: 'paper-section-4', name: 'Paper II, section 4', role: 'editor', outcome: 'Section 4 is rewritten around the null tests; every number is generated from the pipeline.', minutes: 120 },
  { id: 'score', name: 'Second movement', role: 'composer', state: 'idle', minutes: 200, outcome: 'The development section is drafted; the modulation to the relative minor is the open question.' },
  { id: 'move', name: 'Moving house', minutes: 30 * DAY },
  { id: 'move/van', name: 'Find a van', parent: 'move', minutes: 5 * DAY, ask: 'The 12 m³ van is free on Saturday; the 20 m³ only on Sunday. Which one?' },
  { id: 'move/boxes', name: 'Order boxes', parent: 'move', state: 'working', minutes: 40 },
  { id: 'garden', name: 'Garden plan', state: 'working', minutes: 70, outcome: 'Tomatoes go in after the last frost; the seed order is drafted.' },
  { id: 'campaign', name: 'North-field campaign', role: 'surveyor', minutes: 300, ask: 'Extend the campaign by a night?' },
]

export function addChannelsFixtures(example: WorkspaceExample, now: number): { held: HeldSpeech[]; dismissed: string[]; pinned: Record<string, number> } {
  const iso = (minutes: number): string => new Date(now - minutes * 60_000).toISOString()
  const dir = (id: string): string => `/fixture-store/workspace/${id}`
  example.feed.fibers = ROWS.map(row => {
    const closed = !!row.outcome && !row.state, live = row.state === 'working' || row.state === 'idle'
    const active = !closed && row.state !== 'draft' && !row.seat
    return {
      origin: WORKSPACE_HOST, felt_store: '/fixture-store/workspace', path: `${row.id}/${row.id.split('/').at(-1)}.md`, dir: dir(row.id), orchestrator: row.parent,
      fiber: { id: row.id, uid: row.id, name: row.name, status: closed ? 'closed' : active ? 'active' : 'open', outcome: row.outcome, created_at: iso(row.minutes + DAY), closed_at: closed ? iso(row.minutes) : undefined,
        shuttle: { kind: 'oneshot', host: WORKSPACE_HOST, project_dir: '/fixture-project', agent: 'claude-opus', role: row.role, seat: row.seat,
          ask: row.ask ? { text: row.ask, at: iso(row.minutes) } : undefined,
          review: row.review ? { note: row.review, at: iso(row.minutes) } : undefined,
          thread_parent: row.parent ? { uid: row.parent, host: WORKSPACE_HOST, slug: row.parent, name: ROWS.find(parent => parent.id === row.parent)!.name } : undefined } },
      runtime: live ? { state: 'running', phase: row.state === 'idle' ? 'waiting' : 'working', session_uuid: `session-${row.id}`, last_activity_at: now - row.minutes * 60_000 } : null,
    }
  })
  for (const row of ROWS) {
    example.bodies[row.id] = `## Desired State\n\n${row.name}.\n\n## Status\n\n${row.outcome ?? row.ask ?? 'Under way.'}`
    if (row.tapestry) {
      const page = `<!doctype html><html><head><meta charset="utf-8"><title>${row.name}</title><style>body{font:17px/1.6 Georgia,serif;margin:28px;color:#30291f;background:#fbf6e9}.map{height:42vh;display:grid;place-items:center;background:#e4dcc8;border-radius:4px;color:#6b5d45}</style></head><body><div class="map">${row.name}</div><h1>${row.name}</h1><p>${row.tapestry}</p></body></html>`
      example.files.push({ owner: WORKSPACE_HOST, path: `${dir(row.id)}/tapestry.html`, mime: 'text/html', body: new Blob([page], { type: 'text/html' }) })
    }
  }
  const sent = (ext: string, uid: string, minutes: number) => ({ ...example.receipts.find(file => String(file.fullPath).endsWith(ext))!, uid, host: WORKSPACE_HOST, timestamp: now - minutes * 60_000 })
  example.receipts = [sent('.png', 'shear/cuts', 30), sent('.html', 'shear/cuts', 36), sent('.pdf', 'paper-section-4', 118)]
  example.sessions = []; example.commits = []
  return {
    held: [{ fiber_id: 'shear/covariance', name: 'Covariance pipeline', n: 2, first: 'The final covariance is ready. One block of it is worth checking together.', at: now - 8 * 60_000 }],
    dismissed: [`office:role:surveyor:${Date.parse(iso(300))}`],
    pinned: { 'fiber:garden': now - 3 * 86_400_000 },
  }
}
