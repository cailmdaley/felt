// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import { ConstitutionPicker } from './ConstitutionPicker.js'

let picker: ConstitutionPicker | undefined
afterEach(() => { picker?.dispose(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('keeps a row and its focus across a refresh, in the order of its cards', () => {
  const alpha = card({ id: 'alpha' }), beta = card({ id: 'beta' })
  let cards = [alpha, beta]
  picker = new ConstitutionPicker({ cards: () => cards, onOpen: vi.fn() })
  document.body.append(picker.el)
  picker.refresh()
  const row = picker.el.querySelector<HTMLElement>('[data-channel-uid="beta"]')!
  row.focus()
  cards = [beta, alpha]
  picker.refresh()
  expect(picker.el.querySelector('[data-channel-uid="beta"]')).toBe(row)
  expect(document.activeElement).toBe(row)
  expect([...picker.el.querySelectorAll<HTMLElement>('.ws-channel-row')].map(el => el.dataset.channelUid)).toEqual(['beta', 'alpha'])
})

it('sets its rows before a supplement, and drops rows Find no longer matches', () => {
  const supplement = { el: document.createElement('section'), refresh: vi.fn(), close: vi.fn(), dispose: vi.fn() }
  const find = document.createElement('input')
  picker = new ConstitutionPicker({ cards: () => [card({ id: 'alpha', name: 'Alpha' }), card({ id: 'beta', name: 'Beta' })], onOpen: vi.fn(), find, supplement })
  document.body.append(picker.el)
  picker.refresh()
  const list = picker.el.querySelector('.ws-channel-list')!
  expect([...list.children].at(-1)).toBe(supplement.el)
  expect(list.querySelectorAll('.ws-channel-row')).toHaveLength(2)
  find.value = 'beta'
  picker.refresh()
  expect([...list.querySelectorAll<HTMLElement>('.ws-channel-row')].map(el => el.dataset.channelUid)).toEqual(['beta'])
  expect(supplement.refresh).toHaveBeenLastCalledWith('beta')
})
