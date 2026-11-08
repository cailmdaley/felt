// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanCard } from './KanbanTypes.js'
import { card } from './testFixtures.js'
import { Dock } from './workspace/Dock.js'
import { saveConversationOpening } from './conversationOpening.js'

const worker = (over: Partial<KanbanCard> = {}): KanbanCard => card({
  id: 'debug', uid: 'debug-uid', originId: 'host-a', status: 'active',
  workerState: 'running', tmuxSession: 'shuttle-debug', shuttleHost: 'host-a', workerAgent: 'codex-sol', ...over,
})
let dock: Dock
let openWorker: ReturnType<typeof vi.fn<(tmuxSessionName: string, shuttleHost?: string) => void>>
let fetched: string[]
beforeEach(() => {
  const saved = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  fetched = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { fetched.push(String(url)); return new Response('{}') }))
  openWorker = vi.fn()
  dock = new Dock('https://daemon.example', vi.fn(), undefined, openWorker)
  document.body.append(dock.el)
})
afterEach(() => { dock.reset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })
function consoleFor(current: KanbanCard): HTMLAnchorElement {
  dock.open(current)
  const found = dock.el.querySelectorAll<HTMLAnchorElement>('.ws-band-console')
  expect(found.length).toBe(1)
  return found[0]
}
describe("the band's console opens the conversation, as c does", () => {
  it('opens the owner terminal, named with its key', () => {
    const opener = consoleFor(worker())
    expect(opener.hidden).toBe(false)
    expect(opener.hasAttribute('href')).toBe(false)
    expect(opener.getAttribute('role')).toBe('button')
    expect(opener.getAttribute('aria-label')).toBe("Open debug's conversation in Terminal (c)")
    opener.click()
    expect(openWorker.mock.calls).toEqual([['shuttle-debug', 'host-a']])
  })
  it("follows Claude's opening preference, as a native link", () => {
    const live = worker({ workerAgent: 'claude-opus', sessionLink: 'https://claude.ai/code/session_test' })
    saveConversationOpening('terminal')
    const opener = consoleFor(live)
    expect(opener.hasAttribute('href')).toBe(false)
    saveConversationOpening('app'); dock.refreshConversationOpening()
    expect(opener.href).toBe('claude://claude.ai/code/session_test')
    expect(opener.getAttribute('role')).toBeNull()
  })
  it('drops the new tab when the destination moves from the web to the app', () => {
    const live = worker({ workerAgent: 'claude-opus', sessionLink: 'https://claude.ai/code/session_test' })
    saveConversationOpening('browser')
    const opener = consoleFor(live)
    expect(opener.target).toBe('_blank')
    saveConversationOpening('app'); dock.refreshConversationOpening()
    expect(opener.href).toBe('claude://claude.ai/code/session_test')
    expect(opener.hasAttribute('target')).toBe(false)
    expect(opener.hasAttribute('rel')).toBe(false)
  })
  it('opens the remembered destination through the keyboard entry point', () => {
    const live = worker({ workerAgent: 'claude-opus', sessionLink: 'https://claude.ai/code/session_test' })
    const opened: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { opened.push(this.href) })
    saveConversationOpening('app')
    expect(dock.openConversation(live)).toBe(true)
    expect(opened).toEqual(['claude://claude.ai/code/session_test'])
    expect(openWorker).not.toHaveBeenCalled()
    saveConversationOpening('terminal')
    expect(dock.openConversation(live)).toBe(true)
    expect(openWorker).toHaveBeenCalledWith('shuttle-debug', 'host-a')
  })
  it('reopens a past session on its host when no worker is up', async () => {
    const opener = consoleFor(worker({ workerState: undefined, tmuxSession: undefined, status: 'closed', sessionUuid: 'past-session' }))
    expect(opener.hidden).toBe(false)
    expect(opener.getAttribute('aria-label')).toBe("Reopen debug's last session on host-a (c)")
    opener.click()
    await vi.waitFor(() => expect(fetched.some(url => url.endsWith('/api/v1/attach'))).toBe(true))
  })
  it('hides with nowhere to go', () => {
    const opener = consoleFor(worker({ workerState: undefined, tmuxSession: undefined, workerAgent: undefined, status: 'closed' }))
    expect(opener.hidden).toBe(true)
    expect(dock.canOpenConversation(worker({ workerState: undefined, tmuxSession: undefined, status: 'closed' }))).toBe(false)
  })
  it('follows the highlighted thread, as the verbs beside it do', () => {
    const opener = consoleFor(worker())
    dock.setActionCard(worker({ id: 'lander', uid: 'lander-uid', tmuxSession: 'shuttle-lander' }))
    expect(opener.getAttribute('aria-label')).toBe("Open lander's conversation in Terminal (c)")
    opener.click()
    expect(openWorker.mock.calls).toEqual([['shuttle-lander', 'host-a']])
  })
})
