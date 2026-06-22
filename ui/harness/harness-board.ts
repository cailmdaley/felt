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
 * Distinct from harness/harness.ts (slice C), which mounts FiberDetailModal.
 * Build: `npx vite build -c vite.harness-board.config.ts` → harness-board-dist/.
 */
import { KanbanModal } from '../src/board/KanbanModal.js'

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
  host: 'dapmcw68',
  agent: 'claude-opus',
  effort: 'high',
  project_dir: '/Users/cd280747/loom',
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
  felt_store: '/Users/cd280747/loom',
  path: `.felt/${f.id}.md`,
  dir: `/Users/cd280747/loom/.felt/${f.id}`,
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
    id: 'work/cea/cea-admin/reimbursement',
    name: 'File the CEA mission reimbursement',
    status: 'active',
    outcome: 'Attach the Moriond receipts; submit before the quarter closes.',
    tags: ['cea', 'admin'],
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
  })

  const host = document.createElement('div')
  host.style.cssText = 'position:fixed; inset:0;'
  document.body.append(host)
  modal.mount(host)

  // expose for agent-browser-driven interaction
  ;(window as unknown as { __harness: unknown }).__harness = { modal, MOCK_FEED }
} catch (err) {
  const pre = document.createElement('pre')
  pre.style.cssText = 'position:fixed; inset:20px; white-space:pre-wrap; color:#A2362A; font:13px monospace; z-index:99999;'
  pre.textContent = `HARNESS MOUNT ERROR:\n${(err as Error)?.stack ?? String(err)}`
  document.body.append(pre)
  ;(window as unknown as { __bootErr: unknown }).__bootErr = String((err as Error)?.stack ?? err)
}
