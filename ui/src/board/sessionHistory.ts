/**
 * The card drawer's History row: every harness session the fleet's ledgers
 * paired with this fiber, newest first, each with the one link that opens
 * exactly that chat — the claude.ai bridge URL for a Claude Code session, the
 * Codex app's thread route for a Codex one — or, where no link exists, its
 * short id to copy.
 *
 * Two reads, both lazy (the drawer asks when it first unfolds): the composite
 * session ledger (`/api/v1/sessions/composite`) for the list, then
 * `/api/v1/sessions/links` for only the rows on screen, one request per host
 * that ran them, since a transcript lives on that host.
 */
import { validDesktopThreadLink } from './appConversation.js'
import { isoDayLocal } from './civilDay.js'
import { parseSessions, type SessionRecord } from './views/TemporalData.js'

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

/**
 * What a row's link does. A claude.ai URL opens anywhere. A Codex thread route
 * opens only in the Codex app of the host that ran it, so it is offered only
 * when the board is that host's own and the viewer is at a desktop; otherwise,
 * like a pi session or one never bridged, the row offers its id to copy.
 * Nothing here is built from an id — only what the daemon read is linked.
 */
export function sessionTarget(
  record: Pick<SessionRecord, 'session' | 'host'>,
  link: SessionLinkEntry | undefined,
  boardHost: string,
  desktop: boolean,
): SessionTarget {
  const url = link?.url
  if (url && url.startsWith('https://')) {
    return { kind: 'web', href: url, label: 'claude.ai', title: url }
  }
  const thread = validDesktopThreadLink(link?.desktopLink)
  if (thread && desktop && record.host === boardHost) {
    return { kind: 'app', href: thread, label: 'codex', title: thread }
  }
  return {
    kind: 'copy',
    label: record.session.slice(0, 8),
    title: `${record.session}${record.host ? ` on ${record.host}` : ''}`,
    copy: record.session,
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

/**
 * The History row's value: a list that fills itself on `load()`. Returns
 * `null` from `load` when the fiber has no ledgered sessions, so the caller
 * can drop the row rather than show an empty one.
 */
export function buildSessionHistory(ctx: SessionHistoryContext): {
  el: HTMLElement
  load: () => Promise<boolean>
} {
  const doFetch = ctx.fetch ?? fetch.bind(globalThis)
  const el = document.createElement('div')
  el.className = 'kbn-ctl-sessions'
  const list = document.createElement('ol')
  list.className = 'kbn-ctl-session-list'
  el.append(list)

  let boardHost = ''
  const links = new Map<string, SessionLinkEntry>()

  const readLinks = async (rows: SessionRecord[]): Promise<void> => {
    const byHost = new Map<string, string[]>()
    for (const row of rows) {
      if (links.has(row.session)) continue
      const host = row.host ?? ''
      byHost.set(host, [...(byHost.get(host) ?? []), row.session])
    }
    await Promise.all(
      [...byHost].flatMap(([host, sessions]) => {
        const batches: string[][] = []
        for (let i = 0; i < sessions.length; i += LINKS_BATCH) batches.push(sessions.slice(i, i + LINKS_BATCH))
        return batches.map(async (batch) => {
          const query = `sessions=${batch.join(',')}${host ? `&host=${encodeURIComponent(host)}` : ''}`
          try {
            const res = await doFetch(`${ctx.shuttleBase}/api/v1/sessions/links?${query}`)
            if (!res.ok) return
            for (const [id, entry] of parseSessionLinks(await res.json())) links.set(id, entry)
          } catch {
            /* a host that cannot answer leaves its rows unlinked */
          }
        })
      }),
    )
  }

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

    const target = sessionTarget(record, links.get(record.session), boardHost, ctx.desktop)
    if (target.kind === 'copy') {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'kbn-ctl-session-link kbn-ctl-session-copy'
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
      li.append(btn)
    } else {
      const a = document.createElement('a')
      a.className = `kbn-ctl-session-link kbn-ctl-session-${target.kind}`
      a.href = target.href
      a.textContent = `${target.label} ↗`
      a.title = target.title
      if (target.kind === 'web') {
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
      }
      a.addEventListener('click', (e) => e.stopPropagation())
      li.append(a)
    }
    return li
  }

  const load = async (): Promise<boolean> => {
    let records: SessionRecord[] = []
    try {
      const res = await doFetch(`${ctx.shuttleBase}/api/v1/sessions/composite?since_ms=0`)
      if (res.ok) {
        const parsed = parseSessions(await res.json(), { host: '', records: [] })
        boardHost = parsed.host
        records = parsed.records
      }
    } catch {
      /* no ledger, no row */
    }
    const sessions = fiberSessions(records, ctx.uid)
    if (sessions.length === 0) return false

    const shown = sessions.slice(0, SESSIONS_SHOWN)
    await readLinks(shown)
    list.replaceChildren(...shown.map(row))

    const rest = sessions.slice(SESSIONS_SHOWN)
    if (rest.length > 0) {
      const more = document.createElement('button')
      more.type = 'button'
      more.className = 'kbn-ctl-session-more'
      more.textContent = `all ${sessions.length}`
      more.addEventListener('click', (e) => {
        e.stopPropagation()
        more.disabled = true
        void readLinks(rest).then(() => {
          list.append(...rest.map(row))
          more.remove()
        })
      })
      el.append(more)
    }
    return true
  }

  return { el, load }
}
