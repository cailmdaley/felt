// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { StashForm, injectStashFormStyles } from './StashForm'
import { blockingDialogOpen } from '../board/views/ViewRegistry'

let root: Root
const cancel = vi.fn()
async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () =>
    url.includes('/agents') ? [] : { fibers: [
      { fiber: { id: 'forms-test/parent', name: 'Parent task' } },
      { fiber: { id: 'other-project', name: 'Elsewhere' } },
    ] },
  })))
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  injectStashFormStyles()
  await act(async () => root.render(<StashForm
    hosts={[{ id: 'local', label: 'Desktop', isLocal: true, nativeFolderPicker: true, browserCapable: true }]}
    projects={[{ id: 'local:/work', name: 'Work', path: '/work', originId: 'local', loomPrefix: 'forms-test' }]}
    tagSuggestions={['research', 'review']} onCancel={cancel} onCreated={vi.fn()}
  />))
}
function key(el: Element, value: string) {
  return act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })) })
}
afterEach(() => {
  act(() => root?.unmount())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  cancel.mockClear()
})

it('announces the highlighted project-relative parent and lets Escape close its list before the dialog', async () => {
  await mount()
  const input = document.querySelector<HTMLInputElement>('[aria-label="Parent fiber"]')!
  await act(async () => input.focus())
  await key(input, 'ArrowDown')
  const highlighted = document.getElementById(input.getAttribute('aria-activedescendant')!)!
  expect(highlighted?.getAttribute('role')).toBe('option')
  expect(highlighted?.textContent).toContain('Parent task')
  expect(document.querySelector('[role="listbox"]')?.textContent).not.toContain('Elsewhere')
  await key(input, 'Enter')
  expect(input.value).toBe('parent')
  expect(document.activeElement).toBe(input)
  await key(input, 'ArrowDown')
  expect(input.getAttribute('aria-expanded')).toBe('true')
  await key(input, 'Escape')
  expect(input.getAttribute('aria-expanded')).toBe('false')
  expect(cancel).not.toHaveBeenCalled()
  expect(blockingDialogOpen()).toBe(true)
  await key(input, 'Escape')
  expect(cancel).toHaveBeenCalledOnce()
})
