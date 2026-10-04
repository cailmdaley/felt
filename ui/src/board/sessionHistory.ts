/**
 * The card drawer's History: a folded line (`HISTORY 38 ▾`) that unfolds to
 * every harness session the fleet's ledgers paired with this fiber, newest
 * first. Claude opening follows the same browser preference as Aloft. A
 * terminal action attaches to the live worker or resumes a past session on
 * its owning host (`POST /api/v1/attach`). Bridged Claude sessions can open
 * in the browser or installed desktop app; phones use the HTTPS link.
 * Sessions without a phone destination offer their id to copy.
 * {@link sessionTargets} makes that choice.
 *
 * Nothing is read until the first unfold. Then two reads: this fiber's
 * pairings from the composite session ledger (`/api/v1/sessions/composite?uid=`),
 * drawn at once; then `/api/v1/sessions/links` for only the rows on screen, one
 * request per host that ran them (a transcript lives on that host), each
 * host's answers swapped in as they arrive. A host the composite reports stale
 * is not asked.
 */
import { isoDayLocal } from './civilDay.js'
import { effectiveClaudeOpening, REMOTE_CONTROL_REQUIRED, CLAUDE_APP_ROUTE_UNAVAILABLE, CONVERSATION_OPENING_CHANGED, type ClaudeOpening } from './conversationOpening.js'
import { isOriginStale, parseSessions, type SessionRecord, type TemporalOrigins } from './views/TemporalData.js'

/** Rows shown before "all N" unfolds the rest. */
const SESSIONS_SHOWN = 6
/** The route's batch ceiling. */
const LINKS_BATCH = 50

export interface SessionLinkEntry {
  session: string
  availability: string
  harness: string | null
  url: string | null
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
    })
  }
  return out
}

/** What `POST /api/v1/attach` is sent: a live worker's tmux, or a session to resume. */
export type AttachBody =
  | { tmux_session: string; shuttle_host: string | null }
  | { session: string; shuttle_host: string | null }

export type SessionTarget =
  | { kind: 'terminal'; body: AttachBody; label: string; title: string }
  | { kind: 'web'; href: string; label: string; title: string }
  | { kind: 'app'; href: string; label: string; title: string }
  | { kind: 'copy'; label: string; title: string; copy: string }

/** A row's action, and the small link beside it (`app ↗`, or `web ↗` when there is no app route). */
export interface SessionTargets {
  primary: SessionTarget
  extras: SessionTarget[]
  guidance?: string
}

/** A bridge URL naming one session: `https://claude.ai/code/session_<id>`. */
const CLAUDE_SESSION = /^https:\/\/claude\.ai\/code\/((?:cse|session)_[A-Za-z0-9_-]+)$/

/** The Claude desktop app's route for a bridged session, or undefined when the
 *  URL does not name exactly one session. */
export function claudeAppRoute(url: string): string | undefined {
  const match = CLAUDE_SESSION.exec(url)
  const id = match?.[0] === url ? match[1] : undefined
  return id ? `claude://claude.ai/code/${id}` : undefined
}

/** Only HTTPS links on Claude's exact origin can leave the board. */
export function claudeWebLink(url: string | null | undefined): string | undefined {
  if (!url || /\s/.test(url)) return undefined
  try {
    const parsed = new URL(url)
    return parsed.origin === 'https://claude.ai' && !parsed.username && !parsed.password ? url : undefined
  } catch { return undefined }
}

export interface TargetContext {
  /** A viewer at a desktop, where a kitty tab and the Claude app can be
   *  opened — not a phone. */
  desktop: boolean
  opening?: ClaudeOpening
  /** The live worker's session and tmux, when one is running. */
  liveSession?: string
  liveTmux?: string
  /** The fiber's host — where its live worker runs. */
  fiberHost?: string
}

/**
 * What a row does — the one place the choice is made.
 *
 *   · Terminal opening at a desktop attaches the live worker's row to its tmux, exactly as
 *     Aloft does, and any other row resumes that session in a terminal on the
 *     host that ran it. Not offered: a live worker with no tmux (a Codex app
 *     conversation, which a terminal must not take from its app), and a session
 *     whose host found no transcript.
 *   · The browser's Claude preference selects the primary action for a
 *     bridged session, keeping terminal access beside it. Terminal opening
 *     keeps the desktop app beside the primary action. At a
 *     desktop `app ↗` (the Claude desktop app, `claude://claude.ai/code/…`)
 *     beside the terminal — `web ↗` only when the URL has no app route; on a
 *     phone its claude.ai page, which the Claude app there answers.
 *   · Anything else offers its id to copy.
 */
export function sessionTargets(
  record: Pick<SessionRecord, 'session' | 'host'>,
  link: SessionLinkEntry | undefined,
  ctx: TargetContext,
): SessionTargets {
  const url = claudeWebLink(link?.url)
  const web: SessionTarget | undefined =
    url ? { kind: 'web', href: url, label: ctx.desktop ? 'web' : 'claude.ai', title: url } : undefined
  const route = web && ctx.desktop ? claudeAppRoute(web.href) : undefined
  const app: SessionTarget | undefined = route ? { kind: 'app', href: route, label: 'app', title: route } : undefined

  let terminal: SessionTarget | undefined
  if (ctx.desktop) {
    const live = record.session === ctx.liveSession
    if (live && ctx.liveTmux) {
      terminal = {
        kind: 'terminal',
        body: { tmux_session: ctx.liveTmux, shuttle_host: ctx.fiberHost ?? null },
        label: 'attach',
        title: `Attach to ${ctx.liveTmux}`,
      }
    } else if (!live && link?.availability !== 'transcript_missing') {
      terminal = {
        kind: 'terminal',
        body: { session: record.session, shuttle_host: record.host },
        label: 'resume',
        title: `Resume ${record.session}${record.host ? ` on ${record.host}` : ''} in a terminal`,
      }
    }
  }

  const links: SessionTarget[] = []
  if (app) links.push(app)
  else if (web) links.push(web)
  const choice = effectiveClaudeOpening(ctx.desktop, ctx.opening)
  const preferred = choice === 'app' ? app : choice === 'browser' ? web : undefined
  if (preferred) return { primary: preferred, extras: terminal ? [terminal] : [] }
  if (choice === 'app' && web) return {
    primary: { ...web, label: 'browser', title: `${CLAUDE_APP_ROUTE_UNAVAILABLE} ${web.href}` },
    extras: terminal ? [terminal] : [], guidance: CLAUDE_APP_ROUTE_UNAVAILABLE,
  }
  const claude = Boolean(web) || link?.harness === 'claude-code'
  if (claude && choice !== 'terminal' && !preferred) {
    if (terminal) return {
      primary: { ...terminal, label: 'terminal', title: `${REMOTE_CONTROL_REQUIRED} Open this session in Kitty instead.` },
      extras: [], guidance: REMOTE_CONTROL_REQUIRED,
    }
    return {
      primary: { kind: 'copy', label: record.session.slice(0, 8), title: record.session, copy: record.session },
      extras: [], guidance: REMOTE_CONTROL_REQUIRED,
    }
  }
  if (terminal) return { primary: terminal, extras: links }
  if (web) return ctx.desktop ? { primary: links[0], extras: links.slice(1) } : { primary: { ...web, label: 'claude.ai' }, extras: [] }
  return {
    extras: [],
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

export interface SessionHistoryContext extends TargetContext {
  shuttleBase: string
  uid: string
  /** Where a failed terminal open is said. */
  onError?: (message: string) => void
}

/**
 * The History fold: a toggle line and the list under it. Reads nothing until
 * first unfolded.
 */
export function buildSessionHistory(ctx: SessionHistoryContext): HTMLElement {
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

  let origins: TemporalOrigins = {}
  const links = new Map<string, SessionLinkEntry>()
  const drawn = new Map<string, { record: SessionRecord; li: HTMLLIElement }>()

  /** `POST /api/v1/attach`, the terminal action: success raises Kitty, a
   *  failure is said. */
  const openTerminal = async (attach: AttachBody): Promise<void> => {
    try {
      const res = await fetch(`${ctx.shuttleBase}/api/v1/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(attach),
      })
      if (!res.ok) {
        const detail = await res
          .json()
          .then((b: { error?: unknown }) => (typeof b?.error === 'string' ? b.error : ''))
          .catch(() => '')
        ctx.onError?.(detail ? `Couldn’t open terminal: ${detail}` : 'Couldn’t open terminal')
      }
    } catch {
      ctx.onError?.('Couldn’t reach the daemon to open the terminal')
    }
  }

  const targetEl = (target: SessionTarget, cls: string): HTMLElement => {
    if (target.kind === 'web' || target.kind === 'app') {
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
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `${cls} kbn-ctl-session-${target.kind}`
    btn.textContent = target.kind === 'terminal' ? `${target.label} ▸` : target.label
    btn.title = target.title
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (target.kind === 'terminal') {
        // One request at a time per row: a second click while the first is
        // in flight would only race it.
        const li = btn.closest('li')
        btn.disabled = true
        btn.textContent = `${target.label} …`
        li?.classList.add('kbn-ctl-session-pending')
        void openTerminal(target.body).finally(() => {
          btn.disabled = false
          btn.textContent = `${target.label} ▸`
          li?.classList.remove('kbn-ctl-session-pending')
        })
        return
      }
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
    put('kbn-ctl-session-when', sessionWhen(record.at), new Date(record.at).toLocaleString())
    put('kbn-ctl-session-agent', record.agent ?? record.harness ?? 'session')
    if (record.kind !== 'dispatch') put('kbn-ctl-session-kind', record.kind)
    if (record.host && record.host !== ctx.fiberHost) put('kbn-ctl-session-host', record.host)
    if (record.session === ctx.liveSession) put('kbn-ctl-session-live', 'live')

    const targets = sessionTargets(record, links.get(record.session), ctx)
    const primary = targetEl(targets.primary, 'kbn-ctl-session-link')
    li.append(primary)
    for (const extra of targets.extras) li.append(targetEl(extra, 'kbn-ctl-session-alt'))
    if (targets.guidance) put('kbn-ctl-session-opening-note', targets.guidance)
    // The whole row is its primary action, as the Aloft pill is.
    if (targets.primary.kind === 'terminal') {
      li.classList.add('kbn-ctl-session-opens')
      li.title = targets.primary.title
      li.addEventListener('click', (e) => {
        e.stopPropagation()
        primary.click()
      })
    }
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
  el.addEventListener(CONVERSATION_OPENING_CHANGED, () => draw([...drawn.values()].map(({ record }) => record)))

  /** Ask each host for its rows' links; redraw that host's rows on answer. */
  const linkUp = (rows: readonly SessionRecord[]): Promise<unknown> =>
    Promise.all(
      [...linkRequests(rows, new Set(links.keys()), origins)].flatMap(([host, sessions]) => {
        const batches: string[][] = []
        for (let i = 0; i < sessions.length; i += LINKS_BATCH) batches.push(sessions.slice(i, i + LINKS_BATCH))
        return batches.map(async (batch) => {
          const query = `sessions=${batch.join(',')}${host ? `&host=${encodeURIComponent(host)}` : ''}`
          try {
            const res = await fetch(`${ctx.shuttleBase}/api/v1/sessions/links?${query}`)
            if (!res.ok) return
            const answered = parseSessionLinks(await res.json())
            const asked = new Set(batch)
            for (const [id, entry] of answered) if (asked.has(id)) links.set(id, entry)
            draw(batch.map((id) => drawn.get(id)?.record).filter((r): r is SessionRecord => !!r))
          } catch {
            /* a host that cannot answer leaves its rows as they were drawn */
          }
        })
      }),
    )

  const load = async (): Promise<void> => {
    let records: SessionRecord[] = []
    try {
      const res = await fetch(
        `${ctx.shuttleBase}/api/v1/sessions/composite?since_ms=0&uid=${encodeURIComponent(ctx.uid)}`,
      )
      if (res.ok) {
        const parsed = parseSessions(await res.json(), { host: '', records: [] })
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
