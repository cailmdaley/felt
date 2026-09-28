import { describe, expect, it } from 'vitest'
import { claudeAppRoute, fiberSessions, linkRequests, parseSessionLinks, sessionTargets, sessionWhen } from './sessionHistory.js'
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
        { session: CLAUDE, availability: 'available_local', harness: 'claude-code', url: 'https://claude.ai/code/session_01X' },
        { session: CODEX, availability: 'available_local', harness: 'codex', url: null },
        { availability: 'available_local' },
        'junk',
      ],
    })
    expect([...links.keys()]).toEqual([CLAUDE, CODEX])
    expect(links.get(CLAUDE)?.url).toBe('https://claude.ai/code/session_01X')
    expect(links.get(CODEX)?.harness).toBe('codex')
    expect(parseSessionLinks(null).size).toBe(0)
  })
})

describe('sessionTargets', () => {
  const entry = (over: Record<string, unknown>) =>
    parseSessionLinks({ links: [{ session: over.session, availability: 'available_local', ...over }] }).get(
      over.session as string,
    )
  const BRIDGE = 'https://claude.ai/code/session_01X'
  const desk = { desktop: true, fiberHost: 'ada' }
  const phone = { desktop: false, fiberHost: 'ada' }

  it('at a desktop a past session resumes in a terminal on the host that ran it', () => {
    for (const [session, harness, host] of [[CLAUDE, 'claude-code', 'ada'], [CODEX, 'codex', 'hub'], [PI, 'pi', 'ada']] as const) {
      expect(sessionTargets(rec({ session, host }), entry({ session, harness }), desk)).toEqual({
        primary: expect.objectContaining({ kind: 'terminal', label: 'resume', body: { session, shuttle_host: host } }),
        extras: [],
      })
    }
  })

  it('before any host answers, a past row already resumes; a host with no transcript does not', () => {
    expect(sessionTargets(rec({}), undefined, desk).primary).toMatchObject({ kind: 'terminal', body: { session: CLAUDE } })
    const missing = parseSessionLinks({ links: [{ session: CLAUDE, availability: 'transcript_missing' }] }).get(CLAUDE)
    expect(sessionTargets(rec({}), missing, desk).primary).toMatchObject({ kind: 'copy', copy: CLAUDE })
  })

  it('the live worker row attaches to its tmux on the fiber host, exactly as Aloft does', () => {
    const live = { ...desk, liveSession: CLAUDE, liveTmux: 'debug-U-shuttle' }
    expect(sessionTargets(rec({ host: 'ada' }), entry({ session: CLAUDE }), live).primary).toMatchObject({
      kind: 'terminal',
      label: 'attach',
      body: { tmux_session: 'debug-U-shuttle', shuttle_host: 'ada' },
    })
  })

  it('a live app conversation (no tmux) is not taken into a terminal', () => {
    const app = { ...desk, liveSession: CODEX }
    expect(sessionTargets(rec({ session: CODEX }), entry({ session: CODEX, harness: 'codex' }), app).primary.kind).toBe('copy')
  })

  it('a bridged Claude session: resume, then the desktop app and the web page; on a phone the web page alone', () => {
    const link = entry({ session: CLAUDE, harness: 'claude-code', url: BRIDGE })
    const targets = sessionTargets(rec({}), link, desk)
    expect(targets.primary.kind).toBe('terminal')
    expect(targets.extras).toEqual([
      { kind: 'app', href: 'claude://claude.ai/code/session_01X', label: 'app', title: 'claude://claude.ai/code/session_01X' },
      { kind: 'web', href: BRIDGE, label: 'web', title: BRIDGE },
    ])
    expect(sessionTargets(rec({}), link, phone)).toEqual({
      primary: { kind: 'web', href: BRIDGE, label: 'claude.ai', title: BRIDGE },
      extras: [],
    })
  })

  it('a live app conversation that was bridged still links its chat, with no terminal', () => {
    const targets = sessionTargets(rec({}), entry({ session: CLAUDE, url: BRIDGE }), { ...desk, liveSession: CLAUDE })
    expect(targets.primary).toMatchObject({ kind: 'app', href: 'claude://claude.ai/code/session_01X' })
    expect(targets.extras.map((t) => t.kind)).toEqual(['web'])
  })

  it('the app route is built only from a URL naming exactly one session', () => {
    expect(claudeAppRoute('https://claude.ai/code/session_01Ab-c_D')).toBe('claude://claude.ai/code/session_01Ab-c_D')
    expect(claudeAppRoute('https://claude.ai/code/cse_01X')).toBe('claude://claude.ai/code/cse_01X')
    for (const url of ['https://claude.ai/code/', 'https://claude.ai/code/session_01X?x=1', 'https://claude.ai/code/other_01X', 'https://claude.ai/code/session_01X/../y']) {
      expect(claudeAppRoute(url)).toBeUndefined()
    }
    // A claude.ai URL of another shape keeps its web link and gets no app link.
    const odd = sessionTargets(rec({}), entry({ session: CLAUDE, url: 'https://claude.ai/code/' }), desk)
    expect(odd.extras.map((t) => t.kind)).toEqual(['web'])
  })

  it('on a phone anything unbridged copies its id', () => {
    for (const [session, harness] of [[CLAUDE, 'claude-code'], [CODEX, 'codex'], [PI, 'pi']] as const) {
      expect(sessionTargets(rec({ session }), entry({ session, harness }), phone).primary).toMatchObject({
        kind: 'copy',
        label: session.slice(0, 8),
        copy: session,
      })
    }
  })

  it('only a claude.ai address is ever linked', () => {
    for (const url of ['https://evil.example/claude.ai/', 'javascript:alert(1)', 'https://claude.ai.evil.example/']) {
      const link = entry({ session: CLAUDE, url })
      expect(sessionTargets(rec({}), link, desk).extras).toEqual([])
      expect(sessionTargets(rec({}), link, phone).primary.kind).toBe('copy')
    }
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
