// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import { head, resetDocumentResources } from '../documentResources.js'
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
    const el = document.createElement('div'); el.innerHTML = '<header class="ws-chat-head"><div class="ws-chat-acts"></div><div class="ws-chat-refs"></div></header><div class="ws-chat-log"></div>'; return el
  }, onRefreshProse: vi.fn(), onSelect: key => reader.select(key), onOpenDocument: key => reader.select(key), onReturn, onOrchestrator, onChannel: vi.fn(), cards: () => [alpha] })
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
})
for (const phone of [false, true]) it(`delegates Back and Escape to navigation without climbing structure, phone=${phone}`, () => {
  const { channel, onReturn, onOrchestrator } = setup(phone)
  reader.openDocument(channel.documents.find(d => d.name === 'plot.png')!.key)
  reader.setBackDestination('Earlier constitution')
  expect(reader.el.querySelector('.ws-return')?.getAttribute('aria-label')).toBe('Back to Earlier constitution')
  expect(reader.el.querySelector('.ws-document-back')?.getAttribute('title')).toBe('Back to Earlier constitution')
  const documentBacks = [...reader.el.querySelectorAll('.ws-document-back')]
  expect(documentBacks.length).toBeGreaterThan(0)
  for (const back of documentBacks) expect(back.querySelector('.ws-back-label')?.textContent).toBe('Earlier constitution')
  reader.setBackDestination('Chat')
  for (const back of documentBacks) expect(back.querySelector('.ws-back-label')?.textContent).toBe('Chat')
  reader.back()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(onReturn).toHaveBeenCalledTimes(2)
  expect(onOrchestrator).not.toHaveBeenCalled()
})


it('omits missing sent files from header chips using cached metadata only', async () => {
  setup()
  resetDocumentResources()
  const fetch = vi.fn(async () => Response.json({ exists: false }))
  vi.stubGlobal('fetch', fetch)
  await head('/api/v1/file?path=%2Fgone.change.json&origin=host-a')
  const channel = buildChannel({ uid: 'alpha', owner: 'host-a', name: 'Alpha', path: '/alpha.md', fiberDir: '/', body: '', conversation: true,
    sent: [{ path: '/gone.change.json', time: 2 }, { path: '/kept.change.json', time: 1 }] })
  reader.show(channel, chatDocument(channel)!.key, 'Board', alpha)
  expect(reader.el.querySelector('[data-document-key="host-a:/gone.change.json"].ws-report-chip')).toBeNull()
  expect(reader.el.querySelectorAll('.ws-report-chip')).toHaveLength(1)
  expect(fetch.mock.calls.filter(call => String((call as unknown[])[0]).includes('/file-info?'))).toHaveLength(1)
  resetDocumentResources()
})

it('opens the fiber artifact instead of a newer nested artifact', () => {
  setup()
  const channel = buildChannel({ uid: 'alpha', owner: 'host-a', name: 'Alpha', path: '/notes/alpha/alpha.md', fiberDir: '/notes/alpha', body: '', isConstitution: true, conversation: true,
    sent: [{ path: 'checks/artifact.html', time: 2 }, { path: 'artifact.html', time: 1 }] })
  reader.show(channel, chatDocument(channel)!.key, 'Board', alpha)
  reader.el.querySelector<HTMLButtonElement>('.ws-report-chip')!.click()
  expect(reader.document?.path).toBe('/notes/alpha/artifact.html')
})
