// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import type { KanbanCard } from './KanbanTypes'
import { Dock } from './workspace/Dock'
import { conversationOpening, CLAUDE_OPENING_KEY, saveConversationOpening, conversationDestinations, resolveDestination, REX_PHONE_SHORTCUT, type ConversationOpening, type WorkerOpener } from './conversationOpening'
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
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren() })
const bandConsole = (current: KanbanCard, openWorker?: WorkerOpener): HTMLAnchorElement => {
  const dock = new Dock('', vi.fn(), undefined, openWorker)
  dock.open(current)
  document.body.append(dock.el)
  return dock.el.querySelector<HTMLAnchorElement>('.ws-band-console')!
}
const opensInPlace = (opener: HTMLAnchorElement): boolean => !opener.hidden && !opener.hasAttribute('href')

describe('conversation opening', () => {
  it('defaults to terminal and preserves its owner-routed attach action', () => {
    const attach = vi.fn()
    const opener = bandConsole(worker, attach)
    expect(opensInPlace(opener)).toBe(true)
    opener.click()
    expect(attach).toHaveBeenCalledWith('test-shuttle', undefined, undefined)
  })

  it.each([
    ['browser', bridge], ['app', 'claude://claude.ai/code/session_test'],
  ] as const)('makes the band console and History open the same %s destination', (choice, href) => {
    expect(saveConversationOpening(choice)).toBe(true)
    expect(bandConsole(worker, vi.fn()).href).toBe(href)
    expect(sessionTargets(record, link, { desktop: true }).primary).toMatchObject({ href })
  })

  it('falls back to the best destination without changing the remembered choice', () => {
    saveConversationOpening('app')
    const attach = vi.fn()
    const opener = bandConsole({ ...worker, sessionLink: undefined }, attach)
    expect(opener.getAttribute('aria-label')).toBe("Open test's conversation in Terminal (c)")
    opener.click()
    expect(attach).toHaveBeenCalledOnce()
    expect(conversationOpening()).toBe('app')
    expect(sessionTargets(record, { ...link, url: null }, { desktop: true }).primary.kind).toBe('terminal')
  })

  it('uses terminal before browser when a desktop app route is unavailable', () => {
    saveConversationOpening('app')
    const url = `${bridge}?source=remote`
    expect(opensInPlace(bandConsole({ ...worker, sessionLink: url }, vi.fn()))).toBe(true)
    expect(sessionTargets(record, { ...link, url }, { desktop: true }).primary.kind).toBe('terminal')
    expect(bandConsole({ ...worker, sessionLink: url }).href).toBe(url)
  })

  it.each(['terminal', 'browser', 'app'] as const)('uses phone HTTPS opening with %s remembered', (choice) => {
    saveConversationOpening(choice)
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    expect(bandConsole(worker).href).toBe(bridge)
    expect(sessionTargets(record, link, { desktop: false }).primary).toMatchObject({ kind: 'web', href: bridge })
    expect(bandConsole({ ...worker, sessionLink: undefined }).hidden).toBe(true)
  })

  it('labels Rex and opens Codex workers in their terminal', () => {
    const rex = bandConsole({ ...worker, terminalBackend: 'rex' }, vi.fn())
    expect(rex.getAttribute('aria-label')).toBe("Open test's conversation in Rex (c)")
    const open = vi.fn()
    const codex = bandConsole(card({ id: 'codex', status: 'active', workerState: 'running', tmuxSession: 'codex-shuttle' }), open)
    codex.click()
    expect(open).toHaveBeenCalledWith('codex-shuttle', undefined, undefined)
  })

  it('keeps a stored Rex preference', () => {
    localStorage.setItem(CLAUDE_OPENING_KEY, 'rex')
    expect(conversationOpening()).toBe('rex')
  })

  it('offers a phone Rex for iOS through its Shortcut, after the exact Claude session', () => {
    const phone = { desktop: false, userAgent: 'iPhone', coarse: true }
    const rexWorker = { ...worker, terminalBackend: 'rex' as const, sessionLink: bridge }
    expect(conversationDestinations(rexWorker, phone, vi.fn()).map(d => [d.id, d.href])).toEqual([['browser', bridge], ['rex', REX_PHONE_SHORTCUT]])
    expect(conversationDestinations({ ...rexWorker, terminalBackend: 'tmux' }, phone, vi.fn()).map(d => d.id)).toEqual(['browser'])
    expect(resolveDestination(conversationDestinations(rexWorker, phone, vi.fn()), 'terminal')?.id).toBe('browser')
  })

  it('hands the phone Rex Shortcut the worker family session to open', () => {
    const phone = { desktop: false, userAgent: 'iPhone', coarse: true }
    const rex = conversationDestinations({ ...worker, rexSession: 'ai-futures/felt' }, phone, vi.fn()).find(d => d.id === 'rex')
    expect(rex?.href).toBe(`${REX_PHONE_SHORTCUT}&input=text&text=ai-futures%2Ffelt`)
  })

  it.each(['javascript:alert(1)', 'https://claude.ai.evil.example/code/session_test', `${bridge}\n`])('never opens an unsafe session link: %s', (sessionLink) => {
    saveConversationOpening('app')
    expect(opensInPlace(bandConsole({ ...worker, sessionLink }, vi.fn()))).toBe(true)
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
