import { describe, expect, it } from 'vitest'
import { fiberSessions, parseSessionLinks, sessionTarget, sessionWhen } from './sessionHistory.js'
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

describe('sessionTarget', () => {
  const entry = (over: Record<string, unknown>) =>
    parseSessionLinks({ links: [{ session: over.session, availability: 'available_local', ...over }] }).get(
      over.session as string,
    )

  it('a bridged Claude session opens its claude.ai page from any viewer', () => {
    const link = entry({ session: CLAUDE, harness: 'claude-code', url: 'https://claude.ai/code/session_01X' })
    for (const [host, desktop] of [['ada', true], ['elsewhere', false]] as const) {
      expect(sessionTarget(rec({}), link, host, desktop)).toMatchObject({
        kind: 'web',
        href: 'https://claude.ai/code/session_01X',
      })
    }
  })

  it('a Codex thread opens in the app only from a desktop on the host that ran it', () => {
    const link = entry({ session: CODEX, harness: 'codex', desktop_link: `codex://threads/${CODEX}` })
    const row = rec({ session: CODEX, harness: 'codex', host: 'ada' })
    expect(sessionTarget(row, link, 'ada', true)).toMatchObject({ kind: 'app', href: `codex://threads/${CODEX}` })
    expect(sessionTarget(row, link, 'ada', false)).toMatchObject({ kind: 'copy', copy: CODEX })
    expect(sessionTarget(row, link, 'hub', true)).toMatchObject({ kind: 'copy', copy: CODEX })
  })

  it('never builds a link the daemon did not read', () => {
    // pi, an unbridged Claude session, an unknown one, and a forged scheme.
    expect(sessionTarget(rec({ session: PI }), entry({ session: PI, harness: 'pi' }), 'ada', true).kind).toBe('copy')
    expect(sessionTarget(rec({}), entry({ session: CLAUDE, harness: 'claude-code' }), 'ada', true).kind).toBe('copy')
    expect(sessionTarget(rec({ session: CODEX, harness: 'codex' }), undefined, 'ada', true).kind).toBe('copy')
    const forged = entry({ session: CODEX, url: 'javascript:alert(1)', desktop_link: 'codex://threads/x?y' })
    expect(sessionTarget(rec({ session: CODEX }), forged, 'ada', true)).toMatchObject({ kind: 'copy', label: CODEX.slice(0, 8) })
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
