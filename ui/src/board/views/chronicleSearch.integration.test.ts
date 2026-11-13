// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import './ChronicleView.js'
import { getView, type ViewContext } from './ViewRegistry.js'
import { settle } from '../testFixtures.js'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('navigates record hits with arrows and Enter while retaining the query; Escape clears and dismisses', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ results: [] }))))
  const Constructor = getView('chronicle')!.constructor as new () => object
  const view = new Constructor() as {
    buildSearch(ctx: ViewContext): HTMLElement
    resetSearch(): void
    jumpTo(hit: { id: string }, ctx: ViewContext): void
  }
  const ctx = { cards: [{ id: 'work/shear', name: 'Shear response' }, { id: 'work/shear-map', name: 'Shear map' }], shuttleBase: '' } as unknown as ViewContext
  const jump = vi.spyOn(view, 'jumpTo').mockImplementation(() => {})
  const box = view.buildSearch(ctx)
  document.body.append(box)
  await settle()
  const input = box.querySelector('input')!
  input.focus()
  input.value = 'shear'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  const key = async (key: string) => { input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); await settle() }
  await key('ArrowDown')
  expect(input.getAttribute('role')).toBe('combobox')
  expect(input.getAttribute('aria-expanded')).toBe('true')
  expect(document.activeElement).toBe(input)
  const first = document.getElementById(input.getAttribute('aria-activedescendant')!)!
  expect(first.getAttribute('role')).toBe('option')
  await key('ArrowDown')
  const second = document.getElementById(input.getAttribute('aria-activedescendant')!)!
  expect(second).not.toBe(first)
  await key('Enter')
  expect(jump).toHaveBeenCalledOnce()
  expect(input.value).toBe('shear')
  await key('ArrowDown')
  await key('Escape')
  expect(input.value).toBe('')
  expect(input.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).not.toBe(input)
  view.resetSearch()
})
