// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import { Reader } from './Reader.js'
import { buildChannel, chatDocument } from './documents.js'

const alpha = card({ id: 'work/alpha', uid: 'alpha', name: 'Alpha', originId: 'host-a', shuttleKind: 'oneshot' })
let reader: Reader
function setup(phone = false) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: phone && query.includes('max-width'), addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const onReturn = vi.fn(), onOrchestrator = vi.fn(() => false)
  reader = new Reader({ shuttleBase: '', buildProse: () => {
    const el = document.createElement('div'); el.innerHTML = '<header class="ws-chat-head"><div class="ws-chat-acts"></div></header><div class="ws-chat-log"></div>'; return el
  }, onRefreshProse: vi.fn(), onSelect: key => reader.select(key), onReturn, onOrchestrator, onChannel: vi.fn(), cards: () => [alpha] })
  document.body.append(reader.el)
  const channel = buildChannel({ uid: 'alpha', owner: 'host-a', name: 'Alpha', path: '/alpha.md', fiberDir: '/', body: '', isConstitution: true, conversation: true,
    embeds: [{ path: '/report.html' }, { path: '/detail.html' }], sent: [{ path: '/plot.png', time: 1 }] })
  reader.show(channel, chatDocument(channel)!.key, 'Desk', alpha)
  return { channel, onReturn, onOrchestrator }
}
afterEach(() => { reader?.dispose(); document.body.replaceChildren(); vi.unstubAllGlobals() })

it('lands on chat with a persistent report chip and no inset, strip, tabs or bottom page chooser', () => {
  setup()
  expect(reader.document?.kind).toBe('chat')
  expect(reader.el.querySelector('.ws-report-inset')).toBeNull()
  expect(reader.el.querySelector('.ws-chat-head .ws-report-chip')).not.toBeNull()
  expect(reader.el.querySelector('.ws-tabs,.ws-head-index,.ws-thumbbar,.ws-page-choice')).toBeNull()
  reader.el.querySelector<HTMLButtonElement>('.ws-report-chip')!.click()
  expect(reader.document?.name).toBe('report.html')
  reader.back(); expect(reader.document?.kind).toBe('chat')
})
for (const phone of [false, true]) it(`pops nested files then chat then orchestrator/origin, phone=${phone}`, () => {
  const { channel, onReturn, onOrchestrator } = setup(phone)
  for (const name of ['report.html', 'detail.html', 'plot.png']) reader.openDocument(channel.documents.find(d => d.name === name)!.key)
  for (const name of ['detail.html', 'report.html']) { reader.back(); expect(reader.document?.name).toBe(name) }
  reader.back(); expect(reader.document?.kind).toBe('chat'); expect(onReturn).not.toHaveBeenCalled()
  reader.back(); expect(onOrchestrator).toHaveBeenCalledOnce(); expect(onReturn).toHaveBeenCalledOnce()
})
