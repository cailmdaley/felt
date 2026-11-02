// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { workerPill } from './appConversation'
import { conversationOpening, CLAUDE_OPENING_KEY, saveConversationOpening, conversationDestinations, resolveDestination, type ConversationOpening } from './conversationOpening'
import { sessionTargets } from './sessionHistory'
import { card } from './testFixtures'

const bridge = 'https://claude.ai/code/session_test'
const worker = card({ id: 'test', status: 'active', workerState: 'running', runtimePhase: 'working', tmuxSession: 'test-shuttle', workerAgent: 'claude-opus', sessionLink: bridge })
const record = { session: 'test-session', host: 'host' }
const link = { session: record.session, harness: 'claude-code', availability: 'available_local', url: bridge }
const desktop = { desktop: true, coarse: false, userAgent: 'Desktop' }

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
  it('defaults to terminal and preserves its owner-routed attach action', () => {
    const attach = vi.fn()
    const pill = workerPill(worker, { openWorker: attach })
    expect(pill.tagName).toBe('BUTTON')
    pill.click()
    expect(attach).toHaveBeenCalledWith('test-shuttle', undefined)
  })

  it.each([
    ['browser', bridge], ['app', 'claude://claude.ai/code/session_test'],
  ] as const)('makes the worker pill and History open the same %s destination', (choice, href) => {
    expect(saveConversationOpening(choice)).toBe(true)
    const pill = workerPill(worker, { openWorker: vi.fn() }) as HTMLAnchorElement
    expect(pill.href).toBe(href)
    expect(sessionTargets(record, link, { desktop: true }).primary).toMatchObject({ href })
  })

  it('falls back to the best destination without changing the remembered choice or turn word', () => {
    saveConversationOpening('app')
    const attach = vi.fn()
    const pill = workerPill({ ...worker, sessionLink: undefined }, { openWorker: attach })
    expect(pill.textContent).toBe('working')
    expect(pill.getAttribute('aria-label')).toBe('working. Open in Terminal')
    pill.click()
    expect(attach).toHaveBeenCalledOnce()
    expect(conversationOpening()).toBe('app')
    expect(sessionTargets(record, { ...link, url: null }, { desktop: true }).primary.kind).toBe('terminal')
  })

  it('uses terminal before browser when a desktop app route is unavailable', () => {
    saveConversationOpening('app')
    const url = `${bridge}?source=remote`
    expect(workerPill({ ...worker, sessionLink: url }, { openWorker: vi.fn() }).tagName).toBe('BUTTON')
    expect(sessionTargets(record, { ...link, url }, { desktop: true }).primary.kind).toBe('terminal')
    expect((workerPill({ ...worker, sessionLink: url }) as HTMLAnchorElement).href).toBe(url)
  })

  it.each(['terminal', 'browser', 'app'] as const)('uses phone HTTPS opening with %s remembered', (choice) => {
    saveConversationOpening(choice)
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    expect((workerPill(worker) as HTMLAnchorElement).href).toBe(bridge)
    expect(sessionTargets(record, link, { desktop: false }).primary).toMatchObject({ kind: 'web', href: bridge })
    const mark = workerPill({ ...worker, sessionLink: undefined })
    expect(mark.tagName).toBe('SPAN')
    expect(mark.title).toContain('Remote Control')
  })

  it('labels Rex and opens Codex workers in their terminal', () => {
    const rex = workerPill({ ...worker, terminalBackend: 'rex' }, { openWorker: vi.fn() })
    expect(rex.getAttribute('aria-label')).toBe('working. Open in Rex')
    const open = vi.fn()
    const codex = workerPill(card({ id: 'codex', tmuxSession: 'codex-shuttle' }), { openWorker: open })
    codex.click()
    expect(open).toHaveBeenCalledWith('codex-shuttle', undefined)
  })

  it('treats a stored Rex preference as no preference', () => {
    localStorage.setItem(CLAUDE_OPENING_KEY, 'rex')
    expect(conversationOpening()).toBe('terminal')
  })

  it.each(['javascript:alert(1)', 'https://claude.ai.evil.example/code/session_test', `${bridge}\n`])('never opens an unsafe session link: %s', (sessionLink) => {
    saveConversationOpening('app')
    expect(workerPill({ ...worker, sessionLink }, { openWorker: vi.fn() }).tagName).toBe('BUTTON')
    expect(sessionTargets(record, { ...link, url: sessionLink }, { desktop: true }).primary.kind).toBe('terminal')
  })

  it('handles unavailable or corrupted storage without breaking opening', () => {
    localStorage.setItem(CLAUDE_OPENING_KEY, 'unknown')
    expect(conversationOpening()).toBe('terminal')
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('disabled') })
    expect(saveConversationOpening('app')).toBe(false)
    expect(conversationOpening()).toBe('terminal')
  })

  it('resolves remembered-if-available-else-first, never duplicates ids or offers phone terminals', () => {
    const id = fc.constantFrom<ConversationOpening>('terminal', 'browser', 'app')
    fc.assert(fc.property(fc.uniqueArray(id), id, fc.boolean(), fc.boolean(), fc.boolean(), (ids, remembered, phone, hasLink, hasOpener) => {
      const entries = ids.map(id => ({ id }))
      expect(resolveDestination(entries, remembered)).toBe(entries.find(entry => entry.id === remembered) ?? entries[0])
      const destinations = conversationDestinations({ ...worker, sessionLink: hasLink ? bridge : undefined },
        { ...desktop, desktop: !phone, coarse: phone }, hasOpener ? vi.fn() : undefined)
      expect(new Set(destinations.map(d => d.id)).size).toBe(destinations.length)
      if (phone || !hasOpener) expect(destinations.some(d => d.id === 'terminal')).toBe(false)
    }), { seed: 20261102, numRuns: 200 })
  })
})
