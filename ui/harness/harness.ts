/**
 * Offline visual-verification harness for the board's two-column file viewer.
 *
 * WHY THIS EXISTS: the live daemon (:4000) is unreachable from any sandboxed
 * process (loopback is network-isolated; curl AND headless chromium both get
 * ECONNREFUSED). So the board can't be verified against the running daemon.
 * This harness builds a single self-contained IIFE bundle that mounts the real
 * FiberDetailModal with MOCKED daemon responses, openable via `file://` and
 * screenshot-able with agent-browser. Build: `npx vite build -c
 * vite.harness.config.ts`; open the emitted harness-dist/index.html via file://.
 *
 * Two interception layers:
 *  1. `window.fetch` is stubbed for every daemon route the components touch
 *     (fiber body, agents, the parent index, and crucially the SENT-FILES
 *     list) — so the data is mock but the DOM/CSS is the real thing.
 *  2. The viewer's iframe/img `src` is a REAL navigation (NOT intercepted by
 *     the fetch stub). To show real file content in the accordion, a
 *     MutationObserver rewrites each `/api/v1/file?path=…` URL to a `file://`
 *     URL of a local fixture (a real report.html / png), keyed by the mock
 *     path. The accordion CHROME + LAYOUT is what we're judging; the fixtures
 *     make it concrete.
 *
 * Query params drive the scenario:
 *   ?open=2        — pre-open the first 2 sent files into the accordion
 *   ?close=1       — open 1 file, then close it → the panel must GLIDE BACK to a
 *                    proper full-width single column (regression guard: the
 *                    left column must not stay stuck at the split flex-basis)
 *   ?recency=1     — open 3, then re-activate the oldest to show it bump to top
 *   ?reload=1      — open 2 files, tear the modal down, re-instantiate +
 *                    re-open the SAME card → confirm persistence rehydrates
 *   ?fallback=1    — make `/api/v1/sent-files` 404 (an older daemon) and serve
 *                    a real events.jsonl blob over `/api/v1/file` → exercises
 *                    the events.jsonl FALLBACK path for a realistic LOCAL card
 *                    (originId = a hostname, NOT the literal 'local'). This is
 *                    the path the default scenario can't reach (it mocks the
 *                    endpoint 200), so it's the only guard against the gate bug
 *                    where `originId === 'local'` short-circuited every real
 *                    local card.
 */
import { FiberDetailModal } from '../src/board/FiberDetailModal.js'
import type { KanbanCard } from '../src/board/KanbanTypes.js'

// ── Mock data ────────────────────────────────────────────────────────────────
const MOCK_UID = '01KVBR1F9BWBVKF97473PV67K8'

// Real fixtures shipped on disk — the viewer's iframe/img point at these via
// file:// so the accordion shows actual content. (Absolute file:// URLs; the
// rewriter maps a mock daemon path to one of these.)
const FIXTURE_REPORT = 'file:///Users/cd280747/loom/.felt/loom/email/morning-post/report.html'
const FIXTURE_REPORT2 = 'file:///Users/cd280747/loom/.felt/ai-futures/portolan/standalone-kanban/report.html'
const FIXTURE_PNG = 'file:///Users/cd280747/loom/.felt/ai-futures/analysis-frontispiece/desi-bao-v1-deterministic.png'

const MOCK_BODY = `The standalone Shuttle board is a lean web client the daemon serves at \`:4000\`.

## Desired State

This is mock fiber body markdown rendered by the lean \`marked\` renderer, styled
to read like a vellum page. It exists so the detail panel has realistic content
while we iterate on the **two-column file viewer** offline.

- A bulleted point about the chrome redesign.
- A second point with some \`inline code\`.
- A third, longer point so the prose column has enough text to show its measure
  and the manuscript typography at a real reading length.

### A subsection

More prose. The point of the harness is faithful CSS, not faithful data.`

const MOCK_SENT_FILES = [
  { fullPath: '/Users/cd280747/loom/.felt/loom/email/morning-post/report.html', basename: 'report.html', timestamp: Date.now() - 2 * 60_000, sessionId: '' },
  { fullPath: '/Users/cd280747/loom/.felt/work/spectra/desi-bao-v1.png', basename: 'desi-bao-v1.png', timestamp: Date.now() - 48 * 60_000, sessionId: '' },
  { fullPath: '/Users/cd280747/loom/.felt/ai-futures/portolan/standalone-kanban/report.html', basename: 'standalone-kanban-report.html', timestamp: Date.now() - 5 * 24 * 60 * 60_000, sessionId: '' },
]

// A realistic events.jsonl blob for the ?fallback scenario: three SendUserFile
// pre_tool_use events whose tmux ULID == MOCK_UID, files == the same three
// deliverables. The parser keys off `tool`, `tmuxSession` (ULID), numeric
// `timestamp`, and `toolInput.files` — exactly the real hook shape. The two
// `report.html` rows share a basename, so this also exercises disambiguation on
// the real fallback data (not just the disambiguated endpoint mock).
const FALLBACK_EVENTS_JSONL = [
  { tool: 'SendUserFile', tmuxSession: `morning-post-${MOCK_UID}-shuttle`, sessionId: 's1', timestamp: Date.now() - 5 * 24 * 60 * 60_000, toolInput: { files: ['/Users/cd280747/loom/.felt/ai-futures/portolan/standalone-kanban/report.html'] } },
  { tool: 'PreToolUse', tmuxSession: `morning-post-${MOCK_UID}-shuttle`, timestamp: Date.now() - 60_000 },
  { tool: 'SendUserFile', tmuxSession: `morning-post-${MOCK_UID}-shuttle`, sessionId: 's1', timestamp: Date.now() - 48 * 60_000, toolInput: { files: ['/Users/cd280747/loom/.felt/work/spectra/desi-bao-v1.png'] } },
  { tool: 'SendUserFile', tmuxSession: `morning-post-${MOCK_UID}-shuttle`, sessionId: 's1', timestamp: Date.now() - 2 * 60_000, toolInput: { files: ['/Users/cd280747/loom/.felt/loom/email/morning-post/report.html'] } },
].map((e) => JSON.stringify(e)).join('\n')

// Map a mock daemon path → a real fixture file:// URL for the iframe/img.
const FIXTURE_MAP: Record<string, string> = {
  '/Users/cd280747/loom/.felt/loom/email/morning-post/report.html': FIXTURE_REPORT,
  '/Users/cd280747/loom/.felt/ai-futures/portolan/standalone-kanban/report.html': FIXTURE_REPORT2,
  '/Users/cd280747/loom/.felt/work/spectra/desi-bao-v1.png': FIXTURE_PNG,
}

const MOCK_CARD: KanbanCard = {
  id: 'ai-futures/portolan/standalone-kanban/board-chrome-redesign',
  uid: MOCK_UID,
  name: 'Board chrome + the fiber panel’s two-column file viewer',
  path: '/Users/cd280747/loom/.felt/ai-futures/portolan/standalone-kanban/board-chrome-redesign/board-chrome-redesign.md',
  fiberDir: '/Users/cd280747/loom/.felt/ai-futures/portolan/standalone-kanban/board-chrome-redesign',
  feltStore: '/Users/cd280747/loom',
  // A real LOCAL card's originId is the daemon's own host id (a hostname), NOT
  // the literal 'local' — the composite feed stamps local rows with
  // own_host_id() and sets feed.host to the same. Using the realistic shape
  // here is what lets the ?fallback scenario exercise the (previously broken)
  // local-ness gate; 'local' would have masked the bug.
  originId: 'dapmcw68',
  status: 'active',
  outcome: 'BUILDING: chrome redesign + the new two-column multi-file viewer for the fiber panel. This lede shows the manuscript outcome treatment.',
  tags: ['constitution', 'kanban', 'portolan', 'design'],
  createdAt: '2026-06-17T23:33:19+02:00',
  dependsOnSatisfied: true,
}

// ── Fetch stub: stand in for the daemon ──────────────────────────────────────
const FALLBACK_MODE = new URLSearchParams(location.search).get('fallback') === '1'
const realFetch = window.fetch.bind(window)
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

  // Fiber body
  if (url.includes('/api/v1/fibers/') && url.includes('body=true')) {
    return json({ fibers: [{ fiber: { body: MOCK_BODY } }] })
  }
  // events.jsonl over the /file route — the FALLBACK data source. Matched
  // before the generic /file pass-through; only relevant in ?fallback mode.
  if (FALLBACK_MODE && url.includes('/api/v1/file') && url.includes('events.jsonl')) {
    return new Response(FALLBACK_EVENTS_JSONL, { status: 200, headers: { 'Content-Type': 'text/plain' } })
  }
  // Sent files. Default: the proper endpoint (PRIMARY data path). In ?fallback
  // mode: 404 like an older daemon, forcing the events.jsonl fallback so the
  // local-ness gate is actually exercised for a realistic (hostname) originId.
  if (url.includes('/api/v1/sent-files')) {
    return FALLBACK_MODE
      ? new Response('not found', { status: 404 })
      : json({ files: MOCK_SENT_FILES })
  }
  // Parent-picker index
  if (url.includes('/api/v1/fibers') && !url.includes('body=true')) return json({ fibers: [] })
  // Agent registry
  if (url.includes('/api/v1/agents')) return json({ agents: [] })

  return realFetch(input as RequestInfo, init)
}) as typeof fetch

// ── Fixture rewriter: point real iframe/img navigations at file:// fixtures ──
// The viewer builds `/api/v1/file?path=<ABS>` URLs; rewrite each to its fixture.
function rewriteToFixture(el: HTMLImageElement | HTMLIFrameElement): void {
  const src = el.getAttribute('src') ?? ''
  const m = src.match(/[?&]path=([^&]+)/)
  if (!m) return
  let abs: string
  try { abs = decodeURIComponent(m[1].replace(/%7E/g, '~')) } catch { abs = m[1] }
  const fixture = FIXTURE_MAP[abs]
  if (fixture && el.src !== fixture) el.src = fixture
}
const fixtureObserver = new MutationObserver((muts) => {
  for (const mut of muts) {
    for (const node of mut.addedNodes) {
      if (!(node instanceof Element)) continue
      node.querySelectorAll<HTMLImageElement | HTMLIFrameElement>('iframe.kbn-fileview-frame, img.kbn-fileview-image')
        .forEach(rewriteToFixture)
      if (node.matches('iframe.kbn-fileview-frame, img.kbn-fileview-image')) {
        rewriteToFixture(node as HTMLIFrameElement)
      }
    }
  }
})
fixtureObserver.observe(document.body, { childList: true, subtree: true })

// ── Mount ────────────────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search)

function makeModal(): FiberDetailModal {
  return new FiberDetailModal(
    '', // shuttleBase relative
    () => {},
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    {},
  )
}

let modal = makeModal()
modal.open(MOCK_CARD)

// Drive scenarios after the launcher's sent-files fetch resolves (a microtask
// or two). A short delay lets the launcher render so click-driving works.
const launcherClick = (n: number) => {
  const rows = document.querySelectorAll<HTMLButtonElement>('.kbn-detail-sent-file')
  rows[n]?.click()
}

window.setTimeout(() => {
  const openN = Number(params.get('open') ?? '0')
  const recency = params.get('recency') === '1'
  const reload = params.get('reload') === '1'
  const closeLast = params.get('close') === '1'

  if (closeLast) {
    // Open the newest file, then close it via the accordion ✕. The panel must
    // glide back to a full-width single column — guards the hideRightColumn()
    // bug where the left column stayed pinned at the split flex-basis.
    launcherClick(0)
    window.setTimeout(() => {
      document.querySelector<HTMLButtonElement>('.kbn-detail-acc-close')?.click()
    }, 350)
    return
  }

  if (reload) {
    // Open the first two files (newest first → file 0, then file 1), give them
    // scroll, then tear down and re-instantiate the SAME card to prove
    // persistence rehydrates the exact open set + order.
    launcherClick(0)
    launcherClick(1)
    window.setTimeout(() => {
      modal.close()
      modal = makeModal()
      modal.open(MOCK_CARD)
      ;(window as unknown as { __harness: unknown }).__harness = { modal, MOCK_CARD, MOCK_SENT_FILES }
    }, 700)
    return
  }

  if (recency) {
    // Open all three (0,1,2) then re-activate the LAST-opened-into-bottom (the
    // oldest file, index 2 in the launcher) to bump it to the top.
    launcherClick(0)
    launcherClick(1)
    launcherClick(2)
    window.setTimeout(() => launcherClick(2), 350)
    return
  }

  for (let i = 0; i < openN; i++) launcherClick(i)
}, 250)

// expose for agent-browser-driven interaction
;(window as unknown as { __harness: unknown }).__harness = { modal, MOCK_CARD, MOCK_SENT_FILES }
