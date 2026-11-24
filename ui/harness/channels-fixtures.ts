import { WORKSPACE_HOST, type WorkspaceExample } from './workspace-fixtures.js'
import type { BoardRecord } from '../src/board/boardFeed.js'

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
  /** A live worker: mid-turn, or idle at the end of its turn (Working on the Desk either way). */
  state?: 'working' | 'idle'
  /** Its live worker has a terminal, so its conversation opens. */
  terminal?: boolean
  closed?: boolean
  minutes: number
  /** Its tapestry page; `figure` names a file in its folder the page shows first. */
  tapestry?: { title: string; lede: string; figure?: string; slide?: boolean; heavy?: boolean }
  /** Put to rest (`horizon: stashed`), until this civil day when one is named. */
  rest?: string | true
  /** Armed with no worker: a standing one asleep until its next run. */
  armed?: boolean
  /** Its last launch could not start, and why. */
  blocked?: string
}

const DAY = 1440
/** The human, as a board address: a label with no fiber or session. */
const HUMAN = { label: 'Sam' }
/** A deck's first slide drawn inline as a portrait page, as a tapestry built from slides shows it. */
const SLIDE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 794 1123" width="100%"><rect width="794" height="1123" fill="#fbf6e9"/><text x="60" y="140" font-size="54" fill="#30291f">UNIONS cosmic shear</text><text x="60" y="210" font-size="30" fill="#6b5d45">Paris SWG · Thursday</text><path d="M80 900V400H720" fill="none" stroke="#a39478" stroke-width="3"/><path d="M100 820C260 520 420 760 560 560S680 620 710 480" fill="none" stroke="#3f8278" stroke-width="6"/></svg>'

/**
 * A tapestry as heavy as the fleet's heaviest (about 1.4 MB): forty plots of
 * fifteen hundred points each, inline, between paragraphs, as a worker's
 * page of every block of a covariance is.
 */
function heavyFigures(): string {
  const plot = (n: number): string => {
    let y = 200, d = 'M0 200'
    for (let i = 1; i <= 1500; i++) { y = Math.max(20, Math.min(380, y + Math.sin(i * 0.05 + n) * 6 + Math.cos(i * 0.31 * (n + 1)) * 4)); d += `L${(i * 0.4).toFixed(1)} ${y.toFixed(1)}` }
    return `<figure><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" width="100%"><rect width="600" height="400" fill="#f1e9d6"/><path d="${d}" fill="none" stroke="#3f8278" stroke-width="1.5"/></svg><figcaption>Block ${n + 1}: analytic over simulated, by bin pair.</figcaption></figure><p>Block ${n + 1} agrees to ${(2 + (n % 5) * 0.4).toFixed(1)}% across every bin pair; the off-diagonal terms follow the simulations to within their noise, and the shot-noise floor is where the analytic model puts it.</p>`
  }
  return Array.from({ length: 40 }, (_, n) => plot(n)).join('')
}

/**
 * Channels as the board draws them. cmbx: its chair idle with a tapestry,
 * posting to the human and answered; an expert posting its cross-spectrum to
 * the human with its plots attached; one asking its chair; one closed to its
 * chair and marked for the human's review; one at work with nothing to say.
 * UNIONS, busy: a seated chair over two seated hubs at work and two at
 * rest, its post to the human unanswered, a hub posting a figure to the
 * human, a thread asking and ten more posting to their chair; a weekly
 * standing thread between runs, a draft and a thread put to rest sit quiet.
 * Vizier: two seats (the oneshot one chairs), a
 * form asking, the morning post closed with a closing post and its
 * attachment. The Mill posts long to the human, who answered. The
 * composer's channel, hidden from the rail an hour ago;
 * Science and French at work with nothing waiting, in the human's order
 * below what waits; moving house asking for five days, a pinned garden plan,
 * and old notes idle three weeks, found only by Jump to. Three name no
 * channel and speak in misc: a journal club at work, a working group and a
 * flight check-in quiet.
 */
const ROWS: Row[] = [
  { id: 'cmbx', name: 'cmbx chair', channel: 'cmbx', seat: true, state: 'idle', terminal: true, minutes: 9,
    tapestry: { title: 'CMB lensing × LSS, as it stands', lede: 'κ×tSZ is measured to 9σ on the full footprint; the foreground mask and the covariance are the two calls left before the joint fit.' } },
  { id: 'cmbx/kappa-tsz', name: 'κ × tSZ cross-spectrum', parent: 'cmbx', state: 'working', minutes: 4,
    tapestry: { title: 'κ × tSZ at 9σ', lede: 'The full-footprint cross-spectrum with the new beam window; every null passes at p > 0.1.', figure: 'kappa-tsz-spectrum.svg' } },
  { id: 'cmbx/foregrounds', name: 'Cluster foreground mask', parent: 'cmbx', minutes: 22, ask: 'Masking clusters at **5σ** keeps 94% of the area and leaves a 0.3σ residual in the 1-halo term; **3σ** removes it but costs 11% of the area. Which threshold?' },
  { id: 'cmbx/covariance', name: 'Joint covariance', parent: 'cmbx', closed: true, minutes: 48,
    tapestry: { title: 'Joint covariance, block by block', lede: 'The analytic and simulated covariances agree to 4% on every block of the joint data vector.', heavy: true }, review: 'The analytic and simulation covariances agree to 4% on every block; the comparison plot is attached.', outcome: 'The joint covariance is validated against 2000 simulations.' },
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
  { id: 'pando/unions/paper', name: 'Paper draft', parent: 'pando/unions', state: 'working', minutes: 28,
    tapestry: { title: 'Paris SWG deck', lede: 'Twelve slides for Thursday: the null tests, the blinded S8 and what is left before unblinding.', slide: true } },
  { id: 'pando/unions/north', name: 'north hub', parent: 'pando/unions', role: 'hub', seat: true, minutes: 2 * DAY },
  { id: 'pando/unions/south', name: 'south hub', parent: 'pando/unions', role: 'hub', seat: true, minutes: 3 * DAY },
  { id: 'pando/unions/weekly', name: 'Weekly shear digest', parent: 'pando/unions', standing: true, armed: true, minutes: 2 * DAY },
  { id: 'pando/unions/glass', name: 'GLASS mock refresh', parent: 'pando/unions', minutes: DAY },
  { id: 'pando/unions/star-gal', name: 'Star-galaxy separation', parent: 'pando/unions', rest: true, minutes: 6 * DAY },
  { id: 'vizier', name: 'Vizier', channel: 'Vizier', role: 'vizier', seat: true, state: 'idle', minutes: 6 },
  { id: 'morning-post', name: 'Morning post', channel: 'Vizier', seat: true, standing: true, closed: true, minutes: 140, outcome: 'Eleven letters sorted; two need a reply from you, the rest are filed.',
    tapestry: { title: 'The morning post, sorted', lede: 'Eleven letters: two need your reply (the notary and the landlord), four are filed, five were newsletters.' } },
  // Closed to the human with no tapestry: its close is only its line.
  { id: 'insurance', name: 'Renew the insurance', parent: 'vizier', closed: true, minutes: 200, outcome: 'Renewed for a year at the same premium; the new policy is filed.' },
  { id: 'deed-form', name: 'Sign the deed form', parent: 'vizier', minutes: 50, ask: 'The notary needs the deed form back by Wednesday. Sign the scan in your Documents folder, or shall I book a slot to sign it in person?' },
  { id: 'felt', name: 'The Mill', channel: 'The Mill', seat: true, state: 'working', minutes: 1 },
  { id: 'felt/lander', name: 'Lander', parent: 'felt', state: 'idle', minutes: 15 },
  { id: 'score', name: 'Second movement', channel: 'Composer', role: 'composer', state: 'idle', minutes: 200 },
  { id: 'science', name: 'Science desk', channel: 'Science', seat: true, state: 'working', minutes: 12 },
  { id: 'french', name: 'French lessons', channel: 'French', state: 'working', minutes: 90 },
  { id: 'move', name: 'Moving house', channel: 'Move', minutes: 5 * DAY, ask: 'The 12 m³ van is free on Saturday; the 20 m³ only on Sunday. Which one?' },
  { id: 'garden', name: 'Garden plan', channel: 'Garden', minutes: 12 * DAY, outcome: 'Tomatoes go in after the last frost; the seed order is drafted.' },
  { id: 'old-notes', name: 'Old lensing notes', channel: 'Old-notes', minutes: 21 * DAY },
  { id: 'journal-club', name: 'CosmoStat journal club', state: 'working', minutes: 25 },
  { id: 'tools-wg', name: 'IAP tools working group', minutes: 3 * 60 },
  { id: 'check-in', name: 'Flight check-in', minutes: 2 * DAY },
]

export interface ChannelsFixture {
  dismissed: string[]
  pinned: Record<string, number>
  order: { keys: string[]; at: number } | null
  board: Array<BoardRecord & { root: string }>
  /** What the daemon answers as waiting: each fiber's newest line, when it is addressed to the human and nothing of theirs came after it. */
  waiting: Record<string, { id: string; at: number }>
}

/** A figure as a worker draws one: a plot `width` by `height`, titled. */
const plot = (title: string, width = 640, height = 400): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#fbf6e9"/><text x="32" y="44" font-size="22" fill="#30291f">${title}</text><path d="M56 70V${height - 50}H${width - 30}" fill="none" stroke="#a39478"/><path d="M70 ${height - 90}C${width * .3} ${height * .3} ${width * .5} ${height * .7} ${width * .7} ${height * .4}S${width * .85} ${height * .5} ${width - 40} ${height * .3}" fill="none" stroke="#3f8278" stroke-width="3"/></svg>`

/**
 * The channels, and UNIONS as a busy stream: a dozen of its threads post to
 * the human through the day, several with files (figures, a tall one among
 * them, an HTML page, Markdown notes), the chains thread twice within a few
 * minutes; the human answered about half of them, and the n(z) modes thread
 * still asks.
 */
export function addChannelsFixtures(example: WorkspaceExample, now: number): ChannelsFixture {
  return addBoardFixtures(example, now, ROWS, (said, human, send) => {
    const dir = (id: string): string => `/fixture-store/workspace/pando/unions/${id}`
    const xi = send(`${dir('shear-2pt')}/xi-pm.svg`, plot('ξ± on six tomographic bins'), 292)
    const leak = send(`${dir('psf')}/leakage.svg`, plot('PSF leakage α by bin'), 256)
    const nulls = send(`${dir('bmodes')}/bmode-nulls.md`, '# B-mode nulls\n\nχ²/dof = 1.04 over 24 bins; every bin passes.\n', 196)
    const depth = send(`${dir('depth')}/depth-map.html`, '<!doctype html><html><head><title>Depth map, r band</title><style>body{margin:0;font:16px/1.5 Georgia,serif;background:#fbf6e9;color:#30291f}main{padding:28px 36px}h1{margin:0 0 8px}.map{height:300px;margin-top:16px;border-radius:6px;background:radial-gradient(circle at 30% 40%,#3f8278,#a39478 55%,#e4dcc8)}</style></head><body><main><h1>Depth map, r band</h1><p>Rebuilt with the r-band masks; 3% of the footprint falls below the cut.</p><div class="map"></div></main></body></html>', 166)
    const posterior = send(`${dir('chains')}/s8-omegam.svg`, plot('S8 × Ωm, blinded'), 100)
    const chainNotes = send(`${dir('chains')}/convergence.md`, '# Convergence\n\nR−1 < 0.01 on every parameter after 40k steps.\n', 100)
    const ia = send(`${dir('ia')}/nla-tatt.svg`, plot('NLA vs TATT', 360, 520), 69)
    const tally: Array<[string, number, string, string[]?, boolean?]> = [
      ['shear-2pt', 292, 'ξ± is measured on all six bins; the plot is attached.', [xi]],
      ['psf', 256, 'Leakage is down to **α = 0.012 ± 0.004** after the new PSF model.', [leak], true],
      ['rho', 226, 'ρ₁ through ρ₅ are consistent with zero on every scale. Nothing for you to decide.'],
      ['bmodes', 196, 'The B-mode null passes; the per-bin table is in the notes.', [nulls], true],
      ['depth', 166, 'The depth map is rebuilt; 3% of the footprint falls below the cut. The page shows where.', [depth]],
      ['blinding', 146, 'The blinded data vector is ready; the key stays with you.', undefined, true],
      ['chains', 100, 'Chains converged on the blinded vector. Posterior and convergence notes attached.', [posterior, chainNotes]],
      ['chains', 97, 'One more: the run used the GLASS covariance, not the analytic one, as we agreed.'],
      ['ia', 69, 'NLA and TATT agree on S8 within 0.2σ; TATT stays the default.', [ia], true],
      ['photoz', 41, 'The SOM calibration moves bin 5 by 0.008, inside the prior.'],
      ['paper', 29, 'Section 3 is drafted around the null tests.'],
    ]
    // The Mill over the board's whole reach, as the real one reads: three posts a day to the human and the lander's handoffs between.
    const mill = Array.from({ length: 13 }, (_, day) => day + 1).flatMap(day => [
      said('felt', 'post', day * DAY + 600, { to: human, text: `Morning round, day ${day}: two slices landed and deployed, one review pending.` }),
      said('felt', 'post', day * DAY + 300, { to: human, text: `Landed the slice of day ${day} on main; both hubs run it.` }),
      said('felt', 'post', day * DAY + 60, { to: human, text: `Evening: the lander is idle; tomorrow's slice is filed.` }),
      said('felt/lander', 'handed_off', day * DAY + 400),
      said('felt/lander', 'handed_off', day * DAY + 120),
    ])
    return [...mill, ...tally.flatMap(([id, minutes, text, files, answered]) => [
      said(`pando/unions/${id}`, 'post', minutes, { to: human, text, ...files ? { files } : {} }),
      ...answered ? [said(`pando/unions/${id}`, 'human', minutes - 2, { by: human, text: 'Thanks.' })] : [],
    ])]
  })
}

/**
 * The Desk at work, over the channels' fixture: a survey family whose two
 * leaves three levels down wait on the human (one asks, one posted to them
 * with a ✓ to clear it) beside its working threads and an idle worker; a
 * notebook whose live worker is idle, asking nothing, so it works; a launch
 * that could not start; a paper closed for the human's review; and, quiet,
 * a draft, a rest until a day, a standing digest asleep until its next run,
 * a paused arXiv watch and a seat at rest. Two families name their live
 * members: career futures, closed for review, its seminar deck at work two
 * levels down and its applications idle; and kinematic lensing, nine
 * threads live under a working top-level.
 */
export function addDeskFixtures(example: WorkspaceExample, now: number): ChannelsFixture {
  const rows: Row[] = [
    ...ROWS,
    { id: 'survey', name: 'Survey pipeline', state: 'idle', minutes: 3, ask: 'The shapes and photo-z branches both touch the catalogue schema; merge shapes first, or hold both until the run ends?' },
    { id: 'survey/catalogue', name: 'Catalogue', parent: 'survey', state: 'working', minutes: 5 },
    { id: 'survey/catalogue/shapes', name: 'Shape measurement', parent: 'survey/catalogue', state: 'working', minutes: 8 },
    { id: 'survey/catalogue/shapes/psf', name: 'PSF model', parent: 'survey/catalogue/shapes', minutes: 14, ask: 'The second-moment PSF leaves a 0.4% residual at the chip edges; the pixel model removes it but doubles the run time. Which one?' },
    { id: 'survey/catalogue/shapes/selection', name: 'Selection bias', parent: 'survey/catalogue/shapes', state: 'idle', minutes: 7 },
    { id: 'survey/catalogue/photoz', name: 'Photo-z', parent: 'survey/catalogue', state: 'working', minutes: 11 },
    { id: 'survey/maps', name: 'Mass maps', parent: 'survey', state: 'idle', minutes: 26 },
    { id: 'notebook', name: 'Lab notebook', state: 'idle', minutes: 18 },
    { id: 'rerun', name: 'Rerun the mocks', minutes: 33, blocked: 'No project directory on this host: choose one to start.' },
    { id: 'abstract', name: 'Conference abstract', minutes: 2 * DAY },
    { id: 'reading', name: 'Reading list', minutes: 4 * DAY, rest: '2026-12-01' },
    { id: 'digest', name: 'Weekly digest', standing: true, armed: true, minutes: 3 * DAY },
    { id: 'arxiv', name: 'arXiv watch', standing: true, rest: true, minutes: 6 * DAY },
    { id: 'referee', name: 'Referee desk', role: 'referee', seat: true, minutes: 9 * DAY },
    { id: 'paper', name: 'Lensing paper', closed: true, minutes: 95, review: 'Section 4 is rewritten around the new covariance; read the diff against v2.', outcome: 'The draft is ready for co-authors.' },
    { id: 'career-futures', name: 'Career futures', channel: 'Career', closed: true, minutes: 240, review: 'The two-year plan is written; the fellowship list is ranked.', outcome: 'A plan for the next two years, with three applications to draft.' },
    { id: 'career-futures/applications', name: 'Fellowship applications', parent: 'career-futures', state: 'idle', minutes: 45, outcome: 'The research statement is drafted; the budget waits on the host institute.' },
    { id: 'career-futures/talks', name: 'Talks', parent: 'career-futures', minutes: 3 * DAY },
    { id: 'career-futures/talks/ice-seminar', name: 'ICE seminar deck', parent: 'career-futures/talks', state: 'working', minutes: 1, outcome: 'Slides 1–14 are drafted; the kinematic lensing forecast is next.' },
    { id: 'kinematic', name: 'Kinematic lensing', state: 'working', minutes: 4 },
    { id: 'kinematic/rotation', name: 'Rotation curves', parent: 'kinematic', state: 'working', minutes: 2, outcome: 'Fitting arctan curves to the 412 MaNGA disks.' },
    { id: 'kinematic/tully-fisher', name: 'Tully–Fisher prior', parent: 'kinematic', state: 'idle', minutes: 31, outcome: 'The prior scatter is 0.05 dex after the inclination cut.' },
    { id: 'kinematic/shape-noise', name: 'Shape noise', parent: 'kinematic', state: 'working', minutes: 6 },
    { id: 'kinematic/ifu-sims', name: 'IFU simulations', parent: 'kinematic', state: 'working', minutes: 9, outcome: 'Rendering the second batch of mock datacubes.' },
    { id: 'kinematic/ifu-sims/psf', name: 'IFU PSF', parent: 'kinematic/ifu-sims', state: 'idle', minutes: 52 },
    { id: 'kinematic/forecast', name: 'Fisher forecast', parent: 'kinematic', state: 'working', minutes: 14, outcome: 'σ(γ) per galaxy is 0.021 against 0.26 for weak lensing alone.' },
    { id: 'kinematic/systematics', name: 'Systematics budget', parent: 'kinematic', state: 'idle', minutes: 75 },
    { id: 'kinematic/velocity-maps', name: 'Velocity maps', parent: 'kinematic', state: 'working', minutes: 3 },
    { id: 'kinematic/paper', name: 'Kinematic lensing paper', parent: 'kinematic', state: 'idle', minutes: 120, outcome: 'The introduction and the method section are drafted.' },
  ]
  return addBoardFixtures(example, now, rows, (said, human) => [
    said('survey/catalogue/shapes/selection', 'post', 6, { to: human, text: 'The selection bias is **0.3%** after the new cuts; the plot is in the folder. Nothing to decide.' }),
    said('survey/catalogue/shapes/psf', 'asked', 14, { to: { fiber: 'survey/catalogue/shapes' }, text: rows.find(row => row.id === 'survey/catalogue/shapes/psf')!.ask }),
  ])
}

type Say = (fiber: string, kind: string, minutes: number, over?: Partial<BoardRecord>) => BoardRecord & { root: string }

/** A file a worker wrote and sent the human `minutes` ago: its path, which a line may attach. */
type Send = (path: string, body: string, minutes: number) => string

function addBoardFixtures(example: WorkspaceExample, now: number, ROWS: Row[], more: (said: Say, human: typeof HUMAN, send: Send) => Array<BoardRecord & { root: string }>): ChannelsFixture {
  const iso = (minutes: number): string => new Date(now - minutes * 60_000).toISOString()
  const ms = (minutes: number): number => now - minutes * 60_000
  const dir = (id: string): string => `/fixture-store/workspace/${id}`
  const rootOf = (id: string): string => { const row = ROWS.find(each => each.id === id)!; return row.parent ? rootOf(row.parent) : id }
  // Every row has run: a live one since its launch, a stopped one until it handed off, a while before its last word.
  const launched = (row: Row, n: number): number => row.minutes + 25 + (n * 37) % 140
  example.feed.fibers = ROWS.map((row, n) => {
    const live = row.state === 'working' || row.state === 'idle'
    const active = !row.closed && !row.rest && (live || !!row.ask || !!row.armed || !!row.blocked)
    return {
      origin: WORKSPACE_HOST, felt_store: '/fixture-store/workspace', path: `${row.id}/${row.id.split('/').at(-1)}.md`, dir: dir(row.id), orchestrator: row.parent,
      dispatch_error: row.blocked,
      fiber: { id: row.id, uid: row.id, name: row.name, status: row.closed ? 'closed' : active ? 'active' : 'open', outcome: row.outcome, created_at: iso(row.minutes + DAY), modified_at: iso(row.minutes), closed_at: row.closed ? iso(row.minutes) : undefined,
        horizon: row.rest ? 'stashed' : undefined, due: typeof row.rest === 'string' ? row.rest : undefined,
        shuttle: { runtime: { dispatched_at: iso(launched(row, n)), handed_off_at: live ? undefined : iso(row.minutes) },
          kind: row.standing ? 'standing' : 'oneshot', host: WORKSPACE_HOST, project_dir: '/fixture-project', agent: 'claude-opus', role: row.role, seat: row.seat, channel: row.channel,
          schedule: row.armed ? { expr: '0 7 * * 1', tz: 'UTC' } : undefined, resolved: row.armed ? { next_due: new Date(now + 3 * 86_400_000).toISOString() } : undefined,
          ask: row.ask ? { text: row.ask, at: iso(row.minutes) } : undefined,
          review: row.review ? { note: row.review, at: iso(row.minutes) } : undefined,
          thread_parent: row.parent ? { uid: row.parent, host: WORKSPACE_HOST, slug: row.parent, name: ROWS.find(parent => parent.id === row.parent)!.name } : undefined } },
      runtime: live ? { state: 'running', phase: row.state === 'idle' ? 'waiting' : 'working', session_uuid: `session-${row.id}`, tmux_session: row.terminal ? `${row.id}-shuttle` : undefined, phase_since: ms(row.minutes) } : null,
    }
  })
  for (const row of ROWS) {
    example.bodies[row.id] = `## Desired State\n\n${row.name}.\n\n## Status\n\n${row.outcome ?? row.ask ?? 'Under way.'}`
    if (row.tapestry) {
      const page = `<!doctype html><html><head><meta charset="utf-8"><title>${row.tapestry.title}</title><style>body{font:17px/1.6 Georgia,serif;margin:28px;color:#30291f;background:#fbf6e9}.map{height:30vh;display:grid;place-items:center;background:#e4dcc8;border-radius:4px;color:#6b5d45}</style></head><body><h1>${row.tapestry.title}</h1><p>${row.tapestry.lede}</p>${row.tapestry.heavy ? heavyFigures() : row.tapestry.slide ? SLIDE : row.tapestry.figure ? `<figure><img src="${row.tapestry.figure}" alt=""></figure>` : '<div class="map">κ × tSZ, 9σ</div>'}<p>The cross-spectrum is flat to ℓ = 3000 and the 1-halo term carries most of the signal; the <a href="#/board/${encodeURIComponent('cmbx/foregrounds')}@${WORKSPACE_HOST}">foreground mask</a> is the open call.</p></body></html>`
      example.files.push({ owner: WORKSPACE_HOST, path: `${dir(row.id)}/tapestry.html`, mime: 'text/html', body: new Blob([page], { type: 'text/html' }) })
    }
  }
  /** A file a worker wrote in its own folder and sent: a plot drawn as SVG, or a short note. */
  const wrote = (uid: string, name: string, minutes: number, title: string, caption?: string) => {
    const path = `${dir(uid)}/${name}`, svg = name.endsWith('.svg')
    const body = svg
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#fbf6e9"/><text x="40" y="48" font-size="22" fill="#30291f">${title}</text><path d="M60 80V340H600" fill="none" stroke="#a39478"/><path d="M80 300C200 120 320 260 440 160S560 200 590 120" fill="none" stroke="#3f8278" stroke-width="3"/></svg>`
      : `# ${title}\n\nWritten for the channel.\n`
    example.files.push({ owner: WORKSPACE_HOST, path, mime: svg ? 'image/svg+xml' : 'text/markdown', body: new Blob([body], { type: svg ? 'image/svg+xml' : 'text/markdown' }) })
    return { fullPath: path, basename: name, uid, host: WORKSPACE_HOST, sessionId: `session-${uid}`, timestamp: ms(minutes), caption }
  }
  const spectrum = wrote('cmbx/kappa-tsz', 'kappa-tsz-spectrum.svg', 30, 'κ × tSZ cross-spectrum', 'κ×tSZ at 9σ with the new beam; every null passes at p > 0.1.')
  const nulls = wrote('cmbx/kappa-tsz', 'null-tests.md', 30, 'Null tests')
  const deck = '/fixture-store/workspace/cmbx/kappa-tsz/deck.html'
  const deckSend = (minutes: number, caption: string) => ({ fullPath: deck, basename: 'deck.html', uid: 'cmbx/kappa-tsz', host: WORKSPACE_HOST, sessionId: 'session-cmbx/kappa-tsz', timestamp: ms(minutes), caption })
  example.receipts = [
    // The deck was sent before, and again with the final numbers: only its newest send is drawn.
    deckSend(120, 'First pass: 7σ before the new beam.'), deckSend(31, 'The deck for Thursday, with the final numbers.'), spectrum, nulls,
    wrote('cmbx/covariance', 'covariance-ratio.svg', 49, 'Analytic / simulated covariance', 'The analytic and simulated covariances agree to 4% on every block.'),
    wrote('cmbx', 'weekly-plan.md', 300, 'The week in cmbx', 'The plan for the joint fit this week.'),
    wrote('pando/unions/west', 's8-posterior.svg', 60, 'S8 posterior, west run', 'The west run: S8 = 0.781 ± 0.019.'),
    wrote('morning-post', 'reply-drafts.md', 140, 'Two replies to send'),
    wrote('old-notes', 'lensing-notes.md', 21 * DAY, 'Lensing notes'),
  ]
  // A deck that keeps its slide in its address, as a reveal.js deck with history does: each step a history entry of its own.
  example.files.push({ owner: WORKSPACE_HOST, path: deck, mime: 'text/html', body: new Blob(['<!doctype html><html><head><title>κ × tSZ</title><style>body{margin:0;background:#15232e;color:#f3eadc;font:32px Georgia}section{box-sizing:border-box;height:100vh;padding:9vh 8vw;display:flex;flex-direction:column;justify-content:center}h1{font-size:100px;margin:0 0 30px}p{color:#8fcebf}</style></head><body><section><p>CMB LENSING · NOVEMBER</p><h1>κ × tSZ at 9σ</h1><p>A new beam. Every null passes; the <a style="color:inherit" href="#/board/' + encodeURIComponent('cmbx/foregrounds') + '@' + WORKSPACE_HOST + '">foreground mask</a> is the open call.</p></section><script>let slide = 0; document.addEventListener(\'click\', event => { if (!event.target.closest(\'a\')) location.hash = \'#/\' + ++slide })</script></body></html>'], { type: 'text/html' }) })
  // Each row's launch, the started marks between a channel's items.
  example.sessions = ROWS.map((row, n) => ({ at: ms(launched(row, n)), fiber: row.id, uid: row.id, session: `session-${row.id}`, harness: 'claude-code', agent: 'claude-opus', host: WORKSPACE_HOST, tmux: null, kind: 'dispatch' as const }))
  // UNIONS lives twice in places, as the real channel did: rho closed and was launched again, and the PSF thread was relaunched after its temper.
  for (const [fiber, minutes] of [['pando/unions/rho', 120], ['pando/unions/psf', 90]] as const) {
    if (ROWS.some(row => row.id === fiber)) example.sessions.push({ at: ms(minutes), fiber, uid: fiber, session: `session-${fiber}-2`, harness: 'claude-code', agent: 'claude-opus', host: WORKSPACE_HOST, tmux: null, kind: 'dispatch' as const })
  }
  // The west hub rested between its runs: it handed off two hours ago and was launched again an hour and a quarter ago.
  if (ROWS.some(row => row.id === 'pando/unions/west')) example.sessions.push({ at: ms(75), fiber: 'pando/unions/west', uid: 'pando/unions/west', session: 'session-pando/unions/west-2', harness: 'claude-code', agent: 'claude-opus', host: WORKSPACE_HOST, tmux: null, kind: 'dispatch' as const })
  example.commits = []
  let n = 0
  const said: Say = (fiber, kind, minutes, over = {}) =>
    ({ id: `brd-${String(++n).padStart(3, '0')}`, type: 'board', kind, fiber, by: { fiber }, timestamp: ms(minutes), originName: WORKSPACE_HOST, root: rootOf(fiber), ...over } as BoardRecord & { root: string })
  /** A line to the human; a thread's line goes up to its chair. */
  const up = (fiber: string): BoardRecord['to'] => ({ fiber: ROWS.find(row => row.id === fiber)!.parent! })
  const board = [
    said('cmbx', 'post', 300, { text: 'Three experts are on the joint fit this week: κ×tSZ, the cluster mask and the covariance. The plan is attached.', files: ['/fixture-store/workspace/cmbx/weekly-plan.md'] }),
    said('cmbx/covariance', 'post', 180, { to: up('cmbx/covariance'), text: 'Started the 2000-simulation run; first comparison in about two hours.' }),
    // The deck was sent before, and again with the final numbers: only its newest send is drawn whole.
    said('cmbx/kappa-tsz', 'post', 120, { to: up('cmbx/kappa-tsz'), text: 'First pass on the full footprint: 7σ, before the new beam.', files: [deck] }),
    said('cmbx/kappa-tsz', 'message', 100, { by: { fiber: 'cmbx' }, to: { fiber: 'cmbx/kappa-tsz' }, text: 'Use the new beam window from the beam thread before the final pass.' }),
    said('cmbx/kappa-tsz', 'human', 60, { by: HUMAN, text: 'Can you also show the null tests next to the spectrum?' }),
    // Closed to its chair with its closing post, then marked by the chair for the human's review.
    said('cmbx/covariance', 'closed', 48, { to: up('cmbx/covariance'), text: ROWS.find(row => row.id === 'cmbx/covariance')!.outcome }),
    said('cmbx/covariance', 'closed', 47, { by: { fiber: 'cmbx' }, to: HUMAN, text: ROWS.find(row => row.id === 'cmbx/covariance')!.review }),
    said('cmbx/kappa-tsz', 'post', 30, { to: HUMAN, text: 'κ×tSZ is measured to **9σ** with the new beam. The spectrum and the null tests are attached; every null passes at p > 0.1.', files: [deck, spectrum.fullPath, nulls.fullPath] }),
    said('cmbx/foregrounds', 'asked', 22, { to: up('cmbx/foregrounds'), text: ROWS.find(row => row.id === 'cmbx/foregrounds')!.ask }),
    said('cmbx', 'post', 12, { to: HUMAN, text: 'Two calls for you today: the cluster mask threshold and the covariance review. Everything else is moving.' }),
    // A line the human sent from the board, recorded under the id the board gave it.
    said('cmbx', 'human', 10, { id: 'brd-human-0001', by: HUMAN, text: 'Thanks — I will look after lunch.' }),
    said('pando/unions/shear-2pt', 'post', 300, { to: up('pando/unions/shear-2pt'), text: 'ξ± measured on all 6 tomographic bins; the covariance from the GLASS mocks is attached next.' }),
    said('pando/unions/psf', 'post', 260, { to: up('pando/unions/psf'), text: 'Leakage α = 0.012 ± 0.004 after the new PSF model; the correction is applied.' }),
    said('pando/unions/rho', 'post', 230, { to: up('pando/unions/rho'), text: 'ρ₁ through ρ₅ are consistent with zero on every scale.' }),
    said('pando/unions/bmodes', 'post', 200, { to: up('pando/unions/bmodes'), text: 'The B-mode null passes, χ²/dof = 1.04 over 24 bins.' }),
    said('pando/unions/depth', 'post', 170, { to: up('pando/unions/depth'), text: 'The depth map is rebuilt with the r-band masks; 3% of the footprint drops below the cut.' }),
    said('pando/unions/blinding', 'post', 150, { to: up('pando/unions/blinding'), text: 'The blinded data vector is ready for the chains; the key stays with you.' }),
    said('pando/unions/chains', 'post', 95, { to: up('pando/unions/chains'), text: 'Chains converged (R−1 < 0.01) on the blinded vector; posteriors match the mock run.' }),
    said('pando/unions/ia', 'post', 70, { to: up('pando/unions/ia'), text: 'NLA and TATT give the same S8 within 0.2σ; TATT stays the default.' }),
    said('pando/unions/photoz', 'post', 40, { to: up('pando/unions/photoz'), text: 'The SOM calibration moves the mean of bin 5 by 0.008; still inside the prior.' }),
    said('pando/unions/paper', 'post', 28, { to: up('pando/unions/paper'), text: 'Section 3 is drafted around the null tests; every number comes from the pipeline.' }),
    // UNIONS threads ending through the day: closed to the chair, tempered, discarded.
    said('pando/unions/shear-2pt', 'closed', 280, { to: up('pando/unions/shear-2pt') }),
    said('pando/unions/shear-2pt', 'closed', 275, { verdict: 'tempered' }),
    said('pando/unions/rho', 'closed', 222, { to: up('pando/unions/rho') }),
    said('pando/unions/bmodes', 'closed', 190, { to: up('pando/unions/bmodes') }),
    said('pando/unions/bmodes', 'closed', 160, { verdict: 'discarded' }),
    said('pando/unions/psf', 'closed', 250, { to: up('pando/unions/psf') }),
    said('pando/unions/psf', 'closed', 248, { verdict: 'tempered' }),
    said('pando/unions/depth', 'closed', 140, { to: up('pando/unions/depth') }),
    said('pando/unions/blinding', 'handed_off', 110),
    said('pando/unions', 'post', 24, { to: HUMAN, text: 'Morning round: chains converged, photo-z within the prior, the paper draft moving. One ask for you on the n(z) modes.' }),
    said('pando/unions/west', 'post', 60, { to: HUMAN, text: 'The west run finished: S8 = 0.781 ± 0.019. The posterior is attached.', files: ['/fixture-store/workspace/pando/unions/west/s8-posterior.svg'] }),
    said('pando/unions/east', 'handed_off', 45),
    said('pando/unions/west', 'handed_off', 120),
    said('pando/unions/modes', 'asked', 35, { to: up('pando/unions/modes'), text: ROWS.find(row => row.id === 'pando/unions/modes')!.ask }),
    said('deed-form', 'asked', 50, { to: up('deed-form'), text: ROWS.find(row => row.id === 'deed-form')!.ask }),
    said('insurance', 'closed', 200, { to: HUMAN, text: ROWS.find(row => row.id === 'insurance')!.outcome }),
    said('morning-post', 'closed', 140, { to: HUMAN, text: ROWS.find(row => row.id === 'morning-post')!.outcome, files: [`${dir('morning-post')}/reply-drafts.md`] }),
    said('felt', 'post', 25, { to: HUMAN, text: [
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
    said('felt', 'human', 20, { id: 'brd-human-0002', by: HUMAN, text: 'Thanks, I will run the catch-up tonight.' }),
    said('felt/lander', 'post', 15, { to: up('felt/lander'), text: 'Landed 58bda2a3d on main.' }),
    ...more(said, HUMAN, (path, body, minutes) => {
      const uid = path.split('/').slice(3, -1).join('/'), name = path.split('/').at(-1)!
      const mime = name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.html') ? 'text/html' : 'text/markdown'
      example.files.push({ owner: WORKSPACE_HOST, path, mime, body: new Blob([body], { type: mime }) })
      example.receipts.push({ fullPath: path, basename: name, uid, host: WORKSPACE_HOST, sessionId: `session-${uid}`, timestamp: ms(minutes) })
      return path
    }),
  ]
  // The daemon's answer: a line waits until the human says something to that fiber after it.
  const waiting: ChannelsFixture['waiting'] = {}
  for (const record of [...board].sort((a, b) => a.timestamp - b.timestamp)) {
    if (['post', 'asked', 'closed'].includes(record.kind)) {
      if (record.to?.label) waiting[record.fiber!] = { id: record.id, at: record.timestamp }
      else delete waiting[record.fiber!]
    } else if (record.kind === 'human') delete waiting[record.fiber!]
  }
  return {
    waiting,
    dismissed: [`hide:channel:composer:${ms(60)}`],
    pinned: { 'channel:garden': now - 3 * 86_400_000 },
    // The human put French above Science, and the garden plan last.
    order: { keys: ['channel:french', 'channel:science', 'channel:garden'], at: ms(DAY) },
    board,
  }
}
