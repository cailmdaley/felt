/**
 * Offline verification harness for the Board surface.
 *
 * It builds a self-contained IIFE bundle that mounts the real `KanbanModal`
 * against mocked daemon routes, then opens from `file://`. The feed still runs
 * through the board's real classifier (`parseCompositeFeed` →
 * `buildKanbanResponseFromComposite`), so the DOM and CSS are production code.
 * `?voice=off|following|pinned|meeting|muted|failed|phone` stages Listen; `?voice=muted-speech` is muted with
 * four minutes said into the muted mic and more arriving on each read, until Recover.
 * `?capture` opens ordinary Capture.
 * `?example=workspace` selects the fictional documentation example; add
 * `?transcript=live` to give its constitution a live worker, or
 * `?example=workspace&transcript=search` stages the bar Find's constitutions and grouped transcript hits for "mask".
 * `?identity=all` adds synthetic CLI workers with pending and failed session attribution.
 * `?example=workspace&failures` sends four images the reader cannot draw, one for each cause it names.
 * `?example=channels&illuminated=1` is a design experiment, not the board: each channel's head set in the illuminated capitals.
 * `?example=desk` is a busy Desk over the channels' fixture, its `/board/family` answering what waits (a post to the human among it).
 * `?page=thread&f=<uid>@<host>` mounts a page (src/pages/) instead of the board, over the same mocked daemon:
 * `?example=threads&page=thread&f=01KVBR1F9BWBVKF97473PV67K8@umber-workstation` is a thread with every kind of
 * sub-thread; add `&in=rex` for a page in a Rex pane, whose clicks post `/api/v1/go`.
 * `?example=threads&page=thread&f=talk@umber-workstation` is a constitution whose tapestry declares a public page, and `f=talk-notes@…` its twin that does not.
 *
 * The SETTINGS sheet is exercised the same way and is the one surface here
 * that is stateful: the stub keeps an in-memory copy of each host's operator
 * files, so a save round-trips and the rows above it change. It answers for
 * two hosts, because a host picker with one entry cannot show the thing it
 * exists to show. It does NOT validate — the daemon delegates that to the tool
 * that owns each grammar, and there is no felt here to ask, so a refusal is
 * the one behaviour this harness cannot stand in for.
 *
 * Build: `npm run harness:board`; open the emitted
 * harness-board-dist/index.html via file://. The page ships with the bundle,
 * so the output directory is self-sufficient — nothing to copy in by hand.
 */
import { addChannelsFixtures, addDeskFixtures } from './channels-fixtures.js'
import { addChangeFixtures, bakeFixtureChange, listFixturePRs } from './change-fixtures.js'
import { mapTerrainFixture } from './map-fixtures.js'
import { stampLifecycle } from './ownerLifecycle.js'
import { addNavigationFixtures } from './nav-back-fixtures.js'
import { addFamilyFixtures, addFrontierFixtures, addRemotePageFixture, addThreadFixtures, addThreadReviewFixtures } from './thread-fixtures.js'
import { KanbanModal } from '../src/board/KanbanModal.js'
import { mountPage } from '../src/pages/mount.js'
import { parsePageRoute } from '../src/pages/route.js'
import { scopeTheme } from '../src/board/workspace/themeScope.js'
import { Thumbnail } from '../src/board/workspace/Thumbnail.js'
import { holdings } from '../src/board/holdings.js'
import { workshopExample } from './workshop-example.js'
import { installWorkspaceNativeURLs, NOTE_FIBERS, WORKSPACE_HOST, WORKSPACE_ID, WORKSPACE_UID, LONG_WORKSPACE_NAME, workspaceExample } from './workspace-fixtures.js'
import { WORKSPACE_LATEST_SESSION, transcriptSearchHits } from './transcript-fixtures.js'
import { openCapture, openStash, openSettings } from '../src/forms/mountForms.js'
import { showToast } from '../src/board/utils.js'
import type {
  SessionRecord,
  TemporalOrigins,
} from '../src/board/views/TemporalData.js'

// ── Mock composite feed ──────────────────────────────────────────────────────
// Shaped exactly like the daemon's `GET /api/v1/fibers/composite` body, so
// KanbanModal's own parser + classifier serve each fiber its lifecycle column:
//   • status:open   + shuttle block          → drafts (quiet on the Desk)
//   • status:active + shuttle block          → inFlight (working when a worker
//                                              runs, via `runtime.tmux_session`)
//   • status:closed + no `tempered`          → awaitingReview (waiting on you)
const FOREIGN_HOST = 'basalt-login-02'
const now = Date.now()
const search = new URLSearchParams(window.location.search)
const example = search.get('example')
const transcriptScenario = search.get('transcript')
if (example === 'channels' && search.has('illuminated')) illuminateChannelNames()
/** Sets each chaired channel's head, as drawn, letter by letter in the board's illuminated capitals. */
function illuminateChannelNames(): void {
  const style = document.createElement('style')
  style.textContent = '.kbn-ch-name[data-illuminated] { font-family: var(--font-serif); letter-spacing: 0.02em; } .kbn-ch-name[data-illuminated] .kbn-cap { font-size: 1.45em; margin-right: 0.03em; }'
  document.head.append(style)
  new MutationObserver(() => {
    for (const name of document.querySelectorAll<HTMLElement>('.kbn-ch-name:not([data-lone]):not([data-illuminated])')) {
      const text = name.textContent ?? ''
      name.dataset.illuminated = ''
      name.replaceChildren(...[...text].map(letter => {
        if (!/[a-z]/i.test(letter)) return document.createTextNode(letter)
        const cap = document.createElement('span')
        cap.className = 'kbn-cap'
        cap.dataset.letter = cap.textContent = letter.toUpperCase()
        return cap
      }))
    }
  }).observe(document.body, { childList: true, subtree: true })
}
const docsExample = example === 'workshop' ? workshopExample(now) : null
const workspaceFixture = example === 'change' || example === 'workspace' || example === 'music' || example === 'nav-back' || example === 'threads' || example === 'frontier' || example === 'families' || example === 'thread-review' || example === 'channels' || example === 'desk' ? workspaceExample(now, { music: example === 'music', transcriptScenario }) : null
if (workspaceFixture && search.has('long-title')) {
  const fiber = workspaceFixture.feed.fibers.find(row => (row.fiber as Record<string, unknown>).id === WORKSPACE_ID)!.fiber as Record<string, unknown>
  fiber.name = LONG_WORKSPACE_NAME
}
if (workspaceFixture) {
  const examples = ['.png', '.html'].map(ext => workspaceFixture.receipts.find(file => String(file.fullPath).endsWith(ext))).filter(file => file !== undefined)
  for (const file of examples) workspaceFixture.receipts.push({ ...file, timestamp: now - 88_000, sessionId: WORKSPACE_LATEST_SESSION })
  const image = examples.find(file => String(file.fullPath).endsWith('.png'))
  if (image) workspaceFixture.receipts.push({ ...image, timestamp: now - 100_000, sessionId: WORKSPACE_LATEST_SESSION })
}
if (workspaceFixture && transcriptScenario === 'live') {
  const pdf = workspaceFixture.receipts.find(file => String(file.fullPath).endsWith('response.pdf'))
  if (pdf) workspaceFixture.receipts.push({ ...pdf, timestamp: now + 17_000, sessionId: WORKSPACE_LATEST_SESSION })
}
if (workspaceFixture && example === 'change') addChangeFixtures(workspaceFixture, now)
if (workspaceFixture && example === 'nav-back') addNavigationFixtures(workspaceFixture, now)
if (workspaceFixture && example === 'threads') { addThreadFixtures(workspaceFixture, now, search.has('manyThreads')); addRemotePageFixture(workspaceFixture, now) }
if (workspaceFixture && example === 'frontier') addFrontierFixtures(workspaceFixture, now)
if (workspaceFixture && example === 'families') addFamilyFixtures(workspaceFixture, now)
if (workspaceFixture && example === 'thread-review') addThreadReviewFixtures(workspaceFixture, now)
// `manyFiles` lengthens the open constitution's sent-files trail so its list has to scroll; every third send says why, one at length.
if (workspaceFixture && search.has('manyFiles')) {
  const first = workspaceFixture.receipts[0], dir = String(first.fullPath).slice(0, String(first.fullPath).lastIndexOf('/'))
  for (let i = 1; i <= 28; i++) {
    const fullPath = `${dir}/sweep/scan-${String(i).padStart(2, '0')}.png`
    const caption = i === 1 ? 'The shear response across all five patches after the PSF leakage fix; patch 3 still sits a little high in the outermost bin, which the next scan isolates'
      : i % 3 === 1 ? `Scan ${i}: response by redshift bin` : undefined
    workspaceFixture.receipts.push({ ...first, fullPath, basename: fullPath.split('/').at(-1), timestamp: now - (40 + i * 7) * 60_000, sessionId: `many-files-${i}`, ...caption ? { caption } : {} })
  }
}
// `failures` sends four images the reader cannot draw, one for each cause it
// names: the owner cannot read it, it is gone, its owner does not answer, and
// bytes this browser cannot decode. The owner's answer for each is its status.
const fileFaults = new Map<string, number>()
if (workspaceFixture && search.has('failures')) {
  const sends: Array<[string, string, number]> = [
    [WORKSPACE_HOST, '/home/fixture/Documents/projects/talks/2611_meeting/_check/01-title.png', 403],
    [WORKSPACE_HOST, '/tmp/fixture-scratch/frame.png', 404],
    [workspaceFixture.remote, '/scratch/fixture-store/covariance/residuals.png', 502],
    [WORKSPACE_HOST, '/fixture-store/workspace/deliverables/truncated.png', 200],
  ]
  sends.forEach(([host, fullPath, status], i) => {
    workspaceFixture.receipts.push({ fullPath, basename: fullPath.split('/').at(-1), timestamp: now - (5 + i) * 60_000, sessionId: 'failed-sends', uid: WORKSPACE_UID, host })
    if (status === 200) workspaceFixture.files.push({ owner: host, path: fullPath, mime: 'image/png', body: new Blob(['not an image'], { type: 'image/png' }) })
    else fileFaults.set(fullPath, status)
  })
}
const channelsFixture = workspaceFixture && example === 'channels' ? addChannelsFixtures(workspaceFixture, now)
  : workspaceFixture && example === 'desk' ? addDeskFixtures(workspaceFixture, now) : null
const nativeWorkspaceFiles = workspaceFixture ? installWorkspaceNativeURLs(workspaceFixture) : null
if (docsExample || workspaceFixture) document.querySelectorAll('.sim-corner').forEach(element => element.remove())
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString()
const recorderHost = search.get('recorder') ?? 'local'
const voiceScenario = search.get('voice') ?? 'off'
const voiceTarget = { fiber_id: workspaceFixture ? WORKSPACE_ID : 'work/spt3g_papers/bmodes-2d/run', origin: workspaceFixture ? WORKSPACE_HOST : FOREIGN_HOST, name: 'Null tests' }
let mockVoice: Record<string, unknown> = {
  available: true, sources: ['desktop', 'phone'], enabled: voiceScenario !== 'off', muted: ['muted', 'muted-speech'].includes(voiceScenario),
  muted_speech: voiceScenario === 'muted-speech' ? { seconds: 236, since: iso(-50 * 60_000), recovering: false } : null,
  follow: !['pinned', 'meeting'].includes(voiceScenario), system_audio: voiceScenario === 'meeting',
  source: voiceScenario === 'phone' ? 'phone' : 'desktop', launch: voiceScenario === 'off' ? null : 'voice-harness',
  state: voiceScenario === 'off' ? 'off' : voiceScenario === 'failed' ? 'failed' : 'listening',
  mode: voiceScenario === 'off' ? 'off' : voiceScenario === 'pinned' || voiceScenario === 'meeting' ? voiceScenario : 'following',
  target: voiceTarget, destination: voiceScenario === 'off' ? null : voiceTarget,
  last: null, error: voiceScenario === 'failed' ? 'The microphone is unavailable.' : null, recorder: recorderHost,
}
let mockViewed = voiceTarget

const shuttleBlock = (kind = 'oneshot') => ({
  kind,
  host: 'ada-workstation',
  agent: 'claude-opus',
  effort: 'high',
  project_dir: '/home/ada/loom',
})

/** The host serving this page — what every temporal result stamps itself with,
 *  and the note a row suppresses because it is the page's constant. */
const LOCAL_HOST = 'ada-workstation'

/**
 * A block whose worker runs somewhere OTHER than the host serving this page.
 *
 * LOAD-BEARING, do not normalize away. The board prints a row's hostname only
 * when that row ran elsewhere (a note matching the page host is suppressed,
 * because a hostname repeated on every row is a constant pretending to be
 * information). With every mock fiber on `ada-workstation` that path could
 * never fire, and a note that never renders looks exactly like a note that is
 * correctly suppressed. Exactly one fiber wears this so both branches are
 * visible at once: one row with a hostname, the rest bare.
 */
const shuttleBlockElsewhere = () => ({
  ...shuttleBlock(),
  host: FOREIGN_HOST,
  project_dir: '/leonardo_work/spt3g/papers',
})

/** A shuttle block carrying a concluded run's `runtime` stamps — the
 *  fiber controls' session-window summary (dispatched → handed off → span). */
const shuttleBlockWithRun = (dispatchedMsAgo: number, ranForMs: number) => ({
  ...shuttleBlock(),
  runtime: {
    session_uuid: '6bc045dc-92e0-473a-bf9e-e1cc263223bc',
    dispatched_at: iso(-dispatchedMsAgo),
    handed_off_at: iso(-dispatchedMsAgo + ranForMs),
  },
})

/** A standing constitution's block, with the schedule its owner resolves: the
 *  cron in words, and the next firing while it is armed. */
const standingBlock = (expr: string, text?: string, nextDue?: string) => ({
  ...shuttleBlock('standing'),
  schedule: { expr, tz: 'Europe/Paris' },
  ...(text ? { resolved: { schedule_text: text, ...(nextDue ? { next_due: nextDue } : {}) } } : {}),
})

/** Civil day N days from today, as the bare `YYYY-MM-DD` felt writes. */
const civilDay = (offsetDays: number) => {
  const d = new Date(now + offsetDays * 86_400_000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Every mock fiber that runs carries a ULID, as a real one does: a Shuttle
 * worker runs in `<leaf>-<ULID>-shuttle`, the session ledger records the
 * fiber's `uid` beside its id, and the card drawer's History asks the ledger
 * BY uid.
 *
 * Crockford base32 (0-9 A-Z minus I, L, O, U), 26 characters, checked at boot
 * by `assertUlids` below so a typo fails loudly instead of silently unjoining.
 */
const ULID = {
  boardChrome: '01KVBR1F9BWBVKF97473PV67K8',
  triage: '01KVBR2G7CXDWMG85592QW78M9',
  refine: '01KVBR3H8DYFXNH96683RX89N0',
  bmodes: '01KVBR4J9EZGYPJ07734SY90P1',
  receipts: '01KVBR5K0FZHZQK18845TZ01Q2',
  ledgerSweep: '01KVBR6M1GJ0ZRM29956V023R3',
  arxivDigest: '01KVBR7N2HK10SN30067W134S4',
  photoz: '01KVBR8P3JM21TP41178X245T5',
  registryAudit: '01KVBR9Q4KN32VQ52289Y356V6',
  lensingScope: '01KVBRAR5MP43WR63390Z467W7',
  morningPost: '01KVBRBS6NQ54XS74401Z578X8',
  mirrored: '01KTCA2D1FGAJNHX5WKQ34BSZF',
  shearSprint: '01KVBRCT7PR65YT85512Z689Y9',
  rentreePush: '01KVBRDV8QS76ZV96623Z790Z0',
  summerSchool: '01KVBREW9RT870W07734Z801Z1',
  bareFollowUp: '01KVBRFX0SV981X18845Z912Z2',
} as const

/** The tmux session a Shuttle worker on this fiber runs in — the real
 *  convention from internal/shuttlecli/foundation_test.go: `<leaf>-<uid>-shuttle`,
 *  where the leaf is the last path segment of the fiber id. */
const sessionFor = (id: string, uid: string): string =>
  `${id.split('/').filter(Boolean).pop()}-${uid}-shuttle`

interface MockFiber {
  id: string
  uid?: string
  name: string
  status: string
  outcome?: string
  tags?: string[]
  created_at?: string
  closed_at?: string
  /** Planning fields. `horizon: 'stashed'` + a future `due` is a SNOOZE — the
   *  card rests below and ghosts onto the timeline at the day it wakes. */
  due?: string
  horizon?: string
  /** A CYCLE's opening edge. Not one of felt's native fields — opaque extra
   *  frontmatter felt preserves and re-emits; `KanbanFiber` reads it as
   *  `Fiber.start` and the read model turns it into `cycleStart`. */
  start?: string
  shuttle?: ReturnType<typeof shuttleBlock> & {
    surface?: string
    role?: string
    seat?: boolean
    schedule?: { expr: string; tz: string }
    pulse?: { every: string; window?: { start: string; end: string; tz: string } }
  }
}

const fiber = (f: MockFiber) => ({
  origin: 'local',
  felt_store: '/home/ada/loom',
  path: `.felt/${f.id}.md`,
  dir: `/home/ada/loom/.felt/${f.id}`,
  fiber: {
    id: f.id,
    uid: f.uid,
    name: f.name,
    status: f.status,
    outcome: f.outcome,
    tags: f.tags ?? [],
    created_at: f.created_at ?? iso(-3 * 86_400_000),
    closed_at: f.closed_at,
    due: f.due,
    horizon: f.horizon,
    start: f.start,
    shuttle: f.shuttle,
  },
})

// Drafts (status:open, shuttle block).
const DRAFTS: MockFiber[] = [
  {
    id: 'ai-futures/portolan/standalone-kanban/board-chrome-redesign',
    uid: ULID.boardChrome,
    name: 'Board chrome + two-column file viewer',
    status: 'open',
    outcome: 'Keep the column actions beside their lanes, in one restrained button family.',
    tags: ['constitution', 'kanban', 'design'],
    shuttle: shuttleBlock(),
  },
  {
    id: 'work/euclid/euclid-github/triage',
    uid: ULID.triage,
    name: 'Triage the Euclid GitHub backlog',
    status: 'open',
    outcome: 'Sort open issues by milestone; close the stale duplicates flagged last week.',
    tags: ['euclid'],
    shuttle: shuttleBlock(),
  },
  {
    id: 'loom/email/morning-post/refine',
    uid: ULID.refine,
    name: 'Refine the morning-post grouping',
    status: 'open',
    outcome: 'Group routine auto-archives by category with counts; itemize the signal.',
    tags: ['loom', 'email'],
    shuttle: shuttleBlock(),
  },
]

// Active: the older, busy run and the newer paused reimbursement both work;
// a live worker is Working whatever its turn.
const IN_FLIGHT: MockFiber[] = [
  {
    id: 'work/spt3g_papers/bmodes-2d/run',
    uid: ULID.bmodes,
    name: 'Run the 2D B-mode null tests',
    status: 'active',
    created_at: iso(-5 * 86_400_000),
    outcome: 'Compute χ²_B and the PTE across the patch set; checking the covariance Hartlap factor.',
    tags: ['spt3g', 'research'],
    // The one fiber running off-box — see shuttleBlockElsewhere. A null-test
    // sweep on an HPC login node is also the most plausible candidate.
    shuttle: shuttleBlockElsewhere(),
  },
  {
    id: 'work/admin/conference-travel-receipts',
    uid: ULID.receipts,
    name: 'File the conference travel reimbursement',
    status: 'active',
    created_at: iso(-2 * 86_400_000),
    outcome: 'Attach the receipts; submit before the quarter closes.',
    tags: ['admin'],
    shuttle: shuttleBlock(),
  },
]

// Closed for the human's review (status:closed, no `tempered`): waiting on you.
const AWAITING: MockFiber[] = [
  {
    id: 'loom/felt-maintenance/ledger/sweep',
    uid: ULID.ledgerSweep,
    name: 'Felt-maintenance ledger sweep',
    status: 'closed',
    outcome: 'Recorded live-session resolutions; cleared the review queue. Ready for a verdict.',
    tags: ['loom', 'felt'],
    closed_at: iso(-6 * 3_600_000),
    shuttle: shuttleBlock(),
  },
  {
    id: 'work/arxiv/daily-digest',
    uid: ULID.arxivDigest,
    name: 'Daily arXiv digest',
    status: 'closed',
    outcome: 'Three cosmic-shear papers + one CMB-lensing cross-correlation surfaced; bib entries staged.',
    tags: ['arxiv', 'research'],
    closed_at: iso(-30 * 3_600_000),
    shuttle: shuttleBlockWithRun(30 * 3_600_000, 3 * 3_600_000 + 36 * 60_000),
  },
]

// Resting (`horizon: stashed`). The first two are SNOOZED — a future `due:`
// under the stored horizon — so they rest here AND ghost onto the timeline at
// the day they wake. The third rests dateless, the classic set-aside.
const RESTING: MockFiber[] = [
  {
    id: 'work/euclid/photoz-systematics/reread',
    uid: ULID.photoz,
    name: 'Re-read the photo-z systematics note',
    status: 'open',
    outcome: 'Wait for the updated calibration sample before another pass.',
    tags: ['euclid'],
    horizon: 'stashed',
    due: civilDay(4),
    shuttle: shuttleBlock(),
  },
  {
    id: 'loom/felt/shuttle/agent-registry-audit',
    uid: ULID.registryAudit,
    name: 'Audit the agent registry defaults',
    status: 'open',
    outcome: 'Effort tokens drifted from the harness names; reconcile after the next release.',
    tags: ['loom', 'shuttle'],
    horizon: 'stashed',
    due: civilDay(9),
    shuttle: shuttleBlock(),
  },
  {
    id: 'work/spt3g_papers/lensing-xcorr/scope',
    uid: ULID.lensingScope,
    name: 'Scope the lensing cross-correlation follow-up',
    status: 'open',
    outcome: 'No date yet — waiting on the collaboration call.',
    tags: ['spt3g'],
    horizon: 'stashed',
    shuttle: shuttleBlock(),
  },
  // Six more under `science`, across two subdirectories — the case that must
  // SPLIT into `science/unions` + `science/spt3g` rather than show "science 6".
  ...['sp-validation/rerun', 'shear-2d/covariance', 'photoz/recalibrate'].map((leaf) => ({
    id: `science/unions/${leaf}`,
    name: leaf.replace(/[/-]/g, ' '),
    status: 'open',
    tags: ['science'],
    horizon: 'stashed',
    shuttle: shuttleBlock(),
  })),
  ...['bmodes/null-suite', 'lensing/mask-audit', 'cluster/richness'].map((leaf) => ({
    id: `science/spt3g/${leaf}`,
    name: leaf.replace(/[/-]/g, ' '),
    status: 'open',
    tags: ['science'],
    horizon: 'stashed',
    shuttle: shuttleBlock(),
  })),
  // Six leaves in ONE folder — the degenerate case: no deeper segment to split
  // on, so it stays one cluster capped at four behind "+2 more".
  ...['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map((leaf) => ({
    id: `admin/${leaf}`,
    name: `Admin ${leaf}`,
    status: 'open',
    tags: ['admin'],
    horizon: 'stashed',
    shuttle: shuttleBlock(),
  })),
]

// Standing constitutions in Resting: one armed between firings, one with its
// schedule paused.
const STANDING: MockFiber[] = [
  {
    id: 'loom/email/morning-post/run',
    uid: ULID.morningPost,
    name: 'Morning post',
    status: 'active',
    outcome: 'Groups the routine auto-archives; itemizes the signal.',
    tags: ['loom', 'email'],
    shuttle: standingBlock('0 9 * * 1-5', 'weekdays at 09:00', iso(18 * 3_600_000)),
  },
  {
    id: 'loom/evening-digest',
    name: 'Evening digest',
    status: 'open',
    horizon: 'stashed',
    outcome: 'Summarises the day\'s threads that are still open.',
    tags: ['loom', 'email'],
    shuttle: standingBlock('0 18 * * *', 'daily at 18:00'),
  },
]

/**
 * ROLE SEATS — constitutions carrying `shuttle.seat`, quiet on the Desk with the
 * word *seat* while they rest. Two share an office (chief of staff on two
 * machines), and one is a standing seat asleep on its cron.
 */
const ROLE_SEATS: MockFiber[] = [
  { id: 'science/cmbx', name: 'cmbx chair', role: 'cmbx-chair' },
  { id: 'science/survey/north', name: 'Survey chair · north', role: 'chief-of-staff' },
  { id: 'science/survey/south', name: 'Survey chair · south', role: 'chief-of-staff' },
  { id: 'life/vizier', name: 'Vizier', role: 'vizier' },
  { id: 'life/music', name: 'Music — the composer\'s desk', role: 'composer' },
].map(({ id, name, role }): MockFiber => ({
  id,
  name,
  status: 'open',
  outcome: `${name}: at rest.`,
  shuttle: {
    ...shuttleBlock('oneshot'), role, seat: true,
    ...(id === 'life/vizier' ? { pulse: { every: '59m', window: { start: '08:00', end: '20:00', tz: 'Europe/Paris' } } } : {}),
  },
}))
ROLE_SEATS.push({
  id: 'loom/morning-post',
  name: 'Morning post',
  status: 'active',
  outcome: 'Morning post: sleeping until tomorrow.',
  shuttle: { ...shuttleBlock('standing'), role: 'vizier', seat: true, schedule: { expr: '0 7 * * *', tz: 'Europe/Paris' } },
})

/**
 * RESTING — constitutions put down between sessions (`status: open` +
 * `horizon: stashed`). Enough of them to fill several Resting clusters. None
 * carry a `uid`.
 */
const SEATS: MockFiber[] = [
  'null-suite/quick launch',
  'euclid triage',
  'photo-z recalibrate',
  'covariance rebuild',
  'jackknife sweep',
  'systematics scan',
  'arxiv digest',
  'ledger sweep',
  'registry audit',
  'lensing xcorr',
  'shear pipeline',
  'b-modes null check',
  'cluster richness',
  'mask audit',
].map((name, i) => ({
  id: `seats/seat-${i}`,
  name,
  status: 'open',
  horizon: 'stashed',
  outcome: `Resting seat: ${name}.`,
  shuttle: shuttleBlock('oneshot'),
}))

/**
 * CYCLES — `cycle`-tagged fibers, each a named span of time. They appear in NO
 * desk column: the read model files a cycle in `response.cycles` and nowhere
 * else, so the column counts never see one.
 *
 * One live cycle spans today, one runs open-ended, and one closed last week,
 * covering current, unbounded and past spans.
 */
const CYCLES: MockFiber[] = [
  {
    id: 'work/cycles/shear-paper-sprint',
    uid: ULID.shearSprint,
    name: 'shear-paper sprint',
    status: 'open',
    outcome: 'Push the cosmic-shear paper to a complete draft: covariance, nulls, and the systematics appendix.',
    tags: ['cycle'],
    start: civilDay(-5),
    due: civilDay(10),
  },
  {
    // OPEN-ENDED — a `start:` and no `due:`.
    id: 'loom/cycles/rentree-push',
    uid: ULID.rentreePush,
    name: 'rentrée push',
    status: 'open',
    outcome: 'Everything that has to be standing before the lab fills up again in September.',
    tags: ['cycle'],
    start: civilDay(-12),
  },
  {
    // WHOLLY PAST — started and ended before today, closed last week.
    id: 'work/cycles/summer-school-block',
    uid: ULID.summerSchool,
    name: 'summer-school block',
    status: 'closed',
    outcome: 'Lectures written and delivered; the lensing problem sets are in the shared drive.',
    tags: ['cycle'],
    start: civilDay(-19),
    due: civilDay(-6),
    closed_at: iso(-6 * 86_400_000),
  },
]

// Served by BOTH the laptop and `kelvin` out of one git-synced store.
const MIRRORED: MockFiber[] = [
  {
    id: 'science/unions/shear_2d/final-push',
    uid: ULID.mirrored,
    name: 'Final push on the A&A submission',
    status: 'open',
    outcome: 'Mirrored across the laptop and kelvin — one card, two hosts.',
    tags: ['unions'],
    shuttle: shuttleBlock(),
  },
]

const LEGACY_SURFACE_THREAD = '01a0be38-6c36-7cd1-aec9-53a680d1f693'
const LEGACY_SURFACE_CONVERSATION = fiber({
  id: 'operator/app-conversation',
  uid: '01KVBR2G7CXDWMG85592QW78ZZ',
  name: 'Legacy surface field is ignored',
  status: 'active',
  created_at: iso(-1 * 86_400_000),
  outcome: 'A stored surface value does not change terminal execution.',
  shuttle: shuttleBlock(),
})

/** The follow-up whose start the mock daemon refuses for want of a
 *  project_dir (see the `/api/v1/dispatch` stub). */
const BARE_FOLLOW_UP = 'work/spt3g_papers/bmodes-2d/run/new-mask'

/** One live worker per turn state: slug, name, runtime overrides, outstanding ask. */
const TURN_FIXTURES: ReadonlyArray<readonly [string, string, Record<string, unknown>, string?]> = [
  ['asked-while-working', 'Asked a question, still working', { phase: 'working', phase_since: now - 30_000 }, 'OK to adopt the SPICE estimator as default?'],
  ['asked-then-idle', 'Asked a question, then went idle', { phase: 'waiting', phase_since: now - 40 * 60_000 }, 'Two OKs: install the rebuilt maps; clear scratch?'],
  ['at-a-prompt', 'Stopped at a permission prompt', { phase: 'attention', phase_since: now - 5 * 60_000 }],
  ['idle', 'Ended its turn', { phase: 'waiting', phase_since: now - 90 * 60_000 }],
  ['working', 'Working right now', { phase: 'working', phase_since: now - 4_000 }],
  ['silent-working', 'Working, no sign of life for 18h', { phase: 'working', phase_since: now - 19 * 3_600_000, quiet_since: now - 18 * 3_600_000 }],
  ['no-signal', 'Live, no hook event yet', { phase_since: now - 20 * 3_600_000 }],
  ['blocked', 'Terminal worker could not start', { state: 'blocked', phase_since: now - 12 * 60_000 }],
]

/**
 * `?desk=dense`: a Desk at the density a working week reaches — about forty
 * cards across the three columns, live workers and idle turns among them, and
 * reports on many — for judging how many lines a column shows.
 */
const DENSE_NAMES = {
  drafts: [
    'Rerun the shear calibration with the new PSF model', 'Abstract for the cosmic-shear session', 'Clean up the photo-z bin edges in the config',
    'Draft the referee response for the kSZ paper', 'Port the covariance notebook to the pipeline', 'Survey the mask-apodization options',
    'Write the data-release note for the catalog', 'Scope the cross-correlation with DESI LRGs', 'Collect the telecon slides into one deck',
    'Benchmark NaMaster against the pseudo-Cℓ code', 'Plan the summer-student project', 'Check the blinding scheme against the new splits',
  ],
  inFlight: [
    'Reprocess the B-mode maps with the updated beam', 'Fit the intrinsic-alignment amplitude per tomographic bin', 'Assemble the systematics null-test suite',
    'Draft the methods section for the 2D power paper', 'Build the mock catalogs for the covariance', 'Profile the pipeline memory on the compute nodes',
    'Compare shear estimators on the image simulations', 'Validate the redshift distributions against spec-z', 'Regenerate the plots at print size',
    'Sweep the smoothing scale for the peak counts', 'Chase the PTE outlier in the north patch', 'Summarize the collaboration review comments',
  ],
  awaitingReview: [
    'Weekly arXiv surface', 'Defect and blend handling A/B', 'Prospective jobs running list', 'Telecon notes for the shear group',
    'Null tests on the reprocessed maps', 'Covariance convergence check', 'Bibliography sweep for the paper', 'Calibration bias summary',
    'Mask-split comparison', 'Photo-z outlier audit', 'Beam window function update', 'Pipeline timing report',
  ],
} as const
const DENSE_OUTCOME = 'Ran the comparison on the full footprint; the two choices agree within the statistical error everywhere except the lowest bin, where the difference is 0.6σ. Recommendation and figures are in report.html; three questions at the end.'
const denseRows = search.get('desk') === 'dense'
  ? (Object.entries(DENSE_NAMES) as Array<[keyof typeof DENSE_NAMES, readonly string[]]>).flatMap(([column, names]) => names.map((name, i) => {
    const id = `dense/${column}/${i}`
    const row = fiber({
      id, uid: `dense-${column}-${i}`, name,
      status: column === 'drafts' ? 'open' : column === 'inFlight' ? 'active' : 'closed',
      outcome: DENSE_OUTCOME,
      closed_at: column === 'awaitingReview' ? iso(-(i + 1) * 3_600_000) : undefined,
      due: i % 5 === 2 ? iso(2 * 86_400_000).slice(0, 10) : undefined,
      shuttle: { ...shuttleBlock(), agent: i % 4 === 1 ? 'codex-sol' : 'claude-opus' },
    })
    if (column !== 'inFlight') return row
    return {
      ...row,
      origin: LOCAL_HOST,
      runtime: {
        state: 'running',
        tmux_session: sessionFor(id, `dense-${i}`),
        phase: i % 3 === 0 ? 'waiting' : 'working',
        phase_since: now - (i % 3 === 0 ? (i + 1) * 3_600_000 : 20_000),
      },
    }
  }))
  : []
const DENSE_SENT_FILES = denseRows.filter((_, i) => i % 2 === 0).map((row, i) => ({
  fullPath: `/work/dense/${row.fiber.id.split('/').slice(1).join('-')}/${['report.html', 'figure.png', 'notes.pdf'][i % 3]}`,
  uid: row.fiber.uid ?? row.fiber.id,
  at: -(i + 1) * 47 * 60_000,
}))

const MOCK_FEED = {
  host: 'local',
  fibers: [
    ...DRAFTS.map(fiber),
    ...denseRows,
    ...(search.get('identity') === 'all' ? ['identity_pending', 'identity_failed'].map((phase, i) => ({
      ...fiber({
        id: `fixtures/session-attribution/${phase}`, uid: `fixture-identity-${i}`,
        name: phase === 'identity_pending' ? 'Pi worker identifying its session' : 'Codex worker with failed attribution',
        status: 'active', shuttle: { ...shuttleBlock(), agent: i ? 'codex-sol' : 'pi-luna' },
        outcome: 'Synthetic live worker; no operator content or actual execution.',
      }),
      origin: LOCAL_HOST,
      runtime: {
        state: 'running', surface: 'cli', session_uuid: null, identity_pending: true, phase,
        identity_error: i ? 'Timed out waiting for session file; retrying acquisition.' : undefined,
        tmux_session: `fixture-identity-${i}-shuttle`, started_at: now - 180_000, phase_since: now - 180_000,
      },
    })) : []),
    // `?turns=all` stages one live worker per turn state, so every worker pill
    // and state dot can be checked against each other at once.
    ...(search.get('turns') === 'all' ? TURN_FIXTURES.map(([slug, name, runtime, ask], i) => ({
      ...fiber({
        id: `fixtures/turns/${slug}`, uid: `fixture-turn-${i}`, name, status: 'active',
        created_at: iso(-(i + 1) * 3_600_000),
        shuttle: { ...shuttleBlock(), ...(ask ? { ask: { text: ask, at: iso(-2 * 3_600_000) } } : {}) },
        outcome: 'Synthetic live worker; no operator content or actual execution.',
      }),
      origin: LOCAL_HOST,
      runtime: { state: 'running', surface: 'cli', tmux_session: `fixture-turn-${i}-shuttle`, started_at: now - 20 * 3_600_000, ...runtime },
    })) : []),
    {
      ...LEGACY_SURFACE_CONVERSATION,
      origin: 'ada-workstation',
      fiber: {
        ...LEGACY_SURFACE_CONVERSATION.fiber,
        shuttle: {
          ...shuttleBlock(),
          agent: 'codex-luna',
          surface: 'app',
          runtime: { session_uuid: LEGACY_SURFACE_THREAD },
        },
      },
      runtime: {
        state: 'running',
        phase: 'working',
        tmux_session: 'legacy-surface-codex-shuttle',
        session_uuid: LEGACY_SURFACE_THREAD,
        agent: 'codex-luna',
        phase_since: now,
      },
    },
    ...IN_FLIGHT.map((f, i) => {
      const e = fiber(f)
      // Give the first in-flight card a live worker so the lane shows the
      // worker pill alongside the New-idea action.
      if (i === 0) {
        return {
          ...e,
          origin: f.shuttle?.host ?? LOCAL_HOST,
          runtime: {
            state: 'running',
            tmux_session: sessionFor(f.id, f.uid ?? ''),
            phase: 'working',
            phase_since: now - 4_000,
          },
        }
      }
      // The second one has been stopped at a prompt for hours — the case the
      // aged `⏸ your turn · 3h` pill exists for. Its session is bridged, so under
      // a finger the pill links to it in the Claude app.
      return {
        ...e,
        origin: f.shuttle?.host ?? LOCAL_HOST,
        runtime: {
          state: 'running',
          tmux_session: sessionFor(f.id, f.uid ?? ''),
          session_link: 'https://claude.ai/code/session_harness-waiting',
          phase: 'waiting',
          phase_since: now - (3 * 3_600_000 + 12 * 60_000),
        },
      }
    }),
    ...AWAITING.map(fiber),
    // A closed follow-up a worker filed by hand under the null-test run, owned
    // by the same remote host: its block names no project_dir, so starting it
    // is refused until a human confirms one — the board suggests the run's.
    {
      ...fiber({
        id: BARE_FOLLOW_UP,
        uid: ULID.bareFollowUp,
        name: 'Re-run the null tests on the new mask',
        status: 'closed',
        outcome: 'Filed by the null-test worker; never started.',
        tags: ['spt3g'],
        closed_at: iso(-2 * 3_600_000),
        shuttle: { kind: 'oneshot', host: FOREIGN_HOST } as MockFiber['shuttle'],
      }),
      origin: FOREIGN_HOST,
    },
    ...RESTING.map(fiber),
    ...STANDING.map(fiber),
    ...ROLE_SEATS.map(f => f.id === 'life/vizier'
      ? { ...fiber(f), pulse: { next_tick: iso(31 * 60_000), last_tick: iso(-28 * 60_000), state: 'scheduled' } }
      : fiber(f)),
    ...SEATS.map(fiber),
    // An older seat with a live Codex terminal worker that raised its hand: a
    // question waits on you, while the newer reimbursement idle at its prompt
    // works.
    {
      ...fiber({
        id: 'seats/seat-codex',
        name: 'codex terminal seat',
        status: 'active',
        created_at: iso(-7 * 86_400_000),
        outcome: 'The Codex worker needs a decision about the next run.',
        shuttle: { ...shuttleBlock('oneshot'), agent: 'codex-sol', surface: 'app' },
      }),
      origin: 'ada-workstation',
      runtime: {
        state: 'running',
        phase: 'attention',
        tmux_session: 'codex-seat-shuttle',
        session_uuid: '01a0be38-6c36-7cd1-aec9-53a680d1f693',
        agent: 'codex-sol',
        phase_since: now - 25 * 60_000,
      },
    },
    ...CYCLES.map(fiber),
    // The SAME fiber served by two daemons — a git-synced store is served by
    // every host that has it on disk. The board must render ONE card (the
    // locally-owned row) and name the other host on it, not two twins that
    // disagree about staleness.
    ...MIRRORED.flatMap((f) => [
      fiber(f),
      { ...fiber(f), origin: 'kelvin', felt_store: '/home/ada/loom-kelvin' },
    ]),
  ],
  origins: {
    local: { kind: 'local', stale: false, fiber_count: 12 },
    kelvin: { kind: 'remote', stale: true, last_polled_at: iso(-3_600_000), fiber_count: 1 },
  },
}

/**
 * The session ledger — `GET /api/v1/sessions`, one line per fiber↔session
 * pairing.
 *
 * Three things it deliberately covers:
 *
 *   · the four ULID-bearing sessions, the ordinary case.
 *   · `pi-2f9c41`, whose tmux name names no fiber at all; only the ledger can
 *     say whose work it was.
 *   · a HISTORICAL pairing (`sweep`) with no activity in any window the page
 *     asks for — the ledger outliving its session, which is the whole point of
 *     the file. It must not conjure a row on its own.
 *
 * `scratch-shuttle` is deliberately ABSENT, so unpaired work stays exercised:
 * pairing it here would resolve it and quietly delete that path.
 */
const MOCK_SESSIONS: SessionRecord[] = [
  {
    at: now - 5 * 3_600_000,
    fiber: 'work/spt3g_papers/bmodes-2d/run',
    uid: ULID.bmodes,
    session: '6bc045dc-92e0-473a-bf9e-e1cc263223bc',
    harness: 'claude-code',
    host: FOREIGN_HOST,
    tmux: sessionFor('work/spt3g_papers/bmodes-2d/run', ULID.bmodes),
    kind: 'dispatch',
  },
  {
    at: now - 4 * 3_600_000,
    fiber: 'loom/email/morning-post/refine',
    uid: ULID.refine,
    session: '2a7f1e30-5c84-4a1b-9f22-0d3b8c7e6a55',
    harness: 'claude-code',
    host: 'ada-workstation',
    tmux: sessionFor('loom/email/morning-post/refine', ULID.refine),
    kind: 'dispatch',
  },
  {
    at: now - 3 * 3_600_000,
    fiber: 'work/euclid/euclid-github/triage',
    uid: ULID.triage,
    session: 'b1d9c4a2-77e5-4f60-8c31-9ab204ef1d78',
    harness: 'codex',
    host: 'ada-workstation',
    tmux: sessionFor('work/euclid/euclid-github/triage', ULID.triage),
    kind: 'claim',
  },
  {
    at: now - 2 * 3_600_000,
    fiber: 'work/admin/conference-travel-receipts',
    uid: ULID.receipts,
    session: 'f3e8a015-2b6d-4c99-a7f4-51c8d0b93e2a',
    harness: 'claude-code',
    host: 'ada-workstation',
    tmux: sessionFor('work/admin/conference-travel-receipts', ULID.receipts),
    kind: 'resume',
  },
  {
    // The ledger-only pairing: a pi session whose name says nothing.
    at: now - 6 * 3_600_000,
    fiber: 'work/euclid/photoz-systematics/reread',
    uid: ULID.photoz,
    session: '9c2b7d41-8a03-4e15-b6f8-72d5a1c04b93',
    harness: 'pi',
    host: 'ada-workstation',
    tmux: 'pi-2f9c41',
    kind: 'dispatch',
  },
  {
    // Historical: paired days ago, no activity left in any window.
    at: now - 3 * 86_400_000,
    fiber: 'loom/felt-maintenance/ledger/sweep',
    uid: ULID.ledgerSweep,
    session: '4d6e2f88-1c37-4b52-9e04-a8f31b76c250',
    harness: 'claude-code',
    host: 'ada-workstation',
    tmux: sessionFor('loom/felt-maintenance/ledger/sweep', ULID.ledgerSweep),
    kind: 'dispatch',
  },
]

/**
 * The App-conversation card's own history, for the drawer's Sessions row:
 * more than the row shows folded (so "all N" has something to unfold), every
 * shape a row takes — a bridged Claude session, an unbridged one, the live
 * Codex app thread (no tmux), a Codex CLI thread, a pi session — and one run on
 * the foreign host, which names its host and, that host being stale in
 * MOCK_ORIGINS, is not asked for its link.
 */
const APP_UID = '01KVBR2G7CXDWMG85592QW78ZZ'
const APP_SESSIONS: SessionRecord[] = [
  ['8f493f87-28db-4ec9-8f7d-527fd614bcd5', 'claude-code', 'claude-opus', 50, 'dispatch', LOCAL_HOST],
  ['7c9a7c8a-2079-479b-b813-772a305727c9', 'claude-code', 'claude-opus', 30, 'dispatch', LOCAL_HOST],
  ['c6239266-4ba7-4b72-9ba0-fb302c75458e', 'claude-code', 'claude-opus', 28, 'resume', FOREIGN_HOST],
  ['01a042f4-6b7f-7f79-9c6c-8140ffd0126c', 'pi', undefined, 26, 'dispatch', LOCAL_HOST],
  ['01a0806b-ea58-74d2-b58d-607464ec0c64', 'codex', 'codex-luna', 24, 'dispatch', LOCAL_HOST],
  ['b69296a4-1023-4231-b372-270d7b3c4a9b', 'claude-code', 'claude-opus', 6, 'dispatch', LOCAL_HOST],
  ['f466597a-56d0-4047-8585-2159281ca18b', 'claude-code', 'claude-fable', 3, 'claim', LOCAL_HOST],
  ['01a0be38-6c36-7cd1-aec9-53a680d1f693', 'codex', 'codex-luna', 0.5, 'dispatch', LOCAL_HOST],
].map(([session, harness, agent, hoursAgo, kind, host]) => ({
  at: now - (hoursAgo as number) * 3_600_000,
  fiber: 'operator/app-conversation',
  uid: APP_UID,
  session: session as string,
  harness: harness as string,
  host: host as string,
  tmux: null,
  kind: kind as SessionRecord['kind'],
  ...(agent ? { agent: agent as string } : {}),
}))

/** `GET /api/v1/sessions/links` for one host, as the daemon would read it. */
function mockSessionLinks(url: string) {
  const params = new URL(url, 'http://harness').searchParams
  const host = params.get('host') || LOCAL_HOST
  const ids = (params.get('sessions') ?? '').split(',').filter(Boolean)
  const unbridged = 'b69296a4-1023-4231-b372-270d7b3c4a9b'
  const sessionRecords = workspaceFixture?.sessions ?? docsExample?.sessions ?? APP_SESSIONS
  return {
    host,
    links: ids.map((session) => {
      const record = sessionRecords.find((r) => r.session === session)
      const harness = record?.harness ?? null
      return {
        session,
        availability: record ? 'available_local' : 'transcript_missing',
        harness,
        url:
          harness === 'claude-code' && session !== unbridged
            ? `https://claude.ai/code/session_01${session.slice(0, 8).toUpperCase()}`
            : null,
      }
    }),
  }
}

/**
 * Per-origin freshness, the block the daemon's temporal composites serve.
 *
 * The remote is STALE on purpose. An unreachable host keeps its last-good data
 * on screen rather than losing two weeks of history to a dropped tunnel, and
 * the gray register saying so is a rendering path that needs a stale origin to
 * exist at all — with every origin fresh it could never be seen offline.
 */
const MOCK_ORIGINS: TemporalOrigins = {
  [LOCAL_HOST]: { kind: 'local', stale: false },
  [FOREIGN_HOST]: {
    kind: 'remote',
    stale: true,
    lastPolledAt: iso(-3_600_000),
    lastError: 'timeout',
  },
}

/**
 * The fleet's sent files, as `GET /api/v1/sent-files/all/composite` serves
 * them: path, basename, instant, session, the sending fiber, and the host that
 * holds the bytes. One of each kind shown in the Board overview, including a
 * receipt from a stale remote. Their bodies do not load over `file://`, so the
 * overview shows thumbnails.
 */
const MOCK_SENT_FILES = ([
  { fullPath: '/work/shear/results/b-mode-null.png', uid: 'work/euclid/photoz-systematics/reread', at: -40 * 60_000 },
  { fullPath: '/work/shear/report/null-tests.html', uid: 'work/euclid/photoz-systematics/reread', at: -3 * 3_600_000 },
  { fullPath: '/work/kanban/board-chrome.pdf', uid: 'ai-futures/portolan/standalone-kanban/board-chrome-redesign', at: -5 * 3_600_000 },
  { fullPath: '/work/arxiv/digest.md', uid: 'work/arxiv/daily-digest', at: -9 * 3_600_000 },
  { fullPath: '/work/cycles/chains.tar.gz', uid: 'work/cycles/shear-paper-sprint', at: -26 * 3_600_000, host: FOREIGN_HOST },
  ...DENSE_SENT_FILES,
] as Array<{ fullPath: string; uid: string; at: number; host?: string }>).map(({ fullPath, uid, at, host }) => ({
  fullPath,
  basename: fullPath.split('/').pop() ?? fullPath,
  timestamp: now + at,
  sessionId: null,
  uid,
  host: host ?? LOCAL_HOST,
}))

/** The arXiv digest card's body and sent-files trail — see the fetch stub. */
const MOCK_DIGEST_BODY = [
  'Three cosmic-shear papers and one CMB-lensing cross-correlation this morning.',
  '',
  ':::{embed} /work/arxiv/digest-report.html',
  ':title: Full digest',
  ':::',
  '',
  'The shear papers all use the same IA model; worth a closer look.',
].join('\n')
const MOCK_DIGEST_SENT = [
  { fullPath: '/work/arxiv/digest.md', basename: 'digest.md', timestamp: now - 9 * 3_600_000 },
  { fullPath: '/work/shear/report/null-tests.html', basename: 'null-tests.html', timestamp: now - 3 * 3_600_000 },
]

/**
 * A malformed ULID is invisible: the uid lookups just quietly miss. So check
 * the alphabet and the length at boot and throw — the mount's catch renders
 * the message over the page.
 */
const CROCKFORD_ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/
function assertUlids(): void {
  const bad = Object.entries(ULID).filter(([, v]) => !CROCKFORD_ULID_RE.test(v))
  if (bad.length > 0) {
    throw new Error(`invalid mock ULID(s): ${bad.map(([k, v]) => `${k}=${v}`).join(', ')}`)
  }
  const seen = new Set(Object.values(ULID))
  if (seen.size !== Object.keys(ULID).length) throw new Error('duplicate mock ULIDs')
}

// ── Settings: a whole host's configuration, mocked ───────────────────────────
//
// The settings sheet reads five routes and writes three, all of them
// owner-routed by an `origin` query or body key. The mock answers for two
// hosts so the host picker has something to pick BETWEEN — a picker with one
// entry cannot show the thing it exists to show — and it keeps a real
// in-memory copy of each file so a save round-trips and the rows above it
// change. What it does not do is validate: the daemon delegates that to the
// tool that owns each grammar, and there is no felt here to ask.

const SETTINGS_HOSTS = [LOCAL_HOST, FOREIGN_HOST]

const settingsFiles: Record<string, Record<string, string>> = {
  [LOCAL_HOST]: {
    stores: '{\n  "version": 1,\n  "felt_stores": [\n    "/home/you/loom"\n  ]\n}\n',
    projects:
      '{\n  "version": 1,\n  "projects": [\n    "/home/you/loom",\n    "/home/you/dev/felt"\n  ]\n}\n',
    agents: '',
    remotes:
      '{\n  "version": 1,\n  "remotes": [\n    {\n      "name": "' +
      FOREIGN_HOST +
      '",\n      "url": "https://' +
      FOREIGN_HOST +
      '.example.ts.net",\n      "tunnel": { "manager": "none" }\n    },\n    {\n      "name": "hub-a",\n      "ssh": "hub-a",\n      "port": 4001,\n      "tunnel": { "multiplex": true }\n    }\n  ]\n}\n',
    host: '{\n  "class": "single-user"\n}\n',
  },
  [FOREIGN_HOST]: {
    stores: '{\n  "version": 1,\n  "felt_stores": [\n    "/scratch/you/loom"\n  ]\n}\n',
    projects: '{\n  "version": 1,\n  "projects": [\n    "/scratch/you/analysis"\n  ]\n}\n',
    agents: '',
    remotes: '',
    host: '{\n  "class": "shared-multi-user",\n  "listen": "unix:///run/shuttle/daemon.sock"\n}\n',
  },
}

const settingsOrigin = (url: string): string =>
  new URL(url, 'http://harness.invalid').searchParams.get('origin') || LOCAL_HOST

/** The two path-list files as a list, the way `ConfigFiles.entries/1` serves
 *  them — which is where the structured editors get their rows. */
const settingsEntries = (host: string, id: string): string[] | null => {
  if (id !== 'stores' && id !== 'projects') return null
  const text = settingsFiles[host]?.[id] ?? ''
  if (text === '') return []
  try {
    const doc = JSON.parse(text) as Record<string, unknown>
    const list = Array.isArray(doc) ? doc : doc[id === 'stores' ? 'felt_stores' : 'projects']
    return Array.isArray(list) ? (list as string[]) : []
  } catch {
    return []
  }
}

const settingsSummary = (host: string, id: string): Record<string, unknown> => {
  const text = settingsFiles[host]?.[id] ?? ''
  return {
    id,
    path: `/home/you/.config/felt/${id}.json`,
    exists: text !== '',
    size: text.length,
    updated_at: Math.floor(now / 1000) - 3600,
    // Only on the local host's stores, so the sheet shows BOTH states at once:
    // the banner and its frozen controls here, and an ordinary editable list on
    // Projects and on the other host.
    env_override:
      host === LOCAL_HOST && id === 'stores'
        ? { var: 'FELT_STORES', value: '/home/you/loom' }
        : null,
    // A stable stand-in: the sheet only ever compares it with itself.
    digest: text === '' ? null : `harness-${host}-${id}-${text.length}`,
  }
}

const MOCK_AGENTS = [
  { id: 'claude-opus', cli: 'claude', model: 'opus', effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'], default_effort: 'medium', chrome_capable: true, cost_class: 'premium', default: true, source: 'builtin' },
  { id: 'claude-haiku', cli: 'claude', model: 'haiku', effort_levels: ['low', 'medium', 'high'], default_effort: 'low', chrome_capable: true, cost_class: 'economy', default: false, source: 'builtin' },
  { id: 'codex-luna', cli: 'codex', model: 'gpt-x-luna', effort_levels: ['low', 'medium', 'high', 'max'], default_effort: 'medium', cost_class: 'standard', default: false, source: 'user' },
]

const mockBuild = (sha: string, bootedAgoMs: number) => ({
  git_sha: `${sha}0000000000000000000000000000000000`,
  git_short_sha: sha,
  built_at: new Date(now - bootedAgoMs - 600_000).toISOString(),
  booted_at: new Date(now - bootedAgoMs).toISOString(),
  mix_vsn: '0.1.0',
})

const mockHostState = (host: string) => ({
  host,
  build: mockBuild(host === LOCAL_HOST ? 'a1b2c3d' : 'f0e9d8c', host === LOCAL_HOST ? 7_200_000 : 86_400_000),
  felt_stores: host === LOCAL_HOST ? ['/home/you/loom'] : ['/scratch/you/loom'],
  boot_quarantine: host !== LOCAL_HOST,
  pending_launch: host === LOCAL_HOST ? [] : [{ fiber_id: 'a/b' }],
  max_concurrent: 10,
  claimed_count: host === LOCAL_HOST ? 2 : 0,
  contract: { ok: true, expected: 13, observed: 13, reason: null },
  poll_health: { state: 'idle', stalls: 0, stall_timeout_ms: 300_000, last_stalled_at: null },
  document_cache: { state: 'fresh', entries: 412 },
  standing_roles: [{}, {}, {}],
  orphans: [],
})

const mockFleet = (host: string) => {
  const remotes =
    host === LOCAL_HOST
      ? [
          { name: FOREIGN_HOST, display: FOREIGN_HOST, url: `https://${FOREIGN_HOST}.example.ts.net`, remote_port: 4000, tunnel: { manager: 'none' }, health: { polled: true, stale: false, last_polled_at: new Date(now - 4_000).toISOString(), last_error: null, recovery: { state: 'healthy', attempt: 0, last_error: null } }, build: mockBuild('f0e9d8c', 86_400_000), tunnel_label: null },
          { name: 'hub-a', display: 'hub-a', ssh: 'hub-a', port: 4001, remote_port: 4000, url: 'http://127.0.0.1:4001', tunnel: { manager: 'launchd', multiplex: true }, health: { polled: true, stale: true, last_polled_at: new Date(now - 2_700_000).toISOString(), last_error: 'connection refused', recovery: { state: 'reviving', attempt: 2, last_error: 'ssh exited 255' } }, build: null, tunnel_label: 'io.shuttle.shuttle-tunnel-hub-a' },
        ]
      : []
  return {
    host,
    supervisor: 'launchd',
    file: settingsSummary(host, 'remotes'),
    error: null,
    launchd_label_prefix: 'io.shuttle',
    defaults: {},
    remotes,
  }
}

// ── Fetch stub: stand in for the daemon ──────────────────────────────────────
const MOCK_TRANSCRIPT_INDEX = { path: '/fixture-store/.cache/felt/transcript-index.sqlite', sessions: 4210, messages: 1830000, updated_at: new Date(Date.now() - 3 * 60_000).toISOString() }

const realFetch = (window as unknown as { __harnessNativeFetch?: typeof fetch }).__harnessNativeFetch ?? window.fetch.bind(window)
const mockRequests: Array<Record<string, unknown>> = []
const mockHandlers: Array<Record<string, unknown>> = []
const harnessEvents: Array<Record<string, unknown>> = []
/** Workers Rex holds no window for: a click's select-only attach answers that Rex did not move. */
const windowless = new Set<string>()
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const method = (init?.method ?? 'GET').toUpperCase()
  const request: Record<string, unknown> = { url, method, body: typeof init?.body === 'string' ? init.body : null, headers: Object.fromEntries(new Headers(init?.headers).entries()) }
  mockRequests.push(request)
  mockHandlers.push({ method, path: new URL(url, 'http://harness.invalid').pathname })
  const json = (body: unknown, status = 200) => {
    // Like its owner, the mock serves every fiber row its column and turn.
    const fibers = (body as { fibers?: unknown })?.fibers
    const served = Array.isArray(fibers) ? { ...(body as object), fibers: fibers.map(row => stampLifecycle(row)) } : body
    const serialized = JSON.stringify(served)
    request.responseBytes = new TextEncoder().encode(serialized).byteLength
    return new Response(serialized, { status, headers: { 'Content-Type': 'application/json' } })
  }
  const body = (): Record<string, unknown> => {
    try {
      return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  const bodyOrigin = (): string => (body().origin as string) || LOCAL_HOST

  if (url.split('?')[0].endsWith('/api/v1/voice')) {
    if (init?.method === 'POST') {
      const { meeting, ...request } = body()
      if (meeting === true) Object.assign(request, { enabled: true, muted: false, follow: false, system_audio: true })
      if (meeting === false && mockVoice.system_audio) Object.assign(request, { follow: true, system_audio: false })
      mockVoice = { ...mockVoice, ...request, error: null }
      if (!mockVoice.enabled || mockVoice.follow) mockVoice.system_audio = false
      if (request.follow === true) mockVoice.target = mockViewed
      mockVoice.state = mockVoice.enabled ? 'listening' : 'off'
      mockVoice.mode = mockVoice.enabled ? mockVoice.system_audio ? 'meeting' : mockVoice.follow ? 'following' : 'pinned' : 'off'
      mockVoice.destination = mockVoice.enabled ? mockVoice.target : null
      mockVoice.launch = mockVoice.enabled ? 'voice-harness' : null
    }
    const speech = mockVoice.muted_speech as { seconds: number; recovering: boolean } | null
    if (speech && mockVoice.muted && !speech.recovering) mockVoice.muted_speech = { ...speech, seconds: speech.seconds + 3 }
    return json(mockVoice)
  }
  if (url.split('?')[0].endsWith('/api/v1/voice/recover')) {
    if (mockVoice.muted_speech) mockVoice.muted_speech = { ...(mockVoice.muted_speech as object), recovering: true }
    return json(mockVoice)
  }
  if (url.split('?')[0].endsWith('/api/v1/voice/target')) {
    mockViewed = body() as typeof voiceTarget
    if (mockVoice.follow) mockVoice.target = mockVoice.enabled ? mockViewed : mockVoice.target
    mockVoice.destination = mockVoice.enabled ? mockVoice.target : null
    return json(mockVoice)
  }
  if (url.split('?')[0].endsWith('/api/v1/voice/transcript')) {
    const filter = new URL(url, 'http://harness').searchParams.get('fiber')
    const rows = [
      { t: iso(-60_000), speaker: 'me', text: 'Let us check the mask split before calling it settled.', ...voiceTarget, launch: 'voice-harness' },
      { t: iso(-45_000), speaker: 'S1', text: 'The covariance looks fine.', ...voiceTarget, launch: 'voice-harness' },
      { t: iso(-30_000), speaker: 'me', text: 'Save the comparison for tomorrow.', fiber_id: 'research/next', origin: WORKSPACE_HOST, name: 'Next steps', launch: 'voice-harness' },
    ]
    return json({ date: iso(0).slice(0, 10), rows: rows.filter(row => !filter || row.fiber_id === filter || (filter === WORKSPACE_UID && row.fiber_id === WORKSPACE_ID)), recorder: recorderHost })
  }
  // A constitution's Change page asks its owner to bake the change.
  const bake = method === 'POST' ? /\/api\/v1\/fibers\/([^/?]+)\/change$/.exec(url) : null
  if (workspaceFixture && bake) return json(bakeFixtureChange(workspaceFixture, decodeURIComponent(bake[1]), bodyOrigin(), body().pr as number | undefined))
  // A constitution that follows several PRs lists them first.
  const listing = method === 'GET' ? /\/api\/v1\/changes\/([^/?]+)(\?|$)/.exec(url) : null
  if (workspaceFixture && listing) return json(listFixturePRs(decodeURIComponent(listing[1])))
  // A page's `go`: Rex moves to a fiber with a running worker, and to nothing else.
  if (method === 'POST' && url.split('?')[0].endsWith('/api/v1/go')) {
    const { fiber_id: uid, origin } = body()
    const rows = (workspaceFixture?.feed ?? docsExample?.feed ?? MOCK_FEED).fibers as Array<{ origin?: string; fiber: { uid?: string }; runtime?: unknown }>
    const live = rows.some(row => row.fiber.uid === uid && row.origin === origin && row.runtime)
    return json(live ? { went: true, place: 'live' } : { went: false, place: 'none' })
  }
  // The board's composite feed.
  if (url.includes('/api/v1/fibers/composite')) return json(workspaceFixture?.feed ?? docsExample?.feed ?? MOCK_FEED)
  if (workspaceFixture && url.includes('/api/v1/fibers/') && url.includes('body=true')) {
    const id = decodeURIComponent(url.split('/api/v1/fibers/')[1].split('?')[0])
    const row = workspaceFixture.feed.fibers.find(entry => {
      const fiber = entry.fiber as Record<string, unknown>
      return fiber.id === id || fiber.uid === id
    })
    if (row) {
      const fiber = row.fiber as Record<string, unknown>
      return json({ fibers: [{ ...row, fiber: { ...fiber, body: workspaceFixture.bodies[String(fiber.id)] ?? fiber.outcome ?? '' } }] })
    }
    if (id === 'research/workspace/method-note' || id === '01KVBR6M1GJ0ZRM29956V023R3') {
      const noteId = 'research/workspace/method-note'
      return json({ fibers: [{
        origin: WORKSPACE_HOST,
        felt_store: '/fixture-store/workspace',
        path: '.felt/research/workspace/method-note/method-note.md',
        dir: '/fixture-store/workspace/.felt/research/workspace/method-note',
        fiber: {
          id: noteId, uid: '01KVBR6M1GJ0ZRM29956V023R3', name: 'Method note', status: 'closed',
          outcome: 'The response correction uses independent simulations.',
          body: workspaceFixture.bodies[noteId], tags: ['workspace'],
          shuttle: { kind: 'oneshot', host: WORKSPACE_HOST, agent: 'claude-opus', project_dir: '/fixture-store/workspace' },
        },
      }] })
    }
    const note = NOTE_FIBERS.find(row => row.id === id || row.uid === id)
    if (note) {
      const id = note.id
      return json({ fibers: [{
        origin: WORKSPACE_HOST,
        felt_store: '/fixture-store/workspace',
        path: `.felt/${id}/${id.split('/').at(-1)}.md`,
        dir: `/fixture-store/workspace/.felt/${id}`,
        fiber: { id, uid: note.uid, name: note.name, status: 'open', outcome: note.outcome, body: note.body, tags: id.startsWith('roles/') ? ['role'] : ['workspace'] },
      }] })
    }
    return json({ fibers: [] }, 404)
  }
  if (docsExample && url.includes('/api/v1/fibers/') && url.includes('body=true')) {
    const id = decodeURIComponent(url.split('/api/v1/fibers/')[1].split('?')[0])
    const row = docsExample.feed.fibers.find(row => row.fiber.id === id)
    return json({ fibers: [{ fiber: { ...row?.fiber, body: docsExample.bodies[id] ?? row?.fiber.outcome ?? '' } }] })
  }
  // The arXiv digest card carries both kinds of file a card can open: a
  // `:::{embed}` report in its body (the attachment strip) and a sent-files
  // trail. Every other card's body and trail stay empty.
  if (url.includes('/api/v1/fibers/work/arxiv/daily-digest?body=true')) {
    return json({ fibers: [{ fiber: { body: MOCK_DIGEST_BODY, outcome: 'Digest delivered.' } }] })
  }
  if (url.includes('/api/v1/sent-files?')) {
    const uid = new URL(url, 'http://harness').searchParams.get('uid')
    if (workspaceFixture) return json({ files: workspaceFixture.receipts.filter(file => file.uid === uid) })
    if (docsExample) return json({ files: [] })
    return json({ files: uid === ULID.arxivDigest ? MOCK_DIGEST_SENT : [] })
  }
  // The parent picker's index: the feed's rows plus a sibling of the null-test
  // run, so its picker offers a parent before anything is typed.
  if (url.endsWith('/api/v1/fibers?fields=index')) {
    if (workspaceFixture) return json({ fibers: [...workspaceFixture.feed.fibers, { fiber: { id: 'research/workspace/method-note', name: 'Method note' } }, ...NOTE_FIBERS.map(({ id, name }) => ({ fiber: { id, name } }))] })
    if (docsExample) return json({ fibers: docsExample.feed.fibers })
    return json({ fibers: [...MOCK_FEED.fibers, { fiber: { id: 'work/spt3g_papers/bmodes-2d/null-suite', name: 'Null-test suite' } }] })
  }
  if (url.endsWith('/api/v1/capture') && init?.method === 'POST') return json({ spawned: true, tmux_session: 'capture-session' }, 202)

  // ── The settings plane ─────────────────────────────────────────────────
  // Before the catch-all below, which would otherwise answer every one of
  // these with `{ok: true}` and leave the sheet rendering an empty page.
  if (url.includes('/api/v1/felt-stores') && init?.method === 'POST') {
    const host = bodyOrigin()
    const list = (body().felt_stores as string[]) ?? []
    settingsFiles[host] = {
      ...(settingsFiles[host] ?? {}),
      stores: JSON.stringify({ version: 1, felt_stores: list }, null, 2) + '\n',
    }
    return json({ ok: true, host, felt_stores: list })
  }
  if (url.includes('/api/v1/projects')) {
    const host = bodyOrigin()
    const current = settingsEntries(host, 'projects') ?? []
    const next = Array.isArray(body().projects)
      ? (body().projects as string[])
      : [...current, String(body().path ?? '')]
    settingsFiles[host] = {
      ...(settingsFiles[host] ?? {}),
      projects: JSON.stringify({ version: 1, projects: next }, null, 2) + '\n',
    }
    return json({ ok: true, host, projects: next, registered: true, initialized: false, path: body().path })
  }
  if (url.includes('/api/v1/felt-stores') && init?.method !== 'POST') {
    return json({
      host: LOCAL_HOST,
      origins: Object.fromEntries(
        SETTINGS_HOSTS.map((h) => [
          h,
          {
            kind: h === LOCAL_HOST ? 'local' : 'remote',
            host: h,
            display: h,
            stale: false,
            native_folder_picker: h === LOCAL_HOST,
            browser_capable: h === LOCAL_HOST,
            felt_stores: h === LOCAL_HOST ? ['/home/you/loom'] : ['/scratch/you/loom'],
            expanded_felt_stores: h === LOCAL_HOST ? ['/home/you/loom', '/home/you/dev/felt'] : undefined,
            projects: h === LOCAL_HOST ? ['/home/you/loom', '/home/you/dev/felt'] : ['/scratch/you/analysis'],
          },
        ]),
      ),
    })
  }
  const configFile = /\/api\/v1\/config\/([a-z]+)/.exec(url)
  if (configFile) {
    const id = configFile[1]
    if (init?.method === 'POST') {
      const host = bodyOrigin()
      settingsFiles[host] = { ...(settingsFiles[host] ?? {}), [id]: String(body().text ?? '') }
      return json({
        ok: true,
        host,
        ...settingsSummary(host, id),
        text: settingsFiles[host][id],
        entries: settingsEntries(host, id),
      })
    }
    const host = settingsOrigin(url)
    return json({
      host,
      ...settingsSummary(host, id),
      text: settingsFiles[host]?.[id] ?? '',
      entries: settingsEntries(host, id),
    })
  }
  if (url.includes('/api/v1/config')) {
    const host = settingsOrigin(url)
    return json({
      host,
      files: ['stores', 'projects', 'agents', 'remotes', 'host', 'voice'].map((id) => settingsSummary(host, id)),
    })
  }
  if (url.includes('/api/v1/fleet')) {
    if (init?.method === 'POST') return json({ ok: true, host: bodyOrigin(), output: 'saved (harness)' })
    return json(mockFleet(settingsOrigin(url)))
  }
  if (url.includes('/api/v1/tunnels')) {
    return json({ ok: true, host: bodyOrigin(), output: 'would install hub-a -> ~/Library/LaunchAgents/io.shuttle.shuttle-tunnel-hub-a.plist' })
  }
  if (url.includes('/api/v1/roles')) return json([
    { slug: 'analyst', id: 'roles/analyst', name: 'Analyst', outcome: 'Keeps scientific results sound and reproducible.' },
    { slug: 'editor', id: 'roles/editor', name: 'Editor', outcome: 'Keeps the writing clear, current and useful.' },
    { slug: 'composer', id: 'roles/composer', name: 'Composer', outcome: 'Writes and arranges the music.' },
    { slug: 'surveyor', id: 'roles/surveyor', name: 'Surveyor', outcome: 'Runs long campaigns and reports what the data says.' },
    { slug: 'vizier', id: 'roles/vizier', name: 'Vizier', outcome: 'Keeps the personal desk and its commitments in view.' },
  ])
  if (url.includes('/api/v1/agents')) return json(MOCK_AGENTS)
  // NOT owner-routed, on purpose (see settingsApi's loadVersion doc) — always
  // this harness's own local-host state, regardless of any `?origin=`.
  if (url.includes('/api/v1/version')) {
    return json({
      ...mockBuild('a1b2c3d', 7_200_000),
      host: workspaceFixture?.host ?? LOCAL_HOST,
      terminal: search.get('console')?.startsWith('rex') ? 'rex' : 'tmux',
      contract: { ok: true, expected: 2, observed: 2 },
      listen: 'unix:///home/you/.shuttle/sock/daemon.sock',
      host_class: 'single-user',
    })
  }
  if (url.includes('/api/v1/state/composite')) {
    return json({
      local: mockHostState(LOCAL_HOST),
      remotes: { [FOREIGN_HOST]: { snapshot: mockHostState(FOREIGN_HOST), stale: false, last_error: null } },
    })
  }

  // Links arrive a beat after the ledger, as a real host's would, so the rows
  // can be seen drawn first with ids to copy.
  if (url.includes('/api/v1/sessions/links')) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    return json(mockSessionLinks(url))
  }
  // A click only selects a window Rex already has, and says whether it did.
  // Kitty takes a moment; a row shows it pending meanwhile.
  if (url.endsWith('/api/v1/attach')) {
    const { tmux_session: session, shuttle_host: host, select_only: selectOnly } = body()
    if (selectOnly === true) {
      harnessEvents.push({ type: 'select-worker', session, host })
      return json({ moved: !windowless.has(String(session)), session })
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
    return json({ attached: true })
  }
  if (url.includes('/api/v1/transcript/usage')) {
    // Channels' workers each have a session whose figures the console shows.
    if (!workspaceFixture || !(url.includes(WORKSPACE_LATEST_SESSION) || channelsFixture)) return json({ availability: 'transcript_missing' }, 404)
    return json({ context: 182_340, cached: 179_216, cache_warm_until: Date.now() + 47 * 60_000, cache_ttl: 3_600_000, hit_share: 0.94, at: Date.now() - 13 * 60_000 })
  }
  // The record search: outcomes from the feed's own fibers, and one closed fiber the board no longer holds, so both halves of the list show.
  if (url.includes('/api/v1/search?')) {
    const query = (new URL(url, 'http://harness').searchParams.get('q') ?? '').trim(), needle = query.toLowerCase()
    if (!needle) return json({ query, results: [], errors: [] })
    const feed = (workspaceFixture?.feed ?? docsExample?.feed ?? MOCK_FEED) as { fibers: Array<{ fiber: { id: string; name?: string; status?: string; outcome?: string } }> }
    const outcomes = feed.fibers.map(row => row.fiber).filter(fiber => fiber.outcome?.toLowerCase().includes(needle)).map(fiber => {
      const at = fiber.outcome!.toLowerCase().indexOf(needle)
      return { id: fiber.id, name: fiber.name ?? fiber.id, status: fiber.status ?? 'open', where: ['outcome'], excerpt: `…${fiber.outcome!.slice(Math.max(0, at - 40), at + needle.length + 60)}…`, rank: 4 }
    })
    const record = { id: `archive/${needle.replace(/[^a-z0-9]+/g, '-')}-first-pass`, name: `The first ${query} pass`, status: 'closed', where: ['body'], excerpt: `…an earlier attempt at the ${query}, closed before this board's reach…`, rank: 5 }
    return json({ query, results: [...outcomes, record], errors: [] })
  }
  if (url.includes('/api/v1/transcripts/search')) {
    const query = new URL(url, 'http://harness').searchParams.get('q') ?? ''
    if (query.trim().toLowerCase() === 'nothing') return json({ query, index: MOCK_TRANSCRIPT_INDEX, hits: [], errors: [] })
    return json({
      query,
      index: MOCK_TRANSCRIPT_INDEX,
      hits: transcriptSearchHits(now),
      errors: [],
    })
  }

  if (url.includes('/api/v1/sessions/composite')) {
    if (workspaceFixture) {
      const uid = new URL(url, 'http://harness').searchParams.get('uid')
      return json({ host: workspaceFixture.host, records: workspaceFixture.sessions.filter(record => !uid || record.uid === uid), origins: workspaceFixture.feed.origins })
    }
    if (docsExample) return json({ host: docsExample.feed.host, records: docsExample.sessions, origins: docsExample.feed.origins })
    const uid = new URL(url, 'http://harness').searchParams.get('uid')
    const records = [...MOCK_SESSIONS, ...APP_SESSIONS].filter((r) => !uid || r.uid === uid)
    return json({ host: LOCAL_HOST, records, origins: MOCK_ORIGINS })
  }

  if (url.includes('/api/v1/channels/dismissed')) return json({ dismissed: channelsFixture?.dismissed ?? [], pinned: channelsFixture?.pinned ?? {}, order: channelsFixture?.order ?? null, reach_ms: 14 * 86_400_000 })
  if (url.includes('/api/v1/channels/order')) {
    if (channelsFixture) channelsFixture.order = { keys: body().keys as string[], at: Date.now() }
    return json({ ok: true })
  }
  if (url.includes('/api/v1/channels/dismiss')) {
    channelsFixture?.dismissed.push(String(body().key))
    return json({ ok: true })
  }
  if (url.includes('/api/v1/channels/pin')) {
    if (channelsFixture) channelsFixture.pinned[String(body().key)] = Date.now()
    return json({ ok: true })
  }
  if (url.includes('/api/v1/board/family')) {
    const params = new URL(url, 'http://harness').searchParams, since = Number(params.get('since_ms') ?? 0), all = params.get('all') === 'true'
    return json({ family: all ? null : { uid: params.get('fiber') }, records: (channelsFixture?.board ?? []).filter(record => (all || record.root === params.get('fiber')) && record.timestamp >= since), reach_ms: 14 * 86_400_000, waiting: channelsFixture?.waiting ?? {} })
  }

  if (url.includes('/api/v1/board/marks')) {
    // The daemon's join, on the fixture's ledgers: every pairing a launch, each
    // commit its session's thread's.
    const sessions = workspaceFixture?.sessions ?? docsExample?.sessions ?? [...MOCK_SESSIONS, ...APP_SESSIONS]
    const commits = workspaceFixture?.commits ?? []
    const marks: Record<string, { launches: number[]; commits: number[] }> = {}
    const owners = new Map<string, string>()
    for (const row of sessions) {
      if (!row.uid) continue
      owners.set(row.session, row.uid)
      ;(marks[row.uid] ??= { launches: [], commits: [] }).launches.push(row.at)
    }
    for (const row of commits) {
      const uid = row.session ? owners.get(row.session) : undefined
      if (uid) marks[uid].commits.push(row.at)
    }
    return json({ reach_ms: 14 * 86_400_000, marks, origins: workspaceFixture?.feed.origins ?? MOCK_ORIGINS })
  }

  if (url.includes('/api/v1/sent-files/all/composite')) {
    if (workspaceFixture) return json({ files: workspaceFixture.receipts, origins: workspaceFixture.feed.origins })
    if (docsExample) return json({ files: [], origins: docsExample.feed.origins })
    return json({ files: MOCK_SENT_FILES, origins: MOCK_ORIGINS })
  }
  // A text card's body. Images, pages and PDFs load by URL, not through
  // fetch, so offline they stay faces.
  if (url.includes('/api/v1/file')) {
    const fileUrl = new URL(url, 'http://harness.invalid')
    const fault = fileUrl.pathname.endsWith('/api/v1/file') ? fileFaults.get(fileUrl.searchParams.get('path') ?? '') : undefined
    if (fault) {
      ;(request as Record<string, unknown>).status = fault
      const error = fault === 403 ? 'owner could not read file' : fault === 404 ? 'file not found' : 'owner did not answer'
      return json({ error }, fault)
    }
    if (workspaceFixture) {
      const response = workspaceFixture.fileResponse(url, method, init?.headers)
      ;(request as Record<string, unknown>).status = response.status
      return response
    }
    return new Response('# Daily digest\n\nThree cosmic-shear papers and one CMB-lensing cross-correlation.\n', {
      headers: { 'Content-Type': 'text/plain' },
    })
  }

  // Any write (transition/felt-edit/dispatch) the user might trigger — swallow
  // it with a benign OK so the offline harness doesn't error on a click.
  // A start of the hand-filed follow-up: refused the way its owner's
  // `shuttle reopen` refuses it, until the board sends a confirmed directory.
  if (url.endsWith('/api/v1/dispatch') && body().fiber_id === BARE_FOLLOW_UP && !body().project_dir) {
    return json({
      dispatched: false,
      reason: 'arm_refused',
      fiber_id: BARE_FOLLOW_UP,
      host: FOREIGN_HOST,
      needs: 'project_dir',
      message:
        `cannot arm ${BARE_FOLLOW_UP}: its shuttle: block has no project_dir ` +
        `(set it as you arm it: shuttle reopen ${BARE_FOLLOW_UP} --project-dir <dir>)`,
    }, 422)
  }
  if (url.includes('/api/v1/map/terrain')) {
    return json(mapTerrainFixture())
  }
  if (url.includes('/api/v1/')) return json({ ok: true })

  return realFetch(input as RequestInfo, init)
}) as typeof fetch

// ── Mount ────────────────────────────────────────────────────────────────────
// Wire the lane actions so every available button can be exercised offline.
// Terminal writes its selected session to the document for harness inspection;
// KanbanModal owns polling the composite feed and its recovery action.
const page = search.get('page')
if (page) {
  document.querySelectorAll('.sim-corner').forEach(element => element.remove())
  const host = document.createElement('div')
  host.id = 'app'
  host.style.cssText = 'position:fixed; inset:0;'
  document.body.append(host)
  mountPage(host, parsePageRoute(window.location), '')
  ;(window as unknown as { __harness: unknown }).__harness = { requests: mockRequests, handlers: mockHandlers }
} else try {
  assertUlids()
  const modal = new KanbanModal({
    onStashClick: () => { void openStash({ shuttleBase: '' }) },
    onNewIdeaClick: () => { void openCapture({ shuttleBase: '', onResult: (message, ok) => showToast(message, ok ? 'success' : 'error') }) },
    onOpenWorker: (session, host) => {
      document.body.dataset.harnessTerminalSession = session
      harnessEvents.push({ type: 'open-worker', session, host: host ?? null })
    },
    onSettingsClick: () => { void openSettings({ shuttleBase: '' }) },
    shuttleBase: '',
  })

  const host = document.createElement('div')
  host.style.cssText = 'position:fixed; inset:0;'
  document.body.append(host)
  modal.mount(host)
  if (workspaceFixture && transcriptScenario === 'search') {
    window.setTimeout(() => {
      const desk = host.querySelector<HTMLButtonElement>('[data-view="desk"]')
      desk?.click()
      const find = host.querySelector<HTMLInputElement>('.kbn-viewtabs-find input[type="search"]')
      if (find) {
        find.value = 'mask'; find.focus(); find.dispatchEvent(new Event('input', { bubbles: true }))
        // Transcripts at the board's scope are read when asked.
        find.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }))
      }
    }, 500)
  }
  if (search.has('capture')) void openCapture({ shuttleBase: '', onResult: (message, ok) => showToast(message, ok ? 'success' : 'error') })

  // expose for agent-browser-driven interaction.
  ;(window as unknown as { __harness: unknown }).__harness = {
    modal,
    scopeTheme,
    /** What the board holds, as the installed web app reports it each minute. */
    holdings,
    /** Lays a sent file's thumbnail on the page to read what it draws. */
    thumbnail(basename: string): HTMLElement | null {
      const sent = workspaceFixture?.receipts.find(file => String(file.basename) === basename)
      if (!sent) return null
      const thumb = new Thumbnail({
        key: `thumb:${basename}`, shuttleBase: '', className: 'harness-preview-thumb', fallback: basename, captioned: false,
        file: { fullPath: String(sent.fullPath), owner: String(sent.host), basename },
        priority: () => 2, distance: () => 0,
      })
      thumb.el.style.cssText = 'position:fixed; right:16px; bottom:16px; width:320px; height:200px; z-index:9999'
      thumb.el.dataset.harnessThumb = basename
      document.body.append(thumb.el)
      thumb.schedule()
      return thumb.el
    },
    MOCK_FEED: workspaceFixture?.feed ?? docsExample?.feed ?? MOCK_FEED,
    /** Channels' board records and dismissals, for a journey to post into. */
    channels: channelsFixture,
    requests: mockRequests,
    handlers: mockHandlers,
    events: harnessEvents,
    windowless,
    nativeFiles: nativeWorkspaceFiles,
    files: workspaceFixture?.files,
  }
} catch (err) {
  const pre = document.createElement('pre')
  pre.style.cssText = 'position:fixed; inset:20px; white-space:pre-wrap; color:#A2362A; font:13px monospace; z-index:99999;'
  pre.textContent = `HARNESS MOUNT ERROR:\n${(err as Error)?.stack ?? String(err)}`
  document.body.append(pre)
  ;(window as unknown as { __bootErr: unknown }).__bootErr = String((err as Error)?.stack ?? err)
}
