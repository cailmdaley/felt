/**
 * Offline visual-verification harness for the BOARD CHROME (slice B).
 *
 * WHY THIS EXISTS: the live daemon (:4000) is unreachable from any sandboxed
 * process (loopback is network-isolated; curl AND headless chromium both get
 * ECONNREFUSED). So the board can't be verified against the running daemon.
 * This harness builds a single self-contained IIFE bundle that mounts the REAL
 * `KanbanModal` with a MOCKED composite feed, openable via `file://` and
 * screenshot-able with agent-browser. It is the verification surface for the
 * board-chrome-redesign constitution's *Piece one — board chrome*.
 *
 * It stubs `window.fetch` for the one route the board reads
 * (`GET /api/v1/fibers/composite`) and returns a small mock feed; KanbanModal
 * then runs its own real classifier (`parseCompositeFeed` →
 * `buildKanbanResponseFromComposite`) so what you see is the real DOM/CSS the
 * daemon would serve — only the data is mock.
 *
 * The temporal views (chronicle / day / week, hotkeys 2-4) are exercised the
 * same way: `MOCK_TEMPORAL` below injects a deterministic activity plane and
 * the two ledgers as the `TemporalFetchers` the board would otherwise build
 * over `/api/v1/activity`, `/sessions` and `/commits`, so the views render with
 * no daemon to serve them. The mock mirrors the FETCHER contract — one-minute
 * buckets, and ledger records over an instant range — so what the views are
 * exercised against is the shape they really receive.
 *
 * Distinct from harness/harness.ts (slice C), which mounts FiberDetailModal.
 * Build: `npm run harness:board`; open the emitted
 * harness-board-dist/index.html via file://. The page ships with the bundle,
 * so the output directory is self-sufficient — nothing to copy in by hand.
 */
import { KanbanModal } from '../src/board/KanbanModal.js'
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
const now = Date.now()
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString()

const shuttleBlock = (kind = 'oneshot') => ({
  kind,
  host: 'ada-workstation',
  agent: 'claude-opus',
  effort: 'high',
  project_dir: '/home/ada/loom',
})

/** A shuttle block carrying a concluded run's `runtime` stamps — what the
 *  detail panel's session-window line reads (dispatched → handed off → span). */
/**
 * A block whose worker runs somewhere OTHER than the host serving this page.
 *
 * LOAD-BEARING, do not normalize away. Day prints a lane's hostname only when
 * that lane ran elsewhere (`noteFor` suppresses a note matching the page host,
 * because a hostname repeated on every row is a constant pretending to be
 * information), and Chronicle does the same with its host text. With every
 * mock fiber on `ada-workstation` — which is also the mock activity's `host` —
 * those paths could never fire, and a span that never renders looks exactly
 * like a span that is correctly suppressed. Exactly one fiber wears this so
 * both branches are visible at once: one lane with a hostname, the rest bare.
 */
const FOREIGN_HOST = 'basalt-login-02'
/** The host serving this page — what every temporal result stamps itself with,
 *  and the note a lane suppresses because it is the page's constant. */
const LOCAL_HOST = 'ada-workstation'
const shuttleBlockElsewhere = () => ({
  ...shuttleBlock(),
  host: FOREIGN_HOST,
  project_dir: '/leonardo_work/spt3g/papers',
})

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
 * Every mock fiber carries a ULID, because the temporal views join a bucket to
 * a fiber THROUGH one: a Shuttle worker runs in `<slug>-<ULID>-shuttle` and
 * that ULID is the fiber's `uid` (see `sessionUlid` in views/sessionNames.ts). With uids
 * missing the join can never succeed, and the views would only ever exercise
 * their unjoined path offline — which is how this started.
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
} as const

/** The tmux session a Shuttle worker on this fiber runs in — the real
 *  convention from cmd/shuttle_foundation_test.go: `<leaf>-<uid>-shuttle`,
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
  shuttle?: ReturnType<typeof shuttleBlock>
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

// In flight (status:active, shuttle block; first one has a live worker).
const IN_FLIGHT: MockFiber[] = [
  {
    id: 'work/spt3g_papers/bmodes-2d/run',
    uid: ULID.bmodes,
    name: 'Run the 2D B-mode null tests',
    status: 'active',
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

// A standing role, for the humanized-cron chip in the detail panel.
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
 * CYCLES — `cycle`-tagged fibers, each a named span of time. They are drawn as
 * bands behind the work by the temporal views and appear on NO desk surface:
 * `classifyFiber` routes a cycle to `response.cycles` and nowhere else, so the
 * column counts never see one.
 *
 * The harness carried none until now, which is exactly why a dead cycle click
 * survived to a browser session — with no band on screen there was nothing to
 * click offline. One live cycle spanning today (so a band is always visible
 * whenever the harness is opened) and one closed last week, so the views get
 * both a current and a past span to place.
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
    // above both reach the present, so without this one no view ever draws a
    // band that lies entirely behind the cursor: Chronicle's past bands, and
    // any "this week sits after the cycle" branch, would go unexercised.
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

const MOCK_FEED = {
  host: 'local',
  generated_at: iso(0),
  fibers: [
    ...DRAFTS.map(fiber),
    ...IN_FLIGHT.map((f, i) => {
      const e = fiber(f)
      // Give the first in-flight card a live worker so the lane shows the
      // worker pill alongside the New-idea action.
      if (i === 0) {
        return {
          ...e,
          runtime: {
            tmux_session: sessionFor(f.id, f.uid ?? ''),
            phase: 'working',
            last_activity_at: now - 4_000,
          },
        }
      }
      // The second one has been stopped at a prompt for hours — the case the
      // aged `⏸ waiting · 3h` pill exists for.
      return {
        ...e,
        runtime: {
          tmux_session: sessionFor(f.id, f.uid ?? ''),
          phase: 'waiting',
          last_activity_at: now - (3 * 3_600_000 + 12 * 60_000),
        },
      }
    }),
    ...AWAITING.map(fiber),
    ...RESTING.map(fiber),
    ...STANDING.map(fiber),
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
// `GET /api/v1/activity`, `/sessions` and `/commits` exist on the daemon now,
// but the harness has no daemon at all — it runs off `file://` with a stubbed
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
 * width field on the wire for a client to infer from. A 5-minute mock grid
 * therefore under-reported every duration by the factor between the two: the
 * raster looked dense while Week's totals read "1h 52m · quiet", which is a
 * harness artifact that any glance would blame on Week.
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
 * All three lane labels the views can draw are exercised here, because each is
 * a different factual claim and each has its own bug:
 *
 *   JOINED      the first four. Their session names carry a real fiber's ULID,
 *               so a bucket lands in that fiber's named lane.
 *   UNMATCHED   `scratch-shuttle`. A session id that resolves to no fiber — a
 *               worker whose fiber the view could not name.
 *   INTERACTIVE the two with `s: null`. No session at all: a human at a shell.
 *
 * THE CWD IS LOAD-BEARING FOR THE UNMATCHED ONE. `joinBucketToCard` tries four
 * rungs for a session-bearing bucket, and the LAST is the cwd's tail against
 * fiber id segments. `scratch-shuttle` used to sit in `/home/ada/dev/felt`,
 * whose tail `felt` is a segment of `loom/felt/shuttle/agent-registry-audit` —
 * so it joined on that fourth rung and quietly rendered as a fifth fiber lane,
 * and `· unmatched` never appeared offline at all. Its directory must keep a
 * tail that matches NO fiber segment. `scratch` is safe; anything named after
 * a project in the mock feed is not.
 */
const MOCK_ACTORS: Array<{
  s: string | null
  cwd: string | null
  weight: number
  /** Which daemon produced these minutes. Omitted is this host. Exactly one
   *  actor runs elsewhere — the b-mode sweep, whose fiber already carries
   *  `shuttleBlockElsewhere` — so the cross-host register (a lane's host note,
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
  // LEDGER-ONLY: no ULID in the name, so every name-derived rung misses it —
  // but the session ledger pairs it, so RUNG 0 resolves it to a fiber. The
  // one actor that demonstrates what rung 0 can do that nothing else can.
  // Its cwd tail (`photoz`) deliberately matches NO fiber segment: with a
  // tail like `euclid` the cwd rung would guess a fiber, and guess the WRONG
  // one (the ledger pairs this session to photoz-systematics, not triage).
  // So today it reads `· unmatched`, and adopting rung 0 moves it into the
  // photoz lane — a clean before/after rather than a silent mis-join.
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
 * shape for Day's wash to draw, and a duration total that is really just a
 * coin-flip count. Instead each absolute HOUR seeds its own handful of spans
 * (start minute, length, actor), and every minute inside a span emits a
 * bucket. Density lives in how much of the hour the spans cover, which is what
 * a duration total is actually measuring.
 *
 * Generation is keyed on ABSOLUTE hour index, never on the requested window,
 * so a view asking for one day and a view asking for a week agree exactly on
 * their overlap. Generation starts SPAN_LOOKBACK_HOURS early so a span that
 * began before `fromMs` still contributes the minutes that fall inside it.
 *
 * Never emits a bucket later than page load: a view whose window runs to the
 * end of the civil day (DayView's is 06:00 → 06:00) would otherwise draw work
 * the machine has not done yet, and a rail that fills past the current minute
 * reads as a rendering bug.
 */
/**
 * The window's DELEGATIONS — the `spawns` list the ladder draws as rungs.
 *
 * Fixed, not generated: the buckets are a texture and want a generator, but a
 * delegation is a specific claim about a specific fan-out, and the cases worth
 * having on screen are the ones the layout has to survive rather than a
 * plausible average. Four of them, each here for a reason:
 *
 *   A WORKFLOW AT SCALE — 117 agents over the better part of an hour, which is
 *   the case this channel was rebuilt for. Its rung used to draw as a
 *   fourteen-pixel dash, because a workflow's tool call returns seconds after
 *   it fans out and the events knew nothing else about it.
 *
 *   A SECOND, SMALLER WORKFLOW on another lane, so two counts are on the sheet
 *   at once and can be read against each other down the column.
 *
 *   A PLAIN AGENT overlapping the big one, because a rung with no count beside
 *   a rung with one is the comparison that says what the count MEANS — and
 *   because the overlap forces a second row, which is what puts a neighbour
 *   over the label and exercises the clearance test that suppresses it.
 *
 *   ONE STILL FLYING, ending at now: a measured extent that has not finished,
 *   which is a different mark from a delegation nobody saw return.
 */
function mockSpawns(fromMs: number, toMs: number): ActivityResult['spawns'] {
  const endMs = Math.min(toMs, now)
  const ago = (minutes: number) => endMs - minutes * BUCKET_MS
  const refine = { s: sessionFor('loom/email/morning-post/refine', ULID.refine), cwd: '/home/ada/loom' }
  const triage = { s: sessionFor('work/euclid/euclid-github/triage', ULID.triage), cwd: '/home/ada/work/euclid' }

  return [
    {
      ...refine,
      tool: 'Workflow',
      label: 'felt-cleanup-audit',
      agents: 117,
      start_ms: ago(300),
      end_ms: ago(244),
      open: false,
      host: LOCAL_HOST,
    },
    {
      ...refine,
      tool: 'Agent',
      label: null,
      agents: null,
      start_ms: ago(288),
      end_ms: ago(261),
      open: false,
      host: LOCAL_HOST,
    },
    {
      ...triage,
      tool: 'Workflow',
      label: 'board-day-ladder',
      agents: 9,
      start_ms: ago(170),
      end_ms: ago(148),
      open: false,
      host: LOCAL_HOST,
    },
    {
      ...refine,
      tool: 'Workflow',
      label: 'wide-sweep',
      agents: 34,
      start_ms: ago(41),
      end_ms: endMs,
      open: true,
      host: LOCAL_HOST,
    },
  ].filter((span) => span.start_ms <= toMs && span.end_ms >= fromMs)
}

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
    spawns: mockSpawns(fromMs, toMs),
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
 * felt's commit convention is `<slug>: what happened`, and the views group the
 * trail by that prefix, then match a group to a fiber lane whose id tail is the
 * same slug. So the first five prefixes here are REAL mock-fiber slugs (they
 * join to a lane), the next two are slugs no card answers to (they render as
 * their own entries), and the last carries no prefix at all — the trailing
 * unprefixed group, which sits last and muted.
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
 * pairing. Views join activity buckets through it as RUNG 0.
 *
 * Three things it deliberately covers:
 *
 *   · the four ULID-bearing sessions, where rung 0 AGREES with the existing
 *     name-derived rungs — adopting it must not move those lanes.
 *   · `pi-2f9c41`, whose tmux name carries no ULID at all. Every name-derived
 *     rung misses it; only the ledger can say whose work it was. This is the
 *     case that justifies rung 0 existing.
 *   · a HISTORICAL pairing (`sweep`) with no activity in any window the views
 *     ask for — the ledger outliving its session, which is the whole point of
 *     the file. It must not conjure a lane on its own.
 *
 * `scratch-shuttle` is deliberately ABSENT, so the `· unmatched` label keeps
 * its coverage. Pairing it here would resolve it and quietly delete that path.
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
 * A malformed ULID is invisible: the join just quietly fails and every lane
 * falls to the interactive path, which is exactly the failure this table was
 * added to fix. So check the alphabet and the length at boot and throw — the
 * mount's catch renders the message over the page.
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

// ── Fetch stub: stand in for the daemon ──────────────────────────────────────
const realFetch = window.fetch.bind(window)
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

  // The board's single read route.
  if (url.includes('/api/v1/fibers/composite')) return json(MOCK_FEED)
  // Any write (transition/felt-edit/dispatch) the user might trigger — swallow
  // it with a benign OK so the offline harness doesn't error on a click.
  if (url.includes('/api/v1/')) return json({ ok: true })

  return realFetch(input as RequestInfo, init)
}) as typeof fetch

// ── Mount ────────────────────────────────────────────────────────────────────
// Wire all three head actions so every lane shows its tinted button. onRefresh
// is owned internally by KanbanModal (it threads its own refreshFromSource).
try {
  assertUlids()
  const modal = new KanbanModal({
    onStashClick: () => { window.console.log('stash click') },
    onNewIdeaClick: () => { window.console.log('new-idea click') },
    shuttleBase: '',
    temporalFetchers: MOCK_TEMPORAL,
  })

  const host = document.createElement('div')
  host.style.cssText = 'position:fixed; inset:0;'
  document.body.append(host)
  modal.mount(host)

  // expose for agent-browser-driven interaction. `feedSpanMs` is the window the
  // mock activity/commits cover, so a driving script can ask for exactly the
  // range the board's cards live in.
  ;(window as unknown as { __harness: unknown }).__harness = {
    modal,
    MOCK_FEED,
    temporal: MOCK_TEMPORAL,
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
