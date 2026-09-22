import { describe, expect, it } from 'vitest'
import { workerStatusLabel, workerVariant, appConversationTarget, canOpenDesktopApp, validDesktopThreadLink } from './appConversation.js'

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

describe('shared worker activity labels', () => {
  it.each([
    [undefined, 'Aloft'], ['working', 'Aloft'], ['waiting', 'Waiting'],
    ['attention', 'Needs you'], ['blocked', 'Blocked'],
  ])('shows %s in the worker marker', (phase, label) => {
    expect(workerStatusLabel(phase)).toBe(label)
  })
  it('keeps a launch failure ahead of cached native activity', () => {
    expect(workerStatusLabel('waiting', 'failed')).toBe('Blocked')
  })
})


describe('shared worker appearance', () => {
  it('uses the same minute boundary for every waiting worker', () => {
    const waiting = { runtimePhase: 'waiting', lastActivityAt: 1000 }
    expect(workerVariant(waiting, 60_999)).toBe('aloft')
    expect(workerVariant(waiting, 61_000)).toBe('waiting')
    expect(workerVariant({ runtimePhase: 'attention' }, 1000)).toBe('attention')
    expect(workerVariant({ runtimePhase: 'blocked' }, 1000)).toBe('attention')
    expect(workerVariant({ runtimePhase: 'working' }, 1000)).toBe('aloft')
  })
  it('still opens ChatGPT when no desktop conversation route is available', () => {
    expect(appConversationTarget({}, true)).toMatchObject({ href: 'https://chatgpt.com/open-app', conversationSpecific: false })
  })
})
