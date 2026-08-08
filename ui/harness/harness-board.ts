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
 * same way: `MOCK_TEMPORAL` below injects deterministic activity + narration
 * in place of the daemon routes, so the views render offline with no `/api/v1/
 * activity` endpoint in existence.
 *
 * Distinct from harness/harness.ts (slice C), which mounts FiberDetailModal.
 * Build: `npx vite build -c vite.harness-board.config.ts` → harness-board-dist/.
 */
import { KanbanModal } from '../src/board/KanbanModal.js'
import { civilDayToLocalDate } from '../src/board/civilDay.js'
import type {
  ActivityBucket,
  ActivityResult,
  NarrationResult,
  TemporalFetchers,
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
 * that ULID is the fiber's `uid` (see DayView's `tmuxFiberUlid`). With uids
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
    shuttle: shuttleBlock(),
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
  ],
  origins: {
    local: { kind: 'local', stale: false, last_polled_at: iso(0), fiber_count: 11 },
  },
}

// ── Mock temporal read plane ─────────────────────────────────────────────────
//
// The daemon has no /api/v1/activity or /api/v1/narration route yet, and the
// real fetchers answer a 404 with an empty result — which would leave every
// temporal view blank in the harness, verifying nothing. So the harness injects
// a `TemporalFetchers` pair directly instead of stubbing the routes.
//
// SEEDED, NOT RANDOM: bucket presence, count, session and cwd are all derived
// from the bucket's index through mulberry32, so two loads of the same window
// produce byte-identical data and a screenshot diff means a real change. The
// window itself is now-relative because the mock feed is (its fibers are dated
// off `now`), so the views cover the same three days the board's cards do.

const FEED_SPAN_MS = 3 * 86_400_000
const BUCKET_MS = 5 * 60_000

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
 * The first four JOIN: their session names carry a real fiber's ULID, so a
 * bucket lands in that fiber's named lane. The last three deliberately DO NOT —
 * an old-style session name with no ULID, and bare interactive work with no
 * session at all — because the unjoined path (grouped into muted per-cwd lanes)
 * is half of what the views have to render and must stay exercised offline.
 */
const MOCK_ACTORS: Array<{ s: string | null; cwd: string | null; weight: number }> = [
  { s: sessionFor('work/spt3g_papers/bmodes-2d/run', ULID.bmodes), cwd: '/home/ada/work/spt3g_papers', weight: 5 },
  { s: sessionFor('loom/email/morning-post/refine', ULID.refine), cwd: '/home/ada/loom', weight: 4 },
  { s: sessionFor('work/euclid/euclid-github/triage', ULID.triage), cwd: '/home/ada/work/euclid', weight: 3 },
  { s: sessionFor('work/admin/conference-travel-receipts', ULID.receipts), cwd: '/home/ada/loom', weight: 2 },
  { s: 'scratch-shuttle', cwd: '/home/ada/dev/felt', weight: 3 },
  { s: null, cwd: '/home/ada/dev/felt', weight: 3 },
  { s: null, cwd: '/home/ada/notes', weight: 2 },
]
const ACTOR_POOL = MOCK_ACTORS.flatMap((a) => Array<typeof a>(a.weight).fill(a))

const MOCK_KINDS: ActivityBucket['k'][] = ['agent', 'attention', 'notify']

/**
 * Generate the activity buckets covering [fromMs, toMs). Each 5-minute slot is
 * seeded on its absolute index so the same slot always yields the same bucket
 * regardless of the requested window — a view asking for one day and a view
 * asking for three agree on their overlap. Nights (00:00-07:00 local) are
 * sparse and daytime is dense, so the day/week views have a shape to draw.
 *
 * Never emits a bucket later than page load: a view whose window runs to the
 * end of the civil day (DayView's is 06:00 → 06:00) would otherwise draw work
 * the machine has not done yet, and a rail that fills past the current minute
 * reads as a rendering bug.
 */
function mockActivity(fromMs: number, toMs: number): ActivityResult {
  const buckets: ActivityBucket[] = []
  const first = Math.floor(fromMs / BUCKET_MS)
  const last = Math.floor(Math.min(toMs, now) / BUCKET_MS)
  for (let index = first; index < last; index += 1) {
    const m = index * BUCKET_MS
    const rng = seeded(index)
    const hour = new Date(m).getHours()
    const density = hour < 7 ? 0.06 : hour < 10 ? 0.4 : hour < 19 ? 0.72 : 0.3
    if (rng() > density) continue
    const kind = MOCK_KINDS[Math.floor(rng() * MOCK_KINDS.length)]
    const actor = ACTOR_POOL[Math.floor(rng() * ACTOR_POOL.length)]
    buckets.push({
      m,
      s: actor.s,
      cwd: actor.cwd,
      k: kind,
      // `attention` and `notify` are single events; agent work comes in runs.
      n: kind === 'agent' ? 1 + Math.floor(rng() * 24) : 1,
    })
  }
  return { host: 'ada-workstation', from_ms: fromMs, to_ms: toMs, buckets }
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
 * Commits over an INCLUSIVE CIVIL-DAY range — the daemon's contract, not an
 * instant range. `GET /api/v1/narration?from=&to=` parses both bounds with
 * Elixir's `Date.from_iso8601` and both ends are inclusive in the daemon's
 * local zone (lib/shuttle_web/controllers/narration_controller.ex), so the
 * spec-correct single-day call is `narration(day, day)` — which an instant
 * range reads as a zero-width window and answers with nothing.
 *
 * Leniency, deliberate and one-directional: the daemon accepts ONLY a bare
 * `YYYY-MM-DD` and 400s anything else, while this mock takes the leading civil
 * day off a full ISO timestamp too. That keeps a caller passing timestamps
 * working offline rather than silently blank — but such a caller is a bug
 * against the live daemon, so do not read a working harness as proof the call
 * is well-formed.
 *
 * An inverted range is the daemon's 400, which the real fetcher turns into an
 * empty result; mirrored here as `{commits: []}`.
 */
const CIVIL_DAY_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})/
const MAX_NARRATION_DAYS = 400

function mockNarration(fromISO: string, toISO: string): NarrationResult {
  const fromDay = CIVIL_DAY_PREFIX_RE.exec(fromISO.trim())?.[1]
  const toDay = CIVIL_DAY_PREFIX_RE.exec(toISO.trim())?.[1]
  if (!fromDay || !toDay) return { commits: [] }
  if (fromDay > toDay) return { commits: [] }          // inverted → the daemon's 400
  const firstDay = civilDayToLocalDate(fromDay)
  if (!firstDay) return { commits: [] }

  const commits: NarrationResult['commits'] = []
  for (let offset = 0; offset < MAX_NARRATION_DAYS; offset += 1) {
    const day = new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate() + offset)
    const dayISO = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
    if (dayISO > toDay) break                          // `to` is INCLUSIVE
    const rng = seeded(seedFromString(dayISO))
    const count = 4 + Math.floor(rng() * 5)
    // Walk the subject list from a seeded start with a seeded ODD stride.
    // MOCK_SUBJECTS.length is a power of two, so any odd stride is coprime
    // with it and the walk visits distinct subjects — a day never repeats one.
    // Drawing independently did repeat, and two identical subjects under one
    // slug render as `…; …` prose that reads like a duplication bug.
    const subjectStart = Math.floor(rng() * MOCK_SUBJECTS.length)
    const subjectStride = 1 + 2 * Math.floor(rng() * (MOCK_SUBJECTS.length / 2))
    for (let i = 0; i < count; i += 1) {
      // Local 09:00-21:00, spread across the day and ordered by construction.
      const minutes = Math.floor((9 + (12 * (i + rng())) / count) * 60)
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes)
      commits.push({
        iso: at.toISOString(),
        subject: MOCK_SUBJECTS[(subjectStart + i * subjectStride) % MOCK_SUBJECTS.length],
      })
    }
  }
  return { commits }
}

const MOCK_TEMPORAL: TemporalFetchers = {
  activity: (fromMs, toMs) => Promise.resolve(mockActivity(fromMs, toMs)),
  narration: (fromISO, toISO) => Promise.resolve(mockNarration(fromISO, toISO)),
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
    onOpenFiber: () => {},
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
  // mock activity/narration cover, so a driving script can ask for exactly the
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
