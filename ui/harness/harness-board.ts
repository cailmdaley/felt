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

interface MockFiber {
  id: string
  uid?: string
  name: string
  status: string
  outcome?: string
  tags?: string[]
  created_at?: string
  closed_at?: string
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
    shuttle: f.shuttle,
  },
})

// Drafts (status:open, shuttle block).
const DRAFTS: MockFiber[] = [
  {
    id: 'ai-futures/portolan/standalone-kanban/board-chrome-redesign',
    uid: '01KVBR1F9BWBVKF97473PV67K8',
    name: 'Board chrome + two-column file viewer',
    status: 'open',
    outcome: 'Dissolve the masthead; fold its three actions into the column heads as one tinted round-button family.',
    tags: ['constitution', 'kanban', 'design'],
    shuttle: shuttleBlock(),
  },
  {
    id: 'work/euclid/euclid-github/triage',
    name: 'Triage the Euclid GitHub backlog',
    status: 'open',
    outcome: 'Sort open issues by milestone; close the stale duplicates flagged last week.',
    tags: ['euclid'],
    shuttle: shuttleBlock(),
  },
  {
    id: 'loom/email/morning-post/refine',
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
    name: 'Run the 2D B-mode null tests',
    status: 'active',
    outcome: 'Compute χ²_B and the PTE across the patch set; checking the covariance Hartlap factor.',
    tags: ['spt3g', 'research'],
    shuttle: shuttleBlock(),
  },
  {
    id: 'work/admin/conference-travel-receipts',
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
    name: 'Felt-maintenance ledger sweep',
    status: 'closed',
    outcome: 'Recorded live-session resolutions; cleared the review queue. Ready for a verdict.',
    tags: ['loom', 'felt'],
    closed_at: iso(-6 * 3_600_000),
    shuttle: shuttleBlock(),
  },
  {
    id: 'work/arxiv/daily-digest',
    name: 'Daily arXiv digest',
    status: 'closed',
    outcome: 'Three cosmic-shear papers + one CMB-lensing cross-correlation surfaced; bib entries staged.',
    tags: ['arxiv', 'research'],
    closed_at: iso(-30 * 3_600_000),
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
            tmux_session: `bmodes-2d-${f.id}-shuttle`,
            phase: 'working',
            last_activity_at: now - 4_000,
          },
        }
      }
      return e
    }),
    ...AWAITING.map(fiber),
  ],
  origins: {
    local: { kind: 'local', stale: false, last_polled_at: iso(0), fiber_count: 7 },
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

const MOCK_CWDS = [
  '/home/ada/loom',
  '/home/ada/dev/felt',
  '/home/ada/work/spt3g_papers',
  '/home/ada/work/euclid',
]
const MOCK_SESSIONS = ['bmodes-2d-shuttle', 'morning-post-shuttle', 'euclid-triage-shuttle']
const MOCK_KINDS: ActivityBucket['k'][] = ['agent', 'attention', 'notify']

/**
 * Generate the activity buckets covering [fromMs, toMs). Each 5-minute slot is
 * seeded on its absolute index so the same slot always yields the same bucket
 * regardless of the requested window — a view asking for one day and a view
 * asking for three agree on their overlap. Nights (00:00-07:00 local) are
 * sparse and daytime is dense, so the day/week views have a shape to draw.
 */
function mockActivity(fromMs: number, toMs: number): ActivityResult {
  const buckets: ActivityBucket[] = []
  const first = Math.floor(fromMs / BUCKET_MS)
  const last = Math.floor(toMs / BUCKET_MS)
  for (let index = first; index < last; index += 1) {
    const m = index * BUCKET_MS
    const rng = seeded(index)
    const hour = new Date(m).getHours()
    const density = hour < 7 ? 0.06 : hour < 10 ? 0.4 : hour < 19 ? 0.72 : 0.3
    if (rng() > density) continue
    const kind = MOCK_KINDS[Math.floor(rng() * MOCK_KINDS.length)]
    buckets.push({
      m,
      s: MOCK_SESSIONS[Math.floor(rng() * MOCK_SESSIONS.length)],
      cwd: MOCK_CWDS[Math.floor(rng() * MOCK_CWDS.length)],
      k: kind,
      // `attention` and `notify` are single events; agent work comes in runs.
      n: kind === 'agent' ? 1 + Math.floor(rng() * 24) : 1,
    })
  }
  return { host: 'ada-workstation', from_ms: fromMs, to_ms: toMs, buckets }
}

const MOCK_SUBJECTS = [
  'board: fold the masthead actions into the column heads',
  'kanban: drag onto a day column writes due:',
  'views: hang the temporal pages off a hotkey row',
  'timeline: adaptive strip height from the tallest visible day',
  'daemon: owner-route the felt-edit write plane',
  'stash: cluster on the containment path first token',
  'detail: sent-files strip opens in the viewer',
  'poller: back off a stale remote instead of retrying hot',
]

/** Commits over the window: roughly six a day, deterministic per day index. */
function mockNarration(fromISO: string, toISO: string): NarrationResult {
  const from = Date.parse(fromISO)
  const to = Date.parse(toISO)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return { commits: [] }
  const commits: NarrationResult['commits'] = []
  const firstDay = Math.floor(from / 86_400_000)
  const lastDay = Math.floor(to / 86_400_000)
  for (let day = firstDay; day <= lastDay; day += 1) {
    const rng = seeded(day * 7919)
    const count = 4 + Math.floor(rng() * 5)
    for (let i = 0; i < count; i += 1) {
      // 09:00-21:00 local-ish, spread across the day and sorted by construction.
      const ms = day * 86_400_000 + Math.floor((9 + (12 * (i + rng())) / count) * 3_600_000)
      if (ms < from || ms > to) continue
      commits.push({
        iso: new Date(ms).toISOString(),
        subject: MOCK_SUBJECTS[Math.floor(rng() * MOCK_SUBJECTS.length)],
      })
    }
  }
  commits.sort((a, b) => a.iso.localeCompare(b.iso))
  return { commits }
}

const MOCK_TEMPORAL: TemporalFetchers = {
  activity: (fromMs, toMs) => Promise.resolve(mockActivity(fromMs, toMs)),
  narration: (fromISO, toISO) => Promise.resolve(mockNarration(fromISO, toISO)),
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
