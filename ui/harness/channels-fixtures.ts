import { WORKSPACE_HOST, type WorkspaceExample } from './workspace-fixtures.js'
import type { BoardRecord } from '../src/board/channels.js'

interface Row {
  id: string
  name: string
  channel?: string
  role?: string
  seat?: boolean
  standing?: boolean
  parent?: string
  ask?: string
  review?: string
  outcome?: string
  /** A live worker: mid-turn, or idle at the end of its turn (the Desk's Your turn). */
  state?: 'working' | 'idle'
  closed?: boolean
  minutes: number
  /** Its tapestry page; `figure` names a file in its folder the page shows first. */
  tapestry?: { title: string; lede: string; figure?: string }
}

const DAY = 1440

/**
 * Channels as the board draws them. cmbx: its chair idle with a tapestry, an
 * expert posting a cross-spectrum with its plot attached, one asking, one
 * closed for review with a plot it sent, one at work with nothing to say, and
 * the chair's own posts. UNIONS, busy: a seated chair over two seated hubs, a
 * thread asking and ten more posting, last read 45 minutes ago. Vizier: two seats (the oneshot one chairs), a form asking,
 * the morning post for review. The Mill posts long. An office without a
 * channel (the composer's), hidden from the rail an hour ago; Science and
 * French at work with nothing waiting, in the human's order below what waits;
 * moving house asking for five days, a pinned garden plan, and old notes idle
 * three weeks, found only by Jump to.
 */
const ROWS: Row[] = [
  { id: 'cmbx', name: 'cmbx chair', channel: 'cmbx', seat: true, state: 'idle', minutes: 9,
    tapestry: { title: 'CMB lensing × LSS, as it stands', lede: 'κ×tSZ is measured to 9σ on the full footprint; the foreground mask and the covariance are the two calls left before the joint fit.' } },
  { id: 'cmbx/kappa-tsz', name: 'κ × tSZ cross-spectrum', parent: 'cmbx', state: 'working', minutes: 4,
    tapestry: { title: 'κ × tSZ at 9σ', lede: 'The full-footprint cross-spectrum with the new beam window; every null passes at p > 0.1.', figure: 'kappa-tsz-spectrum.svg' } },
  { id: 'cmbx/foregrounds', name: 'Cluster foreground mask', parent: 'cmbx', minutes: 22, ask: 'Masking clusters at **5σ** keeps 94% of the area and leaves a 0.3σ residual in the 1-halo term; **3σ** removes it but costs 11% of the area. Which threshold?' },
  { id: 'cmbx/covariance', name: 'Joint covariance', parent: 'cmbx', closed: true, minutes: 48, review: 'The analytic and simulation covariances agree to 4% on every block; the comparison plot is attached.', outcome: 'The joint covariance is validated against 2000 simulations.' },
  { id: 'cmbx/beam', name: 'Beam window', parent: 'cmbx', state: 'working', minutes: 2 },
  { id: 'pando/unions', name: 'UNIONS chair', channel: 'UNIONS', seat: true, state: 'idle', minutes: 80 },
  { id: 'pando/unions/east', name: 'east hub', parent: 'pando/unions', seat: true, standing: true, state: 'working', minutes: 3 },
  { id: 'pando/unions/west', name: 'west hub', parent: 'pando/unions', seat: true, state: 'working', minutes: 6 },
  { id: 'pando/unions/modes', name: "William's n(z) modes", parent: 'pando/unions/west', minutes: 35, ask: 'The modes reproduce the notebook and give calibrated S8 errors on the GLASS mock. Open the PR?' },
  { id: 'pando/unions/shear-2pt', name: 'Shear two-point functions', parent: 'pando/unions', state: 'working', minutes: 300 },
  { id: 'pando/unions/psf', name: 'PSF leakage', parent: 'pando/unions', state: 'working', minutes: 260 },
  { id: 'pando/unions/rho', name: 'Rho statistics', parent: 'pando/unions', state: 'working', minutes: 230 },
  { id: 'pando/unions/bmodes', name: 'B-mode null test', parent: 'pando/unions', state: 'working', minutes: 200 },
  { id: 'pando/unions/depth', name: 'Depth map', parent: 'pando/unions', state: 'working', minutes: 170 },
  { id: 'pando/unions/blinding', name: 'Blinding', parent: 'pando/unions', state: 'working', minutes: 150 },
  { id: 'pando/unions/chains', name: 'Cosmology chains', parent: 'pando/unions', state: 'working', minutes: 95 },
  { id: 'pando/unions/ia', name: 'Intrinsic alignments', parent: 'pando/unions', state: 'working', minutes: 70 },
  { id: 'pando/unions/photoz', name: 'Photo-z calibration', parent: 'pando/unions', state: 'working', minutes: 40 },
  { id: 'pando/unions/paper', name: 'Paper draft', parent: 'pando/unions', state: 'working', minutes: 28 },
  { id: 'life-vizier', name: 'Vizier', channel: 'Vizier', role: 'vizier', seat: true, state: 'idle', minutes: 6 },
  { id: 'morning-post', name: 'Morning post', channel: 'Vizier', seat: true, standing: true, closed: true, minutes: 140, review: 'Two letters need your reply; drafts are attached.', outcome: 'Eleven letters sorted; two need a reply from you, the rest are filed.',
    tapestry: { title: 'The morning post, sorted', lede: 'Eleven letters: two need your reply (the notary and the landlord), four are filed, five were newsletters.' } },
  { id: 'deed-form', name: 'Sign the deed form', parent: 'life-vizier', minutes: 50, ask: 'The notary needs the deed form back by Wednesday. Sign the scan in your Documents folder, or shall I book a slot to sign it in person?' },
  { id: 'mill', name: 'felt chair', channel: 'The Mill', seat: true, state: 'working', minutes: 1 },
  { id: 'mill/lander', name: 'Lander', parent: 'mill', state: 'idle', minutes: 15 },
  { id: 'score', name: 'Second movement', role: 'composer', state: 'idle', minutes: 200 },
  { id: 'science', name: 'Science desk', channel: 'Science', seat: true, state: 'working', minutes: 12 },
  { id: 'french', name: 'French lessons', channel: 'French', state: 'working', minutes: 90 },
  { id: 'move', name: 'Moving house', minutes: 5 * DAY, ask: 'The 12 m³ van is free on Saturday; the 20 m³ only on Sunday. Which one?' },
  { id: 'garden', name: 'Garden plan', minutes: 12 * DAY, outcome: 'Tomatoes go in after the last frost; the seed order is drafted.' },
  { id: 'old-notes', name: 'Old lensing notes', minutes: 21 * DAY },
]

export interface ChannelsFixture {
  dismissed: string[]
  pinned: Record<string, number>
  order: { keys: string[]; at: number } | null
  board: Array<BoardRecord & { root: string }>
}

export function addChannelsFixtures(example: WorkspaceExample, now: number): ChannelsFixture {
  const iso = (minutes: number): string => new Date(now - minutes * 60_000).toISOString()
  const ms = (minutes: number): number => now - minutes * 60_000
  const dir = (id: string): string => `/fixture-store/workspace/${id}`
  const rootOf = (id: string): string => { const row = ROWS.find(each => each.id === id)!; return row.parent ? rootOf(row.parent) : id }
  example.feed.fibers = ROWS.map(row => {
    const live = row.state === 'working' || row.state === 'idle'
    const active = !row.closed && (live || !!row.ask)
    return {
      origin: WORKSPACE_HOST, felt_store: '/fixture-store/workspace', path: `${row.id}/${row.id.split('/').at(-1)}.md`, dir: dir(row.id), orchestrator: row.parent,
      fiber: { id: row.id, uid: row.id, name: row.name, status: row.closed ? 'closed' : active ? 'active' : 'open', outcome: row.outcome, created_at: iso(row.minutes + DAY), modified_at: iso(row.minutes), closed_at: row.closed ? iso(row.minutes) : undefined,
        shuttle: { kind: row.standing ? 'standing' : 'oneshot', host: WORKSPACE_HOST, project_dir: '/fixture-project', agent: 'claude-opus', role: row.role, seat: row.seat, channel: row.channel,
          ask: row.ask ? { text: row.ask, at: iso(row.minutes) } : undefined,
          review: row.review ? { note: row.review, at: iso(row.minutes) } : undefined,
          thread_parent: row.parent ? { uid: row.parent, host: WORKSPACE_HOST, slug: row.parent, name: ROWS.find(parent => parent.id === row.parent)!.name } : undefined } },
      runtime: live ? { state: 'running', phase: row.state === 'idle' ? 'waiting' : 'working', session_uuid: `session-${row.id}`, last_activity_at: ms(row.minutes) } : null,
    }
  })
  for (const row of ROWS) {
    example.bodies[row.id] = `## Desired State\n\n${row.name}.\n\n## Status\n\n${row.outcome ?? row.ask ?? 'Under way.'}`
    if (row.tapestry) {
      const page = `<!doctype html><html><head><meta charset="utf-8"><title>${row.tapestry.title}</title><style>body{font:17px/1.6 Georgia,serif;margin:28px;color:#30291f;background:#fbf6e9}.map{height:30vh;display:grid;place-items:center;background:#e4dcc8;border-radius:4px;color:#6b5d45}</style></head><body><h1>${row.tapestry.title}</h1><p>${row.tapestry.lede}</p>${row.tapestry.figure ? `<figure><img src="${row.tapestry.figure}" alt=""></figure>` : '<div class="map">κ × tSZ, 9σ</div>'}<p>The cross-spectrum is flat to ℓ = 3000 and the 1-halo term carries most of the signal.</p></body></html>`
      example.files.push({ owner: WORKSPACE_HOST, path: `${dir(row.id)}/tapestry.html`, mime: 'text/html', body: new Blob([page], { type: 'text/html' }) })
    }
  }
  /** A file a worker wrote in its own folder and sent: a plot drawn as SVG, or a short note. */
  const wrote = (uid: string, name: string, minutes: number, title: string) => {
    const path = `${dir(uid)}/${name}`, svg = name.endsWith('.svg')
    const body = svg
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#fbf6e9"/><text x="40" y="48" font-size="22" fill="#30291f">${title}</text><path d="M60 80V340H600" fill="none" stroke="#a39478"/><path d="M80 300C200 120 320 260 440 160S560 200 590 120" fill="none" stroke="#3f8278" stroke-width="3"/></svg>`
      : `# ${title}\n\nWritten for the channel.\n`
    example.files.push({ owner: WORKSPACE_HOST, path, mime: svg ? 'image/svg+xml' : 'text/markdown', body: new Blob([body], { type: svg ? 'image/svg+xml' : 'text/markdown' }) })
    return { fullPath: path, basename: name, uid, host: WORKSPACE_HOST, sessionId: `session-${uid}`, timestamp: ms(minutes) }
  }
  const spectrum = wrote('cmbx/kappa-tsz', 'kappa-tsz-spectrum.svg', 30, 'κ × tSZ cross-spectrum')
  const nulls = wrote('cmbx/kappa-tsz', 'null-tests.md', 30, 'Null tests')
  example.receipts = [
    spectrum, nulls,
    wrote('cmbx/covariance', 'covariance-ratio.svg', 49, 'Analytic / simulated covariance'),
    wrote('cmbx', 'weekly-plan.md', 300, 'The week in cmbx'),
    wrote('pando/unions/west', 's8-posterior.svg', 60, 'S8 posterior, west run'),
    wrote('morning-post', 'reply-drafts.md', 140, 'Two replies to send'),
    wrote('old-notes', 'lensing-notes.md', 21 * DAY, 'Lensing notes'),
  ]
  example.sessions = []; example.commits = []
  let n = 0
  const said = (fiber: string, kind: string, minutes: number, over: Partial<BoardRecord> = {}): BoardRecord & { root: string } =>
    ({ id: `brd-${String(++n).padStart(3, '0')}`, type: 'board', kind, fiber, by: { fiber }, timestamp: ms(minutes), originName: WORKSPACE_HOST, root: rootOf(fiber), ...over } as BoardRecord & { root: string })
  const board = [
    said('cmbx', 'post', 300, { text: 'Three experts are on the joint fit this week: κ×tSZ, the cluster mask and the covariance. The plan is attached.', files: ['/fixture-store/workspace/cmbx/weekly-plan.md'] }),
    said('cmbx/covariance', 'post', 180, { text: 'Started the 2000-simulation run; first comparison in about two hours.' }),
    said('cmbx/kappa-tsz', 'post', 120, { text: 'First pass on the full footprint: 7σ, before the new beam.' }),
    said('cmbx/kappa-tsz', 'message', 100, { by: { fiber: 'cmbx' }, to: { fiber: 'cmbx/kappa-tsz' }, text: 'Use the new beam window from the beam thread before the final pass.' }),
    said('cmbx/kappa-tsz', 'human', 60, { by: { label: 'Sam' }, text: 'Can you also show the null tests next to the spectrum?' }),
    said('cmbx/covariance', 'closed', 48),
    said('cmbx/kappa-tsz', 'post', 30, { text: 'κ×tSZ is measured to **9σ** with the new beam. The spectrum and the null tests are attached; every null passes at p > 0.1.', files: [spectrum.fullPath, nulls.fullPath] }),
    said('cmbx/foregrounds', 'asked', 22, { text: ROWS.find(row => row.id === 'cmbx/foregrounds')!.ask }),
    said('cmbx', 'post', 12, { text: 'Two calls for you today: the cluster mask threshold and the covariance review. Everything else is moving.' }),
    // A line the human sent from the board, recorded under the id the board gave it.
    said('cmbx', 'human', 10, { id: 'brd-human-0001', by: { label: 'Sam' }, text: 'Thanks — I will look after lunch.' }),
    said('pando/unions/shear-2pt', 'post', 300, { text: 'ξ± measured on all 6 tomographic bins; the covariance from the GLASS mocks is attached next.' }),
    said('pando/unions/psf', 'post', 260, { text: 'Leakage α = 0.012 ± 0.004 after the new PSF model; the correction is applied.' }),
    said('pando/unions/rho', 'post', 230, { text: 'ρ₁ through ρ₅ are consistent with zero on every scale.' }),
    said('pando/unions/bmodes', 'post', 200, { text: 'The B-mode null passes, χ²/dof = 1.04 over 24 bins.' }),
    said('pando/unions/depth', 'post', 170, { text: 'The depth map is rebuilt with the r-band masks; 3% of the footprint drops below the cut.' }),
    said('pando/unions/blinding', 'post', 150, { text: 'The blinded data vector is ready for the chains; the key stays with you.' }),
    said('pando/unions/chains', 'post', 95, { text: 'Chains converged (R−1 < 0.01) on the blinded vector; posteriors match the mock run.' }),
    said('pando/unions/ia', 'post', 70, { text: 'NLA and TATT give the same S8 within 0.2σ; TATT stays the default.' }),
    said('pando/unions/photoz', 'post', 40, { text: 'The SOM calibration moves the mean of bin 5 by 0.008; still inside the prior.' }),
    said('pando/unions/paper', 'post', 28, { text: 'Section 3 is drafted around the null tests; every number comes from the pipeline.' }),
    said('pando/unions', 'post', 18, { text: 'Morning round: chains converged, photo-z within the prior, the paper draft moving. One ask for you on the n(z) modes.' }),
    said('pando/unions/west', 'post', 60, { text: 'The west run finished: S8 = 0.781 ± 0.019. The posterior is attached.', files: ['/fixture-store/workspace/pando/unions/west/s8-posterior.svg'] }),
    said('pando/unions/east', 'handed_off', 45),
    said('pando/unions/modes', 'asked', 35, { text: ROWS.find(row => row.id === 'pando/unions/modes')!.ask }),
    said('deed-form', 'asked', 50, { text: ROWS.find(row => row.id === 'deed-form')!.ask }),
    said('morning-post', 'closed', 140),
    said('mill', 'post', 25, { text: [
      'Landed the routing slice on main and deployed it to the Mac; the fleet catch-up waits on you.',
      '',
      '- The unblock board lines now append on every poll from the stored record, so an owed line no longer depends on the thread still waiting on its blocker.',
      '- A retry never appends a later poll\'s rendering, and an offered entry expires with the line it owes.',
      '- Recording the append keeps the entry\'s modification time.',
      '',
      'CI is green on Linux and the Mac. Two follow-ups are filed: the board\'s family read should page past the 14-day reach, and the hook digest should name the human by their label.',
      '',
      'Nothing else is blocked; the lander is idle until the next landing.',
    ].join('\n') }),
    said('mill/lander', 'post', 15, { text: 'Landed 58bda2a3d on main.' }),
  ]
  // UNIONS was last read 45 minutes ago, so what came since sits under a New rule.
  try { localStorage.setItem('shuttle.channels.seen:channel:unions', String(ms(45))) } catch { /* The rule is a convenience. */ }
  return {
    dismissed: [`hide:role:composer:${ms(60)}`],
    pinned: { 'fiber:garden': now - 3 * 86_400_000 },
    // The human put French above Science, and the garden plan last.
    order: { keys: ['channel:french', 'channel:science', 'fiber:garden'], at: ms(DAY) },
    board,
  }
}
