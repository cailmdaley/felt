/**
 * The card drawer's History: a folded line (`HISTORY 38 ▾`) that unfolds to
 * every harness session the fleet's ledgers paired with this fiber, newest
 * first, each with the link that opens exactly that chat — in the Claude
 * desktop app (or on claude.ai, from a phone) for a Claude Code session, in the
 * Codex app for a Codex one — or, where no link exists, its short id to copy.
 * {@link sessionTargets} makes that choice.
 *
 * Nothing is read until the first unfold. Then two reads: this fiber's
 * pairings from the composite session ledger (`/api/v1/sessions/composite?uid=`),
 * drawn at once with copy-id targets; then `/api/v1/sessions/links` for only
 * the rows on screen, one request per host that ran them (a transcript lives
 * on that host), each host's links swapped in as it answers. A host the
 * composite reports stale is not asked.
 */
import { validDesktopThreadLink } from './appConversation.js'
import { isoDayLocal } from './civilDay.js'
import { isOriginStale, parseSessions, type SessionRecord, type TemporalOrigins } from './views/TemporalData.js'

/** Rows shown before "all N" unfolds the rest. */
export const SESSIONS_SHOWN = 6
/** The route's batch ceiling. */
const LINKS_BATCH = 50

export interface SessionLinkEntry {
  session: string
  availability: string
  harness: string | null
  url: string | null
  desktopLink: string | null
}

/** One ledger row per session, newest first. A session paired twice (a
 *  dispatch, then a resume) is listed once, at its latest pairing. */
export function fiberSessions(records: readonly SessionRecord[], uid: string): SessionRecord[] {
  const latest = new Map<string, SessionRecord>()
  for (const record of records) {
    if (record.uid !== uid) continue
    const seen = latest.get(record.session)
    if (!seen || record.at >= seen.at) latest.set(record.session, record)
  }
  return [...latest.values()].sort((a, b) => b.at - a.at)
}

/** Coerce one `/sessions/links` body into entries keyed by session. */
export function parseSessionLinks(body: unknown): Map<string, SessionLinkEntry> {
  const out = new Map<string, SessionLinkEntry>()
  const links = (body as { links?: unknown } | null)?.links
  if (!Array.isArray(links)) return out
  for (const raw of links) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    if (typeof entry.session !== 'string') continue
    const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
    out.set(entry.session, {
      session: entry.session,
      availability: str(entry.availability) ?? 'transcript_missing',
      harness: str(entry.harness),
      url: str(entry.url),
      desktopLink: str(entry.desktop_link),
    })
  }
  return out
}

export type SessionTarget =
  | { kind: 'web'; href: string; label: string; title: string }
  | { kind: 'app'; href: string; label: string; title: string }
  | { kind: 'copy'; label: string; title: string; copy: string }

/** A row's way back in, and optionally a second one beside it (`web ↗`). */
export interface SessionTargets {
  primary: SessionTarget
  secondary?: SessionTarget
}

const CLAUDE_WEB = 'https://claude.ai/'
/** A bridge URL naming one session: `https://claude.ai/code/session_<id>`. */
const CLAUDE_SESSION = /^https:\/\/claude\.ai\/code\/((?:cse|session)_[A-Za-z0-9_-]+)$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Where a bridged Claude chat opens. At a desktop, in the Claude app —
 * `claude://claude.ai/code/session_<id>` opens the local twin of the session
 * where there is one, else the bridge viewer, from any machine with the app —
 * with the web page beside it; on a phone, the web page, which the Claude app
 * there answers as a universal link. A claude.ai URL of any other shape opens
 * on the web only.
 */
export function claudeTargets(url: string, desktop: boolean): SessionTargets {
  const web: SessionTarget = { kind: 'web', href: url, label: 'claude.ai', title: url }
  const id = CLAUDE_SESSION.exec(url)?.[1]
  if (!desktop || !id) return { primary: web }
  const app = `claude://claude.ai/code/${id}`
  return {
    primary: { kind: 'app', href: app, label: 'claude', title: app },
    secondary: { ...web, label: 'web' },
  }
}

/**
 * What a row's links do — the one place the choice is made.
 *
 *   · a bridged Claude session → {@link claudeTargets};
 *   · an unbridged Claude session whose transcript the daemon found →
 *     `claude://resume?session=<uuid>`, which imports the CLI session into the
 *     desktop app. It needs the transcript on the viewer's machine, so it is
 *     offered only at a desktop on the host that ran it;
 *   · a Codex thread → its `codex://threads/<id>` route, under the same gate,
 *     and only when the route names this very session;
 *   · anything else — a pi session, a host that has not answered — offers its
 *     id to copy.
 *
 * "The host that ran it" is read as the board's own host: a viewer at that
 * daemon's desktop.
 */
export function sessionTargets(
  record: Pick<SessionRecord, 'session' | 'host'>,
  link: SessionLinkEntry | undefined,
  boardHost: string,
  desktop: boolean,
): SessionTargets {
  const url = link?.url
  if (url && url.startsWith(CLAUDE_WEB)) return claudeTargets(url, desktop)
  const local = desktop && record.host === boardHost
  if (
    local &&
    link?.harness === 'claude-code' &&
    link.availability === 'available_local' &&
    UUID.test(record.session)
  ) {
    const resume = `claude://resume?session=${record.session}`
    return { primary: { kind: 'app', href: resume, label: 'claude', title: resume } }
  }
  const thread = validDesktopThreadLink(link?.desktopLink)
  if (local && thread === `codex://threads/${record.session}`) {
    return { primary: { kind: 'app', href: thread, label: 'codex', title: thread } }
  }
  return {
    primary: {
      kind: 'copy',
      label: record.session.slice(0, 8),
      title: `${record.session}${record.host ? ` on ${record.host}` : ''}`,
      copy: record.session,
    },
  }
}

/** `14:02` today, `Sep 26 14:02` otherwise — the strip's clock, 24-hour. */
export function sessionWhen(ms: number, nowMs: number = Date.now()): string {
  const d = new Date(ms)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  if (isoDayLocal(ms) === isoDayLocal(nowMs)) return time
  const day = d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === new Date(nowMs).getFullYear() ? {} : { year: 'numeric' }),
  })
  return `${day} ${time}`
}

/** The hosts to ask for links, with their sessions: every host that ran a
 *  row still unlinked, except one the composite reports stale. */
export function linkRequests(
  rows: readonly SessionRecord[],
  known: ReadonlySet<string>,
  origins: TemporalOrigins,
): Map<string, string[]> {
  const byHost = new Map<string, string[]>()
  for (const row of rows) {
    if (known.has(row.session)) continue
    const host = row.host ?? ''
    if (isOriginStale(origins, row.host)) continue
    byHost.set(host, [...(byHost.get(host) ?? []), row.session])
  }
  return byHost
}

export interface SessionHistoryContext {
  shuttleBase: string
  uid: string
  /** The fiber's own host; a session run elsewhere names its host. */
  fiberHost?: string
  /** The session a worker is running now, marked live. */
  liveSession?: string
  desktop: boolean
  fetch?: typeof fetch
  now?: () => number
}

function targetEl(target: SessionTarget, cls: string): HTMLElement {
  if (target.kind === 'copy') {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `${cls} kbn-ctl-session-copy`
    btn.textContent = target.label
    btn.title = target.title
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      void navigator.clipboard?.writeText(target.copy).then(
        () => {
          btn.textContent = 'copied'
          setTimeout(() => (btn.textContent = target.label), 1200)
        },
        () => undefined,
      )
    })
    return btn
  }
  const a = document.createElement('a')
  a.className = `${cls} kbn-ctl-session-${target.kind}`
  a.href = target.href
  a.textContent = `${target.label} ↗`
  a.title = target.title
  if (target.kind === 'web') {
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
  }
  a.addEventListener('click', (e) => e.stopPropagation())
  return a
}

/**
 * The History fold: a toggle line and the list under it. Reads nothing until
 * first unfolded.
 */
export function buildSessionHistory(ctx: SessionHistoryContext): HTMLElement {
  const doFetch: typeof fetch = (input, init) => (ctx.fetch ?? globalThis.fetch)(input, init)
  const el = document.createElement('div')
  el.className = 'kbn-ctl-history'

  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'kbn-ctl-history-toggle'
  toggle.setAttribute('aria-expanded', 'false')
  const label = document.createElement('span')
  label.className = 'kbn-ctl-label'
  label.textContent = 'History'
  const count = document.createElement('span')
  count.className = 'kbn-ctl-history-count'
  const chevron = document.createElement('span')
  chevron.className = 'kbn-ctl-history-chevron'
  chevron.setAttribute('aria-hidden', 'true')
  chevron.textContent = '▾'
  const reading = document.createElement('span')
  reading.className = 'kbn-ctl-history-reading'
  reading.append(count, chevron)
  toggle.append(label, reading)

  const body = document.createElement('div')
  body.className = 'kbn-ctl-sessions'
  body.hidden = true
  const list = document.createElement('ol')
  list.className = 'kbn-ctl-session-list'
  body.append(list)
  el.append(toggle, body)

  let boardHost = ''
  let origins: TemporalOrigins = {}
  const links = new Map<string, SessionLinkEntry>()
  const drawn = new Map<string, { record: SessionRecord; li: HTMLLIElement }>()

  const row = (record: SessionRecord): HTMLLIElement => {
    const li = document.createElement('li')
    li.className = 'kbn-ctl-session'
    li.dataset.session = record.session
    const put = (cls: string, text: string, title?: string): void => {
      const span = document.createElement('span')
      span.className = cls
      span.textContent = text
      if (title) span.title = title
      li.append(span)
    }
    const nowMs = ctx.now?.() ?? Date.now()
    put('kbn-ctl-session-when', sessionWhen(record.at, nowMs), new Date(record.at).toLocaleString())
    put('kbn-ctl-session-agent', record.agent ?? record.harness ?? 'session')
    if (record.kind !== 'dispatch') put('kbn-ctl-session-kind', record.kind)
    if (record.host && record.host !== ctx.fiberHost) put('kbn-ctl-session-host', record.host)
    if (record.session === ctx.liveSession) put('kbn-ctl-session-live', 'live')
    const targets = sessionTargets(record, links.get(record.session), boardHost, ctx.desktop)
    li.append(targetEl(targets.primary, 'kbn-ctl-session-link'))
    if (targets.secondary) li.append(targetEl(targets.secondary, 'kbn-ctl-session-alt'))
    return li
  }

  const draw = (records: readonly SessionRecord[]): void => {
    for (const record of records) {
      const li = row(record)
      const seen = drawn.get(record.session)
      if (seen) seen.li.replaceWith(li)
      else list.append(li)
      drawn.set(record.session, { record, li })
    }
  }

  /** Ask each host for its rows' links; redraw that host's rows on answer. */
  const linkUp = (rows: readonly SessionRecord[]): Promise<unknown> =>
    Promise.all(
      [...linkRequests(rows, new Set(links.keys()), origins)].flatMap(([host, sessions]) => {
        const batches: string[][] = []
        for (let i = 0; i < sessions.length; i += LINKS_BATCH) batches.push(sessions.slice(i, i + LINKS_BATCH))
        return batches.map(async (batch) => {
          const query = `sessions=${batch.join(',')}${host ? `&host=${encodeURIComponent(host)}` : ''}`
          try {
            const res = await doFetch(`${ctx.shuttleBase}/api/v1/sessions/links?${query}`)
            if (!res.ok) return
            const answered = parseSessionLinks(await res.json())
            const asked = new Set(batch)
            for (const [id, entry] of answered) if (asked.has(id)) links.set(id, entry)
            draw(batch.map((id) => drawn.get(id)?.record).filter((r): r is SessionRecord => !!r))
          } catch {
            /* a host that cannot answer leaves its rows as ids to copy */
          }
        })
      }),
    )

  const load = async (): Promise<void> => {
    let records: SessionRecord[] = []
    try {
      const res = await doFetch(
        `${ctx.shuttleBase}/api/v1/sessions/composite?since_ms=0&uid=${encodeURIComponent(ctx.uid)}`,
      )
      if (res.ok) {
        const parsed = parseSessions(await res.json(), { host: '', records: [] })
        boardHost = parsed.host
        origins = parsed.origins ?? {}
        records = parsed.records
      }
    } catch {
      /* no ledger: an empty history */
    }
    const sessions = fiberSessions(records, ctx.uid)
    count.textContent = String(sessions.length)
    const shown = sessions.slice(0, SESSIONS_SHOWN)
    draw(shown)
    const rest = sessions.slice(SESSIONS_SHOWN)
    if (rest.length > 0) {
      const more = document.createElement('button')
      more.type = 'button'
      more.className = 'kbn-ctl-session-more'
      more.textContent = `all ${sessions.length}`
      more.addEventListener('click', (e) => {
        e.stopPropagation()
        more.remove()
        draw(rest)
        void linkUp(rest)
      })
      body.append(more)
    }
    void linkUp(shown)
  }

  let loaded = false
  toggle.addEventListener('click', (e) => {
    e.stopPropagation()
    const opening = body.hidden
    body.hidden = !opening
    toggle.setAttribute('aria-expanded', String(opening))
    el.classList.toggle('kbn-ctl-history-open', opening)
    if (opening && !loaded) {
      loaded = true
      void load()
    }
  })

  return el
}
