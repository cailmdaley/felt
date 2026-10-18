import { describe, expect, it } from 'vitest'
import { turnTitle, appConversationTarget, canOpenDesktopApp, validDesktopThreadLink } from './appConversation.js'
import type { KanbanCard } from './KanbanTypes.js'

const route = 'codex://threads/01a0be38-6c36-7cd1-aec9-53a680d1f693'
const card = { desktopLink: route, shuttleHost: 'workstation', shuttleProjectDir: '/work/felt' }

describe('app conversation opening', () => {
  it('offers the exact verified native route on desktop', () => {
    expect(appConversationTarget(card, true).href).toBe(route)
    expect(appConversationTarget(card, true).title).toContain('If it does not select this host')
  })

  it('opens the mobile app while retaining host/project guidance', () => {
    const target = appConversationTarget(card, false)
    expect(target.href).toBe('https://chatgpt.com/open-app')
    expect(target.conversationSpecific).toBe(false)
    expect(target.ariaLabel).toBe('Open ChatGPT app')
    expect(target.guidance).toBe('Continue in ChatGPT → Remote → workstation → felt, then choose this conversation.')
    expect(canOpenDesktopApp('Mozilla/5.0 (iPhone) Mobile', false)).toBe(false)
    expect(canOpenDesktopApp('Mozilla/5.0 (Linux; Android 16)', false)).toBe(false)
    expect(canOpenDesktopApp('Mozilla/5.0 (Macintosh)', true)).toBe(false)
    expect(canOpenDesktopApp('Mozilla/5.0 (Macintosh)', false)).toBe(true)
  })

  it.each([
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) Mobile',
    'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X)',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  ])('uses the native ChatGPT opener on iOS, including desktop-mode iPad: %s', (userAgent) => {
    const coarse = /iPad|Macintosh/.test(userAgent)
    expect(appConversationTarget(card, false, userAgent, coarse).href).toBe('chatgpt://')
  })

  it('keeps Android on the HTTPS app fallback', () => {
    expect(appConversationTarget(card, false, 'Mozilla/5.0 (Linux; Android 16)', true).href).toBe('https://chatgpt.com/open-app')
  })

  it.each([
    'javascript:alert(1)', 'codex://review?anything', `${route}?host=other`,
    `${route}/../new`, 'codex://threads/not-a-uuid', 'https://chatgpt.com/codex/tasks/anything',
    `${route}\n`, null,
  ])('rejects invalid or unsupported native destinations %s', (value) => {
    expect(validDesktopThreadLink(value)).toBeUndefined()
  })

  it('keeps launch errors visible alongside an actionable desktop link', () => {
    const target = appConversationTarget({ ...card, launchError: 'Turn could not be confirmed' }, true)
    expect(target.href).toBe(route)
    expect(target.title).toContain('Turn could not be confirmed')
  })
})

describe('shared worker title', () => {
  it('states the turn in full with its age', () => {
    const now = Date.parse('2026-10-18T12:00:00Z')
    const idle = { status: 'active', workerState: 'running', runtimePhase: 'waiting', lastActivityAt: now - 3 * 3_600_000 } as KanbanCard
    expect(turnTitle(idle, now)).toBe('The worker ended its turn with nothing running under it. (3h)')
    expect(turnTitle({ ...idle, launchError: 'refused' }, now)).toBe('refused (3h)')
  })
  it('still opens ChatGPT when no desktop conversation route is available', () => {
    expect(appConversationTarget({}, true)).toMatchObject({ href: 'https://chatgpt.com/open-app', conversationSpecific: false })
  })
})
