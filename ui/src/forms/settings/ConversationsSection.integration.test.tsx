// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConversationsSection } from './ConversationsSection'
import { CLAUDE_OPENING_KEY, CONVERSATION_OPENING_CHANGED } from '../../board/conversationOpening'

let root: Root
let values: Map<string, string>
beforeEach(() => {
  values = new Map()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  })
  vi.stubGlobal('fetch', vi.fn())
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(<ConversationsSection />))
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('saves a browser preference without writing host configuration and notifies the board', () => {
  const changed = vi.fn()
  window.addEventListener(CONVERSATION_OPENING_CHANGED, changed)
  const select = document.querySelector('select')!
  expect([...select.options].map(({ text }) => text)).toEqual(['Terminal (Kitty)', 'Claude browser', 'Claude app'])
  act(() => {
    select.value = 'app'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(values.get(CLAUDE_OPENING_KEY)).toBe('app')
  expect(changed).toHaveBeenCalledOnce()
  expect(fetch).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('Remote Control enabled')
  window.removeEventListener(CONVERSATION_OPENING_CHANGED, changed)
})

it('reports blocked site storage without pretending the choice was saved', () => {
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('disabled') })
  const select = document.querySelector('select')!
  act(() => {
    select.value = 'browser'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(select.value).toBe('terminal')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('cannot save preferences')
})
