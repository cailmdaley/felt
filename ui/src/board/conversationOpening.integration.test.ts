// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { terminalWorkerPill, appWorkerLink } from './appConversation'
import { claudeOpening, CLAUDE_OPENING_KEY, saveClaudeOpening } from './conversationOpening'
import { sessionTargets } from './sessionHistory'
import { card } from './testFixtures'

const bridge = 'https://claude.ai/code/session_test'
const worker = card({ id: 'test', tmuxSession: 'test-shuttle', workerAgent: 'claude-opus', sessionLink: bridge })
const record = { session: 'test-session', host: 'host' }
const link = { session: record.session, harness: 'claude-code', availability: 'available_local', url: bridge }

beforeEach(() => {
  const saved = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  })
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('conversation opening', () => {
  it('defaults to Kitty and preserves its attach action', () => {
    const attach = vi.fn()
    const pill = terminalWorkerPill(worker, { openWorker: attach })
    expect(pill.tagName).toBe('BUTTON')
    pill.click()
    expect(attach).toHaveBeenCalledWith('test-shuttle', undefined)
  })

  it.each([
    ['browser', bridge], ['app', 'claude://claude.ai/code/session_test'],
  ] as const)('makes Aloft and History open the same %s destination', (choice, href) => {
    expect(saveClaudeOpening(choice)).toBe(true)
    const attach = vi.fn()
    const pill = terminalWorkerPill(worker, { openWorker: attach }) as HTMLAnchorElement
    expect(pill.tagName).toBe('A')
    expect(pill.href).toBe(href)
    expect(sessionTargets(record, link, { desktop: true }).primary).toMatchObject({ href })
    expect(sessionTargets(record, link, { desktop: true }).extras[0]).toMatchObject({ kind: 'terminal' })
    expect(attach).not.toHaveBeenCalled()
  })

  it('explicitly labels the terminal fallback when Remote Control is absent', () => {
    saveClaudeOpening('browser')
    const attach = vi.fn()
    const pill = terminalWorkerPill({ ...worker, sessionLink: undefined }, { openWorker: attach })
    expect(pill.textContent).toBe('Aloft · terminal')
    expect(pill.title).toContain('No Claude Remote Control link')
    pill.click()
    expect(attach).toHaveBeenCalledOnce()
    expect(sessionTargets(record, { ...link, url: null }, { desktop: true })).toMatchObject({
      primary: { kind: 'terminal', label: 'terminal' }, guidance: expect.stringContaining('Remote Control'),
    })
  })

  it.each(['browser', 'app'] as const)('retains query-bearing Remote Control HTTPS links with %s selected', (choice) => {
    saveClaudeOpening(choice)
    const url = `${bridge}?source=remote`
    const pill = terminalWorkerPill({ ...worker, sessionLink: url }, { openWorker: vi.fn() }) as HTMLAnchorElement
    expect(pill.tagName).toBe('A')
    expect(pill.href).toBe(url)
    const history = sessionTargets(record, { ...link, url }, { desktop: true })
    expect(history.primary).toMatchObject({ kind: 'web', href: url })
    if (choice === 'app') {
      expect(pill.textContent).toBe('Aloft · browser')
      expect(pill.title).toContain('no supported Claude desktop app route')
      expect(history.guidance).toContain('no supported Claude desktop app route')
      expect(history.guidance).not.toContain('No Claude Remote Control link')
    }
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    expect((terminalWorkerPill({ ...worker, sessionLink: url }) as HTMLAnchorElement).href).toBe(url)
    expect(sessionTargets(record, { ...link, url }, { desktop: false }).primary).toMatchObject({ kind: 'web', href: url })
  })

  it.each(['terminal', 'browser', 'app'] as const)('preserves phone HTTPS opening with %s selected', (choice) => {
    saveClaudeOpening(choice)
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const pill = terminalWorkerPill(worker) as HTMLAnchorElement
    expect(pill.href).toBe(bridge)
    expect(sessionTargets(record, link, { desktop: false }).primary).toMatchObject({ kind: 'web', href: bridge })
  })

  it('leaves Codex CLI terminals and Codex app links alone', () => {
    saveClaudeOpening('app')
    const cli = terminalWorkerPill({ ...worker, workerAgent: 'codex-sol', sessionLink: undefined }, { openWorker: vi.fn() })
    expect(cli.textContent).toBe('Aloft')
    expect(cli.tagName).toBe('BUTTON')
    const route = 'codex://threads/01a0be38-6c36-7cd1-aec9-53a680d1f693'
    expect(appWorkerLink(card({ id: 'codex', desktopLink: route })).href).toBe(route)
  })

  it.each(['javascript:alert(1)', 'https://claude.ai.evil.example/code/session_test', `${bridge}\n`])('never opens an unsafe session link: %s', (sessionLink) => {
    saveClaudeOpening('app')
    expect(terminalWorkerPill({ ...worker, sessionLink }, { openWorker: vi.fn() }).tagName).toBe('BUTTON')
    expect(sessionTargets(record, { ...link, url: sessionLink }, { desktop: true }).primary.kind).toBe('terminal')
  })

  it('handles unavailable or corrupted storage without breaking opening', () => {
    localStorage.setItem(CLAUDE_OPENING_KEY, 'unknown')
    expect(claudeOpening()).toBe('terminal')
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('disabled') })
    expect(saveClaudeOpening('app')).toBe(false)
    expect(claudeOpening()).toBe('terminal')
  })
})
