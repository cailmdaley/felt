// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import { Reader } from './Reader.js'
import { declaredTitle } from './DocumentTitles.js'
import { buildChannel, channelLead, proseDocument } from './documents.js'

const alpha = card({ id: 'work/alpha', uid: 'alpha', name: 'Alpha', originId: 'host-a', shuttleKind: 'oneshot' })
let reader: Reader
function setup(phone = false, sent = [{ path: '/plot.png', time: 1 }]) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: phone && query.includes('max-width'), addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const onReturn = vi.fn(), onOrchestrator = vi.fn(() => false)
  reader = new Reader({ shuttleBase: '', buildProse: () => document.createElement('div'), onRefreshProse: vi.fn(), onSelect: key => reader.select(key), onOpenDocument: key => reader.select(key), onRevisitDocument: key => reader.select(key), onReturn, onOrchestrator, onChannel: vi.fn(), cards: () => [alpha] })
  document.body.append(reader.el)
  const channel = buildChannel({ uid: 'alpha', owner: 'host-a', name: 'Alpha', path: '/alpha.md', fiberDir: '/', body: '', isConstitution: true,
    embeds: [{ path: '/report.html' }, { path: '/detail.html' }], sent })
  reader.show(channel, proseDocument(channel)!.key, 'Desk', alpha)
  return { channel, onReturn, onOrchestrator }
}
it('names a sent change from its head before it is opened', async () => {
  const peeks: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { peeks.push(String(url)); return new Response('{"version": 2, "title": "A readable change", "files": [', { status: 206, headers: { etag: 'W/"a"' } }) }))
  setup(false, [{ path: '/review.change.json', time: 2 }])
  await vi.waitFor(() => expect(declaredTitle('host-a:/review.change.json')?.title).toBe('A readable change'))
  expect(peeks.some(url => url.includes('review.change.json'))).toBe(true)
})
afterEach(() => { reader?.dispose(); document.body.replaceChildren(); vi.unstubAllGlobals() })

it('shows a run of pages with no inset, strip, tabs or bottom page chooser', () => {
  setup()
  expect(reader.document?.kind).toBe('fiber')
  expect(reader.el.querySelector('.ws-report-inset')).toBeNull()
  expect(reader.el.querySelector('.ws-tabs,.ws-head-index,.ws-thumbbar,.ws-page-choice')).toBeNull()
})
it('seats the band over the stage and clears it where a page has none', () => {
  const { channel } = setup()
  const band = reader.el.querySelector<HTMLElement>('.ws-stage-band')!
  const stage = band.parentElement!.querySelector('.ws-stage')
  expect(band.hidden).toBe(true)
  const first = document.createElement('div'), second = document.createElement('div')
  reader.setBand(first)
  expect(band.hidden).toBe(false)
  expect([...band.children]).toEqual([first])
  expect(band.nextElementSibling).toBe(stage)
  reader.show(channel, channel.documents.find(d => d.name === 'plot.png')!.key, 'Desk', alpha)
  expect(band.firstChild).toBe(first)
  reader.setBand(second)
  expect([...band.children]).toEqual([second])
  reader.setBand(null)
  expect(band.hidden).toBe(true)
  expect(band.children).toHaveLength(0)
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
  reader.setBackDestination('Constitution')
  for (const back of documentBacks) expect(back.querySelector('.ws-back-label')?.textContent).toBe('Constitution')
  reader.back()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(onReturn).toHaveBeenCalledTimes(2)
  expect(onOrchestrator).not.toHaveBeenCalled()
})

it('leads with the fiber artifact instead of a newer nested artifact', () => {
  const channel = buildChannel({ uid: 'alpha', owner: 'host-a', name: 'Alpha', path: '/notes/alpha/alpha.md', fiberDir: '/notes/alpha', body: '', isConstitution: true,
    sent: [{ path: 'checks/artifact.html', time: 2 }, { path: 'artifact.html', time: 1 }] })
  expect(channelLead(channel)?.path).toBe('/notes/alpha/artifact.html')
})
