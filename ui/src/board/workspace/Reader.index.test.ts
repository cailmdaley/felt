// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import { Reader } from './Reader.js'
import type { Channel, WorkspaceDocument } from './documents.js'

const alpha = card({ id: 'work/alpha', uid: 'alpha', name: 'Alpha', originId: 'host-a' })
const page = (n: number): WorkspaceDocument => ({ key: `fiber:host-a:page-${n}`, owner: 'host-a', path: `/page-${n}`, name: `Page ${n}`, kind: 'fiber', provenance: [{ kind: 'fiber' }] })
const documents = [page(0), page(1)]
const channel: Channel = { uid: 'alpha', owner: 'host-a', name: 'Alpha', documents, labels: ['A', 'B'], body: '' }
const rect = (left: number, right: number): DOMRect => ({ left, right, width: right - left, top: 0, bottom: 40, height: 40, x: left, y: 0, toJSON: () => ({}) }) as DOMRect

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals() })

it('confines the tab map to the stage, clear of the side columns, wherever the board bar seats it', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const reader = new Reader({
    shuttleBase: '', buildProse: () => document.createElement('div'), onRefreshProse: vi.fn(),
    onSelect: vi.fn(), onReturn: vi.fn(), onChannel: vi.fn(), cards: () => [alpha], switcherCards: () => [alpha], files: () => [],
  })
  // The board bar's slot runs from after Find to the settings button; the stage stops where the threads rail starts.
  const slot = document.createElement('div'); slot.append(reader.barIndex)
  document.body.append(slot, reader.el)
  slot.getBoundingClientRect = () => rect(576, 1384)
  reader.stage.getBoundingClientRect = () => rect(384, 1100)
  Object.defineProperty(reader.stage, 'clientWidth', { configurable: true, value: 716 })
  Object.defineProperty(reader.stage, 'clientHeight', { configurable: true, value: 800 })
  reader.show(channel, documents[0].key, 'Desk', alpha)
  expect(reader.barIndex.style.marginLeft).toBe('0px')
  expect(reader.barIndex.style.marginRight).toBe('284px')
  reader.dispose()
})
