import { describe, expect, it } from 'vitest'
import { claudeTargets, fiberSessions, linkRequests, parseSessionLinks, sessionTargets, sessionWhen } from './sessionHistory.js'
import type { SessionRecord } from './views/TemporalData.js'

const UID = '01KVTXJ3VQYNZ6TYK342ZHV5CK'
const CLAUDE = 'b8586ace-8ce7-4152-a16c-cffa73822756'
const CODEX = '01a0b39f-d9d0-7d02-9adf-c24f825c3342'
const PI = '01a042f4-6b7f-7f79-9c6c-8140ffd0126c'

const rec = (over: Partial<SessionRecord>): SessionRecord => ({
  at: 0,
  fiber: 'ai/felt/debug',
  uid: UID,
  session: CLAUDE,
  harness: 'claude-code',
  host: 'ada',
  tmux: 'debug-shuttle',
  kind: 'dispatch',
  ...over,
})

describe('fiberSessions', () => {
  it('keeps this fiber only, one row per session at its latest pairing, newest first', () => {
    const rows = fiberSessions(
      [
        rec({ at: 1, session: PI, harness: 'pi' }),
        rec({ at: 2, session: CLAUDE }),
        rec({ at: 3, session: CODEX, harness: 'codex' }),
        rec({ at: 4, session: CLAUDE, kind: 'resume' }),
        rec({ at: 5, uid: '01OTHER0000000000000000000', session: '00000000-0000-4000-8000-000000000000' }),
      ],
      UID,
    )
    expect(rows.map((r) => [r.session, r.kind])).toEqual([
      [CLAUDE, 'resume'],
      [CODEX, 'dispatch'],
      [PI, 'dispatch'],
    ])
  })
})

describe('parseSessionLinks', () => {
  it('reads the wire shape and drops malformed entries', () => {
    const links = parseSessionLinks({
      host: 'ada',
      links: [
        { session: CLAUDE, availability: 'available_local', harness: 'claude-code', url: 'https://claude.ai/code/session_01X', desktop_link: null },
        { session: CODEX, availability: 'available_local', harness: 'codex', url: null, desktop_link: `codex://threads/${CODEX}` },
        { availability: 'available_local' },
        'junk',
      ],
    })
    expect([...links.keys()]).toEqual([CLAUDE, CODEX])
    expect(links.get(CLAUDE)?.url).toBe('https://claude.ai/code/session_01X')
    expect(links.get(CODEX)?.desktopLink).toBe(`codex://threads/${CODEX}`)
    expect(parseSessionLinks(null).size).toBe(0)
  })
})

describe('sessionTargets', () => {
  const entry = (over: Record<string, unknown>) =>
    parseSessionLinks({ links: [{ session: over.session, availability: 'available_local', ...over }] }).get(
      over.session as string,
    )
  const primary = (...args: Parameters<typeof sessionTargets>) => sessionTargets(...args).primary

  const BRIDGE = 'https://claude.ai/code/session_01X-y_Z'

  it('a bridged Claude session opens in the desktop app with the web page beside it, from any desktop', () => {
    const link = entry({ session: CLAUDE, harness: 'claude-code', url: BRIDGE })
    for (const host of ['ada', 'elsewhere']) {
      const targets = sessionTargets(rec({}), link, host, true)
      expect(targets).toEqual(claudeTargets(BRIDGE, true))
      expect(targets.primary).toMatchObject({ kind: 'app', href: 'claude://claude.ai/code/session_01X-y_Z', label: 'claude' })
      expect(targets.secondary).toMatchObject({ kind: 'web', href: BRIDGE, label: 'web' })
    }
  })

  it('on a phone the bridged session opens its claude.ai page, alone', () => {
    const link = entry({ session: CLAUDE, harness: 'claude-code', url: BRIDGE })
    expect(sessionTargets(rec({}), link, 'ada', false)).toEqual({
      primary: { kind: 'web', href: BRIDGE, label: 'claude.ai', title: BRIDGE },
    })
  })

  it('a claude.ai URL that names no session opens on the web only', () => {
    expect(claudeTargets('https://claude.ai/code/', true)).toEqual({
      primary: { kind: 'web', href: 'https://claude.ai/code/', label: 'claude.ai', title: 'https://claude.ai/code/' },
    })
    expect(claudeTargets('https://claude.ai/code/session_01X?next=evil', true).secondary).toBeUndefined()
  })

  it('an unbridged Claude session resumes in the desktop app only from a desktop on its host', () => {
    const link = entry({ session: CLAUDE, harness: 'claude-code' })
    const row = rec({ host: 'ada' })
    expect(primary(row, link, 'ada', true)).toMatchObject({ kind: 'app', href: `claude://resume?session=${CLAUDE}` })
    expect(primary(row, link, 'ada', false).kind).toBe('copy')
    expect(primary(row, link, 'hub', true).kind).toBe('copy')
    // A transcript the daemon did not find is not resumable.
    const missing = parseSessionLinks({ links: [{ session: CLAUDE, availability: 'transcript_missing' }] }).get(CLAUDE)
    expect(primary(row, missing, 'ada', true).kind).toBe('copy')
  })

  it('a Codex thread opens in the app only from a desktop on the host that ran it', () => {
    const link = entry({ session: CODEX, harness: 'codex', desktop_link: `codex://threads/${CODEX}` })
    const row = rec({ session: CODEX, harness: 'codex', host: 'ada' })
    expect(primary(row, link, 'ada', true)).toMatchObject({ kind: 'app', href: `codex://threads/${CODEX}` })
    expect(primary(row, link, 'ada', false)).toMatchObject({ kind: 'copy', copy: CODEX })
    expect(primary(row, link, 'hub', true)).toMatchObject({ kind: 'copy', copy: CODEX })
  })

  it('never links what the daemon did not read for this very session', () => {
    expect(primary(rec({ session: PI }), entry({ session: PI, harness: 'pi' }), 'ada', true).kind).toBe('copy')
    expect(primary(rec({}), entry({ session: CLAUDE, harness: 'claude-code' }), 'hub', true).kind).toBe('copy')
    expect(primary(rec({ session: CODEX, harness: 'codex' }), undefined, 'ada', true).kind).toBe('copy')
    // Not claude.ai, a forged scheme, and another session's thread.
    expect(primary(rec({}), entry({ session: CLAUDE, url: 'https://evil.example/claude.ai/' }), 'ada', true).kind).toBe('copy')
    const forged = entry({ session: CODEX, url: 'javascript:alert(1)', desktop_link: 'codex://threads/x?y' })
    expect(primary(rec({ session: CODEX }), forged, 'ada', true)).toMatchObject({ kind: 'copy', label: CODEX.slice(0, 8) })
    const other = entry({ session: CODEX, desktop_link: `codex://threads/${PI}` })
    expect(primary(rec({ session: CODEX }), other, 'ada', true).kind).toBe('copy')
  })
})

describe('linkRequests', () => {
  it('groups unlinked rows by host, skipping stale hosts and rows already linked', () => {
    const rows = [
      rec({ session: CLAUDE, host: 'ada' }),
      rec({ session: CODEX, host: 'ada' }),
      rec({ session: PI, host: 'hub' }),
      rec({ session: '00000000-0000-4000-8000-000000000001', host: 'stale' }),
    ]
    const requests = linkRequests(rows, new Set([CODEX]), {
      ada: { kind: 'local', stale: false },
      stale: { kind: 'remote', stale: true },
    } as never)
    expect([...requests]).toEqual([
      ['ada', [CLAUDE]],
      ['hub', [PI]],
    ])
  })
})

describe('sessionWhen', () => {
  it('a bare 24-hour clock today, a day in front otherwise, a year only when it differs', () => {
    const now = new Date(2026, 8, 28, 15, 0).getTime()
    expect(sessionWhen(new Date(2026, 8, 28, 9, 5).getTime(), now)).toMatch(/^09:05$/)
    const earlier = sessionWhen(new Date(2026, 8, 26, 14, 2).getTime(), now)
    expect(earlier).toMatch(/26/)
    expect(earlier).toMatch(/14:02$/)
    expect(earlier).not.toMatch(/2026/)
    expect(sessionWhen(new Date(2025, 11, 30, 8, 0).getTime(), now)).toMatch(/2025/)
  })
})
