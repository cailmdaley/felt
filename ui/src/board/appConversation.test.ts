import { describe, expect, it } from 'vitest'
import { appConversationLabel, appConversationTarget, canOpenDesktopApp, validDesktopThreadLink } from './appConversation.js'

const route = 'codex://threads/01a0be38-6c36-7cd1-aec9-53a680d1f693'
const card = { desktopLink: route, shuttleHost: 'workstation', shuttleProjectDir: '/work/felt' }

describe('app conversation opening', () => {
  it('offers the exact verified native route on desktop', () => {
    expect(appConversationTarget(card, true).href).toBe(route)
    expect(appConversationTarget(card, true).title).toContain('If it does not select this host')
  })

  it('keeps phones on truthful host/project guidance without inventing a universal link', () => {
    const target = appConversationTarget(card, false)
    expect(target.href).toBeUndefined()
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

describe('native app activity labels', () => {
  it.each([
    ['working', '◌ ChatGPT working'], ['waiting', '⏸ ChatGPT waiting'],
    ['attention', '☞︎ ChatGPT needs you'], ['blocked', '⚠ ChatGPT blocked'],
  ])('shows %s in the app marker', (phase, label) => {
    expect(appConversationLabel(phase)).toBe(label)
  })
  it('keeps a launch failure ahead of cached native activity', () => {
    expect(appConversationLabel('waiting', 'failed')).toBe('⚠ ChatGPT blocked')
  })
})
