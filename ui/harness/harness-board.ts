/**
 * Offline verification harness for the Board surface.
 *
 * It builds a self-contained IIFE bundle that mounts the real `KanbanModal`
 * against mocked daemon routes, then opens from `file://`. The feed still runs
 * through the board's real classifier (`parseCompositeFeed` →
 * `buildKanbanResponseFromComposite`), so the DOM and CSS are production code.
 * Query `?meeting=` to stage a meeting: `joined` (folded into the constitution
 * it joined), `scribe` (a capture whose scribe has claimed, found by its
 * session), `live` (a capture not yet claimed, on its own card) or `failed`;
 * leave it unset to exercise the idle board. Add `?capture=meeting` to open
 * Capture with the daemon reporting meeting support.
 * `?example=workshop` selects the fictional, single-machine documentation example.
 *
 * The SETTINGS sheet is exercised the same way and is the one surface here
 * that is stateful: the stub keeps an in-memory copy of each host's operator
 * files, so a save round-trips and the rows above it change. It answers for
 * two hosts, because a host picker with one entry cannot show the thing it
 * exists to show. It does NOT validate — the daemon delegates that to the tool
 * that owns each grammar, and there is no felt here to ask, so a refusal is
 * the one behaviour this harness cannot stand in for.
 *
 * Chronicle (hotkey 2) is exercised the same way: `MOCK_TEMPORAL` below
 * injects a deterministic activity plane and the two ledgers as the
 * `TemporalFetchers` the board would otherwise build over `/api/v1/activity`,
 * `/sessions` and `/commits`, so the page renders with no daemon to serve it. The mock mirrors the FETCHER contract — one-minute
 * buckets, and ledger records over an instant range — so what the views are
 * exercised against is the shape they really receive.
 *
 * Build: `npm run harness:board`; open the emitted
 * harness-board-dist/index.html via file://. The page ships with the bundle,
 * so the output directory is self-sufficient — nothing to copy in by hand.
 */
import { KanbanModal } from '../src/board/KanbanModal.js'
import { workshopExample } from './workshop-example.js'
import { installWorkspaceNativeURLs, WORKSPACE_HOST, workspaceExample } from './workspace-fixtures.js'
import { openCapture, openStash, openSettings } from '../src/forms/mountForms.js'
import { showToast } from '../src/board/utils.js'
import type {
  ActivityBucket,
  ActivityResult,
  CommitRecord,
  SessionRecord,
  TemporalFetchers,
  TemporalOrigins,
} from '../src/board/views/index.js'

// ── Mock composite feed ──────────────────────────────────────────────────────
// Shaped exactly like the daemon's `GET /api/v1/fibers/composite` body, so
// KanbanModal's own parser + classifier route each fiber to its lane:
//   • status:open   + shuttle block          → Drafts
//   • status:active + shuttle block          → In flight (a running worker on
//                                              one, via `runtime.tmux_session`)
//   • status:closed + no `tempered`          → Awaiting review
const FOREIGN_HOST = 'basalt-login-02'
const now = Date.now()
const example = new URLSearchParams(window.location.search).get('example')
const docsExample = example === 'workshop' ? workshopExample(now) : null
const workspaceFixture = example === 'workspace' ? workspaceExample(now) : null
const nativeWorkspaceFiles = workspaceFixture ? installWorkspaceNativeURLs(workspaceFixture) : null
if (docsExample || workspaceFixture) document.querySelectorAll('.sim-corner').forEach(element => element.remove())
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString()
const meetingScenario = new URLSearchParams(window.location.search).get('meeting')
const MOCK_TAIL = [
  '14:02:51 me  okay, I think everyone is here, let us start with the null tests',
  '14:03:12 S1  so the chi-squared for the B-modes came back at forty-one for thirty-six bins',
  '14:03:30 S2  that is a PTE of about a quarter, which is fine',
  '14:03:44 me  and the Hartlap factor is in there?',
  '14:03:49 S1  yes, with the three hundred simulations',
  '14:04:10 S2  what worries me more is the mask split, the north patch looks a bit high',
  '14:04:31 me  Claude, can you pull up the per-patch PTEs from last week?',
  '14:04:58 S1  I would not over-read one patch out of six',
  '14:05:20 me  fair, but let us rerun it with the updated mask before we call it',
  '14:05:40 S2  the covariance looks fine, but we should rerun the mask split before calling the comparison settled',
]
let mockMeeting: Record<string, unknown> | null = meetingScenario === 'live' || meetingScenario === 'joined' || meetingScenario === 'scribe'
  ? {
      state: 'live',
      title: 'Shear telecon',
      mirror_host: 'project-host',
      fiber: meetingScenario === 'joined' ? 'work/spt3g_papers/bmodes-2d/run' : null,
      scribe_session_uuid: meetingScenario === 'scribe' ? '6bc045dc-92e0-473a-bf9e-e1cc263223bc' : null,
      started_at: iso(-13 * 60_000 - 12_000),
      tail: MOCK_TAIL,
      transcript: null,
      tmux_session: 'hark-meeting',
      error: null,
    }
  : meetingScenario === 'failed'
    ? {
        state: 'failed',
        title: 'Shear telecon',
        mirror_host: null,
        fiber: null,
        scribe_session_uuid: null,
        started_at: iso(-2 * 60_000),
        tail: [],
        transcript: null,
        tmux_session: 'hark-meeting',
        error: 'Could not connect to the selected scribe host.',
      }
    : null

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
 * LOAD-BEARING, do not normalize away. Chronicle prints a row's hostname only
 * when that row ran elsewhere (a note matching the page host is suppressed,
 * because a hostname repeated on every row is a constant pretending to be
 * information). With every mock fiber on `ada-workstation` — which is also the
 * mock activity's `host` — that path could never fire, and a note that never
 * renders looks exactly like a note that is correctly suppressed. Exactly one
 * fiber wears this so both branches are visible at once: one row with a
 * hostname, the rest bare.
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

/** A standing role's block — the chip trail renders its cron humanized. */
const standingBlock = (expr: string) => ({
  ...shuttleBlock('standing'),
  schedule: { expr, tz: 'Europe/Paris' },
})

/** Civil day N days from today, as the bare `YYYY-MM-DD` felt writes. */
const civilDay = (offsetDays: number) => {
  const d = new Date(now + offsetDays * 86_400_000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Every mock fiber that runs carries a ULID, as a real one does: a Shuttle
 * worker runs in `<leaf>-<ULID>-shuttle`, the session ledger records the
 * fiber's `uid` beside its id (Chronicle's join falls back to it when the id
 * does not resolve), and the card drawer's History asks the ledger BY uid.
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
  shuttle?: ReturnType<typeof shuttleBlock> & { surface?: string }
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
    outcome: 'Dissolve the masthead; fold its three actions into the column heads as one tinted round-button family.',
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

// In flight: the older, busy run belongs in Working; the newer paused
// reimbursement belongs in Needs you. Activity age does not rank either band.
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

// Awaiting review (status:closed, no `tempered`).
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

// A standing role, for the humanized-cron summary in the fiber controls.
const STANDING: MockFiber[] = [
  {
    id: 'loom/email/morning-post/run',
    uid: ULID.morningPost,
    name: 'Morning post',
    status: 'active',
    outcome: 'Groups the routine auto-archives; itemizes the signal.',
    tags: ['loom', 'email'],
    shuttle: standingBlock('0 9 * * 1-5'),
  },
]

/**
 * PINNED — resting `kind:pinned` umbrella roles, parked on the Desk's launcher
 * band. Enough of them to wrap the band several rows deep, because the band
 * has no row cap and no "+N more" pager (a role you reach for daily should
 * never be on page 2). None carry a `uid` — the band never joins a pinned chip
 * to the activity plane, only Chronicle does.
 */
const PINNED: MockFiber[] = [
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
  id: `roles/pinned-${i}`,
  name,
  status: 'active',
  outcome: `Launcher role: ${name}.`,
  tags: ['pinned'],
  shuttle: shuttleBlock('pinned'),
}))

/**
 * CYCLES — `cycle`-tagged fibers, each a named span of time. Chronicle draws
 * them as bands above the work, the Desk offers them as lenses, and they
 * appear in NO desk column: `classifyFiber` routes a cycle to `response.cycles`
 * and nowhere else, so the column counts never see one.
 *
 * Without a band on screen there is nothing to click offline, so one live
 * cycle spans today (a band is visible whenever the harness is opened), one
 * runs open-ended, and one closed last week, giving Chronicle current, unbounded
 * and past spans to place.
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
    // OPEN-ENDED — a `start:` and no `due:`. `cycleSpan` clamps its end to
    // today, so it draws as a band with no right edge yet rather than a span
    // that happens to stop. That is a distinct render path from the dated
    // cycle above, and this is the only card exercising it.
    id: 'loom/cycles/rentree-push',
    uid: ULID.rentreePush,
    name: 'rentrée push',
    status: 'open',
    outcome: 'Everything that has to be standing before the lab fills up again in September.',
    tags: ['cycle'],
    start: civilDay(-12),
  },
  {
    // WHOLLY PAST — started and ended before today, closed last week. The two
    // above both reach the present, so without this one Chronicle never draws a
    // band that lies entirely behind today.
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

const APP_THREAD = '01a0be38-6c36-7cd1-aec9-53a680d1f693'
const APP_CONVERSATION = fiber({
  id: 'operator/app-conversation',
  uid: '01KVBR2G7CXDWMG85592QW78ZZ',
  name: 'App conversation continuity',
  status: 'active',
  created_at: iso(-1 * 86_400_000),
  outcome: 'Continue this conversation from the ChatGPT app on desktop or phone.',
  shuttle: shuttleBlock(),
})

/** The follow-up whose start the mock daemon refuses for want of a
 *  project_dir (see the `/api/v1/dispatch` stub). */
const BARE_FOLLOW_UP = 'work/spt3g_papers/bmodes-2d/run/new-mask'

const MOCK_FEED = {
  host: 'local',
  generated_at: iso(0),
  fibers: [
    ...DRAFTS.map(fiber),
    {
      ...APP_CONVERSATION,
      origin: 'ada-workstation',
      fiber: {
        ...APP_CONVERSATION.fiber,
        shuttle: {
          ...shuttleBlock(),
          agent: 'codex-luna',
          surface: 'app',
          runtime: { session_uuid: APP_THREAD },
        },
      },
      runtime: {
        state: 'running',
        desktop_link: `codex://threads/${APP_THREAD}`,
        last_activity_at: now,
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
            last_activity_at: now - 4_000,
          },
        }
      }
      // The second one has been stopped at a prompt for hours — the case the
      // aged `⏸ waiting · 3h` pill exists for. Its session is bridged, so under
      // a finger the pill links to it in the Claude app.
      return {
        ...e,
        origin: f.shuttle?.host ?? LOCAL_HOST,
        runtime: {
          state: 'running',
          tmux_session: sessionFor(f.id, f.uid ?? ''),
          session_link: 'https://claude.ai/code/session_harness-waiting',
          phase: 'waiting',
          last_activity_at: now - (3 * 3_600_000 + 12 * 60_000),
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
    ...PINNED.map(fiber),
    // An older pinned role with a live Codex app worker that raised its hand.
    // It sits BELOW the newer waiting reimbursement inside Needs you, not at
    // the top by urgency. No tmux session: liveness and the app link are native.
    {
      ...fiber({
        id: 'roles/pinned-app',
        name: 'codex app role',
        status: 'active',
        created_at: iso(-7 * 86_400_000),
        outcome: 'The app worker needs a decision about the next run.',
        tags: ['pinned'],
        shuttle: { ...shuttleBlock('pinned'), agent: 'codex-sol', surface: 'app' },
      }),
      origin: 'ada-workstation',
      runtime: {
        state: 'running',
        phase: 'attention',
        surface: 'app',
        tmux_session: null,
        session_uuid: '01a0be38-6c36-7cd1-aec9-53a680d1f693',
        agent: 'codex-sol',
        last_activity_at: now - 25 * 60_000,
        desktop_link: 'codex://threads/01a0be38-6c36-7cd1-aec9-53a680d1f693',
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
    local: { kind: 'local', stale: false, last_polled_at: iso(0), fiber_count: 12 },
    kelvin: { kind: 'remote', stale: true, last_polled_at: iso(-3_600_000), fiber_count: 1 },
  },
}

// ── Mock temporal read plane ─────────────────────────────────────────────────
//
// The daemon serves `GET /api/v1/activity`, `/sessions` and `/commits`, but
// the harness has no daemon at all — it runs off `file://` with a stubbed
// `fetch`. So it injects a `TemporalFetchers` set directly, standing in for
// those routes and mirroring their wire contract rather than the transport.
//
// SEEDED, NOT RANDOM: every span, actor and count is derived from absolute
// clock position through mulberry32, so two loads of the same window produce
// byte-identical data and a screenshot diff means a real change. The window
// itself is now-relative because the mock feed is (its fibers are dated off
// `now`), so the views cover the same three days the board's cards do.

const FEED_SPAN_MS = 3 * 86_400_000
/**
 * ONE MINUTE, matching the wire. `Shuttle.Activity` buckets on a fixed
 * `@minute_ms 60_000` grid, unconditionally — there is no coarser mode and no
 * width field on the wire for a client to infer from. A coarser mock grid
 * would under-report every duration by the factor between the two, a harness
 * artifact that any glance would blame on the page.
 */
const BUCKET_MS = 60_000

/** mulberry32 — a small deterministic PRNG. Same seed, same stream. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a over a string — a stable seed for anything keyed by a civil day
 *  rather than by a number. Keyed on the DAY STRING, not on an epoch-day
 *  index, so the same civil day seeds identically in every timezone. */
function seedFromString(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * Who was working, and where. Each entry is one (session, cwd) actor the
 * generator draws from, `weight` copies of it in the draw pool.
 *
 * Chronicle draws only work the session ledger (join rung 0) or a live
 * worker's tmux name (rung 1) places on a fiber, so the pool mixes both kinds
 * of claim with the work it must NOT draw:
 *
 *   JOINED      the first four, paired by the ledger — ink on their rows.
 *   LEDGER-ONLY `pi-2f9c41`, whose tmux name names no fiber at all; only the
 *               ledger can say whose work it was.
 *   UNPAIRED    `scratch-shuttle`, a session the ledger never recorded, and
 *               the two with `s: null` (a human at a shell). None of them may
 *               conjure a row.
 */
const MOCK_ACTORS: Array<{
  s: string | null
  cwd: string | null
  weight: number
  /** Which daemon produced these minutes. Omitted is this host. Exactly one
   *  actor runs elsewhere — the b-mode sweep, whose fiber already carries
   *  `shuttleBlockElsewhere` — so the cross-host register (a row's host note,
   *  and the stale gray of an unreachable remote) is visible offline. */
  host?: string
}> = [
  {
    s: sessionFor('work/spt3g_papers/bmodes-2d/run', ULID.bmodes),
    cwd: '/leonardo_work/spt3g/papers',
    weight: 5,
    host: FOREIGN_HOST,
  },
  { s: sessionFor('loom/email/morning-post/refine', ULID.refine), cwd: '/home/ada/loom', weight: 4 },
  { s: sessionFor('work/euclid/euclid-github/triage', ULID.triage), cwd: '/home/ada/work/euclid', weight: 3 },
  { s: sessionFor('work/admin/conference-travel-receipts', ULID.receipts), cwd: '/home/ada/loom', weight: 2 },
  // LEDGER-ONLY: nothing in the name says whose it is; the session ledger
  // pairs it to photoz-systematics, and that pairing is the whole join.
  { s: 'pi-2f9c41', cwd: '/home/ada/work/photoz', weight: 3 },
  { s: 'scratch-shuttle', cwd: '/home/ada/scratch', weight: 3 },
  { s: null, cwd: '/home/ada/dev/felt', weight: 3 },
  { s: null, cwd: '/home/ada/notes', weight: 2 },
]
const ACTOR_POOL = MOCK_ACTORS.flatMap((a) => Array<typeof a>(a.weight).fill(a))

const HOUR_MS = 3_600_000
/** A span can run past the hour that spawned it, so generation starts this far
 *  back of the window to catch one that spills into it. Comfortably longer than
 *  the longest span below. */
const SPAN_LOOKBACK_HOURS = 2

/** Sessions per hour and their length, by time of day. Work arrives in RUNS,
 *  not as independent minutes — that is the whole reason for spans. */
function hourShape(hour: number): { spans: number; minLen: number; maxLen: number } {
  if (hour < 7) return { spans: 0.35, minLen: 3, maxLen: 12 }     // small hours: rare, short
  if (hour < 10) return { spans: 1.6, minLen: 6, maxLen: 25 }     // morning ramp
  if (hour < 19) return { spans: 2.4, minLen: 8, maxLen: 40 }     // the working day
  return { spans: 1.1, minLen: 5, maxLen: 20 }                    // evening tail
}

/**
 * Generate the activity buckets covering [fromMs, toMs) on the wire's OWN
 * one-minute grid — one bucket per `{minute, session, cwd, kind}`, exactly as
 * `Shuttle.Activity` aggregates them.
 *
 * Work is generated as SPANS, not as independently sampled minutes. Sampling
 * each minute on its own would put a 60_000ms grid at whatever per-minute
 * probability you pick and produce uniform static — no runs to merge, no
 * spells to draw, and a duration total that is really just a coin-flip
 * count. Instead each absolute HOUR seeds its own handful of spans
 * (start minute, length, actor), and every minute inside a span emits a
 * bucket. Density lives in how much of the hour the spans cover, which is what
 * a duration total is actually measuring.
 *
 * Generation is keyed on ABSOLUTE hour index, never on the requested window,
 * so two chunks — or a chunk and a wider window — agree exactly on their
 * overlap. Generation starts SPAN_LOOKBACK_HOURS early so a span that
 * began before `fromMs` still contributes the minutes that fall inside it.
 *
 * Never emits a bucket later than page load: a window that runs to the end of
 * the civil day would otherwise draw work the machine has not done yet, and a
 * row inked past today reads as a rendering bug.
 */
function mockActivity(fromMs: number, toMs: number): ActivityResult {
  // Keyed exactly as the daemon keys them — {minute, session, cwd, kind} — so
  // two spans by the same actor overlapping one minute MERGE into a single
  // bucket with summed `n`, rather than emitting a duplicate key the real feed
  // could never produce.
  const byKey = new Map<string, ActivityBucket>()
  const add = (bucket: ActivityBucket): void => {
    const key = `${bucket.host ?? ''}|${bucket.m}|${bucket.s ?? ''}|${bucket.cwd ?? ''}|${bucket.k}`
    const hit = byKey.get(key)
    if (hit) hit.n += bucket.n
    else byKey.set(key, bucket)
  }
  const endMs = Math.min(toMs, now)
  const firstHour = Math.floor(fromMs / HOUR_MS) - SPAN_LOOKBACK_HOURS
  const lastHour = Math.floor(endMs / HOUR_MS)

  for (let hourIndex = firstHour; hourIndex <= lastHour; hourIndex += 1) {
    const hourStart = hourIndex * HOUR_MS
    const rng = seeded(hourIndex)
    const shape = hourShape(new Date(hourStart).getHours())
    // Fractional span counts read as a probability for the last one.
    const spanCount = Math.floor(shape.spans) + (rng() < shape.spans % 1 ? 1 : 0)

    for (let s = 0; s < spanCount; s += 1) {
      const startMinute = Math.floor(rng() * 60)
      const length = shape.minLen + Math.floor(rng() * (shape.maxLen - shape.minLen + 1))
      const actor = ACTOR_POOL[Math.floor(rng() * ACTOR_POOL.length)]
      // One notify per span at most, and only sometimes: the agent raising its
      // hand is an event, not a texture.
      const notifyAt = rng() < 0.35 ? Math.floor(rng() * length) : -1

      for (let i = 0; i < length; i += 1) {
        const m = hourStart + (startMinute + i) * BUCKET_MS
        if (m < fromMs || m >= endMs) continue
        const mRng = seeded(Math.floor(m / BUCKET_MS))
        // A span is the agent's own time, punctuated by the human. The first
        // minute is nearly always attention — that is the prompt that started
        // it — and a steer lands here and there after.
        const steering = i === 0 ? mRng() < 0.8 : mRng() < 0.06
        if (steering) {
          add({ m, s: actor.s, cwd: actor.cwd, k: 'attention', n: 1, host: actor.host ?? LOCAL_HOST })
        }
        // The agent works through the minute regardless (a steer and the work
        // it provokes share a minute — two buckets, distinct `k`, exactly as
        // the daemon would key them).
        if (i > 0 || !steering) {
          add({ m, s: actor.s, cwd: actor.cwd, k: 'agent', n: 1 + Math.floor(mRng() * 11), host: actor.host ?? LOCAL_HOST })
        }
        if (i === notifyAt) {
          add({ m, s: actor.s, cwd: actor.cwd, k: 'notify', n: 1, host: actor.host ?? LOCAL_HOST })
        }
      }
    }
  }
  // The daemon streams its events in file order, so buckets arrive roughly
  // time-ordered; sort so the mock does not accidentally exercise a tolerance
  // the real feed never asks a view for.
  const buckets = [...byKey.values()].sort((a, b) => a.m - b.m)
  return {
    host: LOCAL_HOST,
    from_ms: fromMs,
    to_ms: toMs,
    buckets,
    // The remote's cache covers the trailing day only, and it has not answered
    // in an hour. Both are ordinary states, not errors: its lanes keep their
    // last-good ink in the stale register, and thin out before the window it
    // can speak for.
    origins: {
      ...MOCK_ORIGINS,
      [FOREIGN_HOST]: { ...MOCK_ORIGINS[FOREIGN_HOST], window: { fromMs: now - 86_400_000, toMs: now } },
    },
  }
}

/**
 * felt's commit convention is `<slug>: what happened`. Chronicle attributes a
 * commit by its recorded session, never by the prefix, and strips the prefix
 * off the prose it sets — so the subjects mix real mock-fiber slugs, slugs no
 * card answers to, and one with no prefix at all, and every one of them must
 * land on the fiber its SESSION names.
 */
const MOCK_SUBJECTS = [
  'triage: sort the open issues by milestone',
  'refine: group the routine auto-archives by category',
  'sweep: record the live-session resolutions',
  'daily-digest: stage the bib entries for four papers',
  'board-chrome-redesign: fold the masthead actions into the column heads',
  'daemon: owner-route the felt-edit write plane',
  'poller: back off a stale remote instead of retrying hot',
  'tidy the leftover scaffolding from the last pass',
]

/**
 * The COMMIT LEDGER over an instant range — `GET /api/v1/commits`, one record
 * per commit, each stamped with the harness session that made it.
 *
 * Every record is attributed to one of {@link MOCK_SESSIONS}, because that is
 * the only way a commit reaches a page: the views join `record.session` through
 * the session ledger to a fiber, and a record naming no known session is drawn
 * nowhere. A mock that emitted bare subject lines would exercise a path
 * production does not have.
 */
const MAX_LEDGER_DAYS = 400

function mockCommits(fromMs: number, toMs: number): CommitRecord[] {
  if (!(toMs >= fromMs)) return []
  const sessions = MOCK_SESSIONS.filter((r) => r.session)
  const records: CommitRecord[] = []
  const first = new Date(fromMs)
  for (let offset = 0; offset < MAX_LEDGER_DAYS; offset += 1) {
    const day = new Date(first.getFullYear(), first.getMonth(), first.getDate() + offset)
    if (day.getTime() > toMs) break
    const dayISO = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
    const rng = seeded(seedFromString(dayISO))
    const count = 4 + Math.floor(rng() * 5)
    // Walk the subject list from a seeded start with a seeded ODD stride.
    // MOCK_SUBJECTS.length is a power of two, so any odd stride is coprime
    // with it and the walk visits distinct subjects — a day never repeats one.
    // Drawing independently did repeat, and two identical subjects under one
    // fiber render as `…; …` prose that reads like a duplication bug.
    const subjectStart = Math.floor(rng() * MOCK_SUBJECTS.length)
    const subjectStride = 1 + 2 * Math.floor(rng() * (MOCK_SUBJECTS.length / 2))
    for (let i = 0; i < count; i += 1) {
      // Local 09:00-21:00, spread across the day and ordered by construction.
      const minutes = Math.floor((9 + (12 * (i + rng())) / count) * 60)
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes).getTime()
      if (at < fromMs || at > toMs) continue
      const source = sessions[Math.floor(rng() * sessions.length)]
      records.push({
        at,
        // 40 hex digits: the parser drops anything else, exactly as the
        // daemon's does.
        sha: `${dayISO.replace(/-/g, '')}${String(i).padStart(2, '0')}`.padEnd(40, 'f'),
        subject: MOCK_SUBJECTS[(subjectStart + i * subjectStride) % MOCK_SUBJECTS.length],
        repo: null,
        files: 1 + Math.floor(rng() * 6),
        insertions: Math.floor(rng() * 120),
        deletions: Math.floor(rng() * 40),
        session: source.session,
        tmux: source.tmux,
        cwd: null,
        host: source.host ?? null,
      })
    }
  }
  return records.sort((a, b) => a.at - b.at)
}

/**
 * The session ledger — `GET /api/v1/sessions`, one line per fiber↔session
 * pairing. Chronicle joins activity buckets through it as RUNG 0.
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
  return {
    host,
    links: ids.map((session) => {
      const record = APP_SESSIONS.find((r) => r.session === session)
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
const MOCK_SENT_FILES = [
  { fullPath: '/work/shear/results/b-mode-null.png', uid: 'work/euclid/photoz-systematics/reread', at: -40 * 60_000 },
  { fullPath: '/work/shear/report/null-tests.html', uid: 'work/euclid/photoz-systematics/reread', at: -3 * 3_600_000 },
  { fullPath: '/work/kanban/board-chrome.pdf', uid: 'ai-futures/portolan/standalone-kanban/board-chrome-redesign', at: -5 * 3_600_000 },
  { fullPath: '/work/arxiv/digest.md', uid: 'work/arxiv/daily-digest', at: -9 * 3_600_000 },
  { fullPath: '/work/cycles/chains.tar.gz', uid: 'work/cycles/shear-paper-sprint', at: -26 * 3_600_000, host: FOREIGN_HOST },
].map(({ fullPath, uid, at, host }) => ({
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

const MOCK_TEMPORAL: TemporalFetchers = {
  activity: (fromMs, toMs) => Promise.resolve(mockActivity(fromMs, toMs)),
  // Oldest first, and filtered by the bound, exactly as the daemon serves it.
  sessions: (sinceMs) =>
    Promise.resolve({
      host: LOCAL_HOST,
      records: MOCK_SESSIONS.filter((r) => r.at >= sinceMs).sort((a, b) => a.at - b.at),
      origins: MOCK_ORIGINS,
    }),
  commits: (fromMs, untilMs) =>
    Promise.resolve({ host: LOCAL_HOST, records: mockCommits(fromMs, untilMs), origins: MOCK_ORIGINS }),
}

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
  contract: { ok: true, expected: 2, observed: 2, reason: null },
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
const realFetch = (window as unknown as { __harnessNativeFetch?: typeof fetch }).__harnessNativeFetch ?? window.fetch.bind(window)
const mockRequests: Array<Record<string, unknown>> = []
const mockHandlers: Array<Record<string, unknown>> = []
const harnessEvents: Array<Record<string, unknown>> = []
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const method = (init?.method ?? 'GET').toUpperCase()
  const request = { url, method, body: typeof init?.body === 'string' ? init.body : null }
  mockRequests.push(request)
  mockHandlers.push({ method, path: new URL(url, 'http://harness.invalid').pathname })
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const body = (): Record<string, unknown> => {
    try {
      return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  const bodyOrigin = (): string => (body().origin as string) || LOCAL_HOST

  // The board's composite feed and the local-only meeting control plane.
  if (url.includes('/api/v1/fibers/composite')) return json(workspaceFixture?.feed ?? docsExample?.feed ?? MOCK_FEED)
  if (workspaceFixture && url.includes('/api/v1/fibers/') && url.includes('body=true')) {
    const id = decodeURIComponent(url.split('/api/v1/fibers/')[1].split('?')[0])
    const row = workspaceFixture.feed.fibers.find(entry => (entry.fiber as Record<string, unknown>).id === id)
    if (row) {
      const fiber = row.fiber as Record<string, unknown>
      return json({ fibers: [{ ...row, fiber: { ...fiber, body: workspaceFixture.bodies[id] ?? fiber.outcome ?? '' } }] })
    }
    if (id === 'research/workspace/method-note') {
      return json({ fibers: [{
        origin: WORKSPACE_HOST,
        felt_store: '/fixture-store/workspace',
        path: '.felt/research/workspace/method-note/method-note.md',
        dir: '/fixture-store/workspace/.felt/research/workspace/method-note',
        fiber: {
          id, uid: '01KVBR6M1GJ0ZRM29956V023R3', name: 'Method note', status: 'closed',
          outcome: 'The response correction uses independent simulations.',
          body: workspaceFixture.bodies[id], tags: ['workspace'],
          shuttle: { kind: 'oneshot', host: WORKSPACE_HOST, agent: 'claude-opus', project_dir: '/fixture-store/workspace' },
        },
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
  if (url.endsWith('/api/v1/fibers')) {
    if (workspaceFixture) return json({ fibers: [...workspaceFixture.feed.fibers, { fiber: { id: 'research/workspace/method-note', name: 'Method note' } }] })
    if (docsExample) return json({ fibers: docsExample.feed.fibers })
    return json({ fibers: [...MOCK_FEED.fibers, { fiber: { id: 'work/spt3g_papers/bmodes-2d/null-suite', name: 'Null-test suite' } }] })
  }
  if (url.endsWith('/api/v1/meeting/stop')) {
    if (!mockMeeting) return json({ error: 'No meeting to stop' }, 404)
    mockMeeting = mockMeeting.state === 'failed' ? null : { ...mockMeeting, state: 'stopping' }
    return json({ meeting: mockMeeting }, 202)
  }
  if (url.endsWith('/api/v1/meeting')) return json({ available: true, modes: ['call', 'room', 'phone'], meeting: mockMeeting })
  if (url.endsWith('/api/v1/meeting/join') && init?.method === 'POST') {
    const request = body()
    if (mockMeeting && mockMeeting.state !== 'failed') return json({ error: 'a meeting is already active', meeting: mockMeeting }, 409)
    const fiber = String(request.fiber_id ?? '')
    mockMeeting = {
      state: 'starting',
      title: String(request.note ?? '').split('\n')[0] || fiber.split('/').pop() || 'Meeting',
      started_at: null,
      tail: [],
      scribe_session_uuid: null,
      transcript: null,
      mirror_host: request.origin === 'local' ? null : 'project-host',
      fiber,
      tmux_session: 'hark-meeting',
      error: null,
    }
    return json({ meeting: mockMeeting, delivery: { delivered: true, delivery: 'message' } })
  }
  if (url.endsWith('/api/v1/capture') && init?.method === 'POST') {
    const request = body()
    if (request.meeting && typeof request.meeting === 'object') {
      const prompt = String(request.prompt ?? '').trim()
      mockMeeting = {
        state: 'starting',
        title: prompt.split('\n')[0] || 'Meeting',
        started_at: null,
        tail: [],
        scribe_session_uuid: null,
        transcript: null,
        mirror_host: request.origin === 'local' ? null : 'project-host',
        fiber: null,
        tmux_session: 'hark-meeting',
        error: null,
      }
      return json({ spawned: true, tmux_session: 'capture-scribe', surface: 'cli', meeting: mockMeeting }, 202)
    }
    return json({ spawned: true, tmux_session: 'capture-session', surface: 'cli' }, 202)
  }

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
      files: ['stores', 'projects', 'agents', 'remotes', 'host'].map((id) => settingsSummary(host, id)),
    })
  }
  if (url.includes('/api/v1/fleet')) {
    if (init?.method === 'POST') return json({ ok: true, host: bodyOrigin(), output: 'saved (harness)' })
    return json(mockFleet(settingsOrigin(url)))
  }
  if (url.includes('/api/v1/tunnels')) {
    return json({ ok: true, host: bodyOrigin(), output: 'would install hub-a -> ~/Library/LaunchAgents/io.shuttle.shuttle-tunnel-hub-a.plist' })
  }
  if (url.includes('/api/v1/agents')) return json(MOCK_AGENTS)
  // NOT owner-routed, on purpose (see settingsApi's loadVersion doc) — always
  // this harness's own local-host state, regardless of any `?origin=`.
  if (url.includes('/api/v1/version')) {
    return json({
      ...mockBuild('a1b2c3d', 7_200_000),
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
  // Kitty takes a moment; a row shows it pending meanwhile.
  if (url.endsWith('/api/v1/attach')) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    return json({ attached: true })
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

  if (url.includes('/api/v1/sent-files/all/composite')) {
    if (workspaceFixture) return json({ files: workspaceFixture.receipts, origins: workspaceFixture.feed.origins })
    if (docsExample) return json({ files: [], origins: docsExample.feed.origins })
    return json({ files: MOCK_SENT_FILES, origins: MOCK_ORIGINS })
  }
  // A text card's body. Images, pages and PDFs load by URL, not through
  // fetch, so offline they stay faces.
  if (url.includes('/api/v1/file')) {
    if (workspaceFixture) return workspaceFixture.fileResponse(url, method)
    return new Response('# Daily digest\n\nThree cosmic-shear papers and one CMB-lensing cross-correlation.\n', {
      headers: { 'Content-Type': 'text/plain' },
    })
  }

  // The composer's pasted images: stored "on" the owning host, answered with
  // the paths a directive names. The last directive sent is left on the
  // document so a driving script can read what the worker would receive.
  if (url.endsWith('/api/v1/attachments') && init?.method === 'POST') {
    const request = body()
    const items = (request.attachments as { name?: string; mime?: string; sha256?: string }[]) ?? []
    const home = request.origin && request.origin !== 'local' ? '/home/ada-remote' : '/home/ada'
    const dir = `${home}/.shuttle/attachments/${String(request.fiber ?? '').replace(/[^A-Za-z0-9_-]/g, '-')}`
    const ext: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
    return json({
      files: items.map((item) => ({
        name: item.name,
        path: `${dir}/${String(item.sha256 ?? '').slice(0, 16)}.${ext[item.mime ?? ''] ?? 'png'}`,
        sha256: item.sha256,
        size: 0,
      })),
    })
  }
  if (url.endsWith('/api/v1/dispatch') && init?.method === 'POST') {
    document.body.dataset.harnessLastDirective = String(body().user_message ?? '')
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
  if (url.includes('/api/v1/')) return json({ ok: true })

  return realFetch(input as RequestInfo, init)
}) as typeof fetch

// ── Mount ────────────────────────────────────────────────────────────────────
// Wire the lane actions so every available button can be exercised offline.
// Terminal writes its selected session to the document for harness inspection;
// onRefresh is owned internally by KanbanModal.
try {
  assertUlids()
  const modal = new KanbanModal({
    onStashClick: () => { void openStash({ shuttleBase: '' }) },
    onNewIdeaClick: () => { void openCapture({
      shuttleBase: '',
      onResult: (message, ok) => showToast(message, ok ? 'success' : 'error'),
      onMeetingResult: (message, tone) => showToast(message, tone),
      onMeetingStarted: () => { void modal.refreshMeeting() },
    }) },
    onOpenWorker: (session, host) => {
      document.body.dataset.harnessTerminalSession = session
      harnessEvents.push({ type: 'open-worker', session, host: host ?? null })
    },
    onSettingsClick: () => { void openSettings({ shuttleBase: '' }) },
    shuttleBase: '',
    temporalFetchers: docsExample?.temporal ?? workspaceFixture?.temporal ?? MOCK_TEMPORAL,
  })

  const host = document.createElement('div')
  host.style.cssText = 'position:fixed; inset:0;'
  document.body.append(host)
  modal.mount(host)
  if (new URLSearchParams(window.location.search).get('capture') === 'meeting') {
    void openCapture({
      shuttleBase: '',
      onResult: (message, ok) => showToast(message, ok ? 'success' : 'error'),
      onMeetingResult: (message, tone) => showToast(message, tone),
      onMeetingStarted: () => { void modal.refreshMeeting() },
    })
  }

  // expose for agent-browser-driven interaction. `feedSpanMs` is the window the
  // mock activity/commits cover, so a driving script can ask for exactly the
  // range the board's cards live in.
  ;(window as unknown as { __harness: unknown }).__harness = {
    modal,
    MOCK_FEED: workspaceFixture?.feed ?? docsExample?.feed ?? MOCK_FEED,
    temporal: docsExample?.temporal ?? workspaceFixture?.temporal ?? MOCK_TEMPORAL,
    requests: mockRequests,
    handlers: mockHandlers,
    events: harnessEvents,
    nativeFiles: nativeWorkspaceFiles,
    feedSpanMs: FEED_SPAN_MS,
    feedFromMs: now - FEED_SPAN_MS,
    feedToMs: now,
  }
} catch (err) {
  const pre = document.createElement('pre')
  pre.style.cssText = 'position:fixed; inset:20px; white-space:pre-wrap; color:#A2362A; font:13px monospace; z-index:99999;'
  pre.textContent = `HARNESS MOUNT ERROR:\n${(err as Error)?.stack ?? String(err)}`
  document.body.append(pre)
  ;(window as unknown as { __bootErr: unknown }).__bootErr = String((err as Error)?.stack ?? err)
}
