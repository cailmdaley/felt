// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import { Reader } from './Reader.js'
import { buildChannel, defaultSelection } from './documents.js'

const alpha = card({ id: 'work/alpha', uid: 'alpha', name: 'Alpha', originId: 'host-a', shuttleKind: 'oneshot' })

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals() })

it('floats the map of pages above the centre column, the chat last and selected, no constitution tile', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const reader = new Reader({
    shuttleBase: '', buildProse: () => document.createElement('div'), onRefreshProse: vi.fn(),
    onSelect: vi.fn(), onReturn: vi.fn(), onChannel: vi.fn(), cards: () => [alpha], switcherCards: () => [alpha], files: () => [],
  })
  document.body.append(reader.el)
  const channel = buildChannel({ uid: 'alpha', owner: 'host-a', name: 'Alpha', path: '/alpha.md', fiberDir: '/', body: '', isConstitution: true, conversation: true,
    embeds: [{ path: '/report.html' }], sent: [{ path: '/plot.png', time: 1 }] })
  reader.show(channel, defaultSelection(channel), 'Desk', alpha)
  const band = reader.el.querySelector<HTMLElement>('[data-part="page-band"]')!
  // In the centre column, directly above the stage; not in the phone's top bar or the board's.
  expect(band.parentElement?.classList.contains('ws-stage-column')).toBe(true)
  expect(band.nextElementSibling).toBe(reader.stage)
  expect(reader.el.querySelector('.ws-navbar [data-part="page-band"]')).toBeNull()
  const tabs = [...band.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  expect(tabs.map(tab => tab.dataset.kind)).toEqual(['image', 'html', 'chat'])
  expect(tabs.at(-1)?.getAttribute('aria-selected')).toBe('true')
  // Opening the constitution draws it as a plain § tile, selected, until another page is.
  const fiber = channel.documents.find(d => d.kind === 'fiber')!
  reader.select(fiber.key)
  const withFiber = [...band.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  expect(withFiber.map(tab => tab.dataset.kind)).toEqual(['fiber', 'image', 'html', 'chat'])
  expect(withFiber[0].getAttribute('aria-selected')).toBe('true')
  reader.select(channel.documents.at(-1)!.key)
  expect([...band.querySelectorAll<HTMLButtonElement>('[role="tab"]')].map(tab => tab.dataset.kind)).toEqual(['image', 'html', 'chat'])
  reader.dispose()
})
