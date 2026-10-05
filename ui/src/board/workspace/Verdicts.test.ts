// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import { Verdicts } from './Verdicts.js'

let verdicts: Verdicts
beforeEach(() => { vi.useFakeTimers(); verdicts = new Verdicts() })
afterEach(() => { verdicts.dispose(); document.body.replaceChildren(); vi.useRealTimers() })
const key = (key: string, init: KeyboardEventInit = {}, target: EventTarget = window): void => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
}

describe('late verdicts', () => {
  it('snapshots only paper and ink onto a protected body-level toast without changing write timing', () => {
    const commit = vi.fn(), material = { paper: 'rgb(10, 20, 30)', ink: 'rgb(240, 230, 220)' }
    verdicts.queue(card({ id: 'a' }), 'tempered', commit, material)
    const toast = document.querySelector<HTMLElement>('.ws-verdict-toast')!
    expect(toast.closest('.ws-reader')).toBeNull()
    expect(toast.dataset.part).toBe('act'); expect(toast.dataset.act).toBe('toast')
    expect(toast.hasAttribute('data-ws-act-material')).toBe(true)
    expect(toast.hasAttribute('data-ws-theme')).toBe(false)
    material.paper = 'red'; material.ink = 'blue'
    expect(toast.style.getPropertyValue('--ws-paper')).toBe('rgb(10, 20, 30)')
    expect(toast.style.getPropertyValue('--ws-ink')).toBe('rgb(240, 230, 220)')
    window.dispatchEvent(new PopStateEvent('popstate'))
    vi.advanceTimersByTime(5999); expect(commit).not.toHaveBeenCalled()
    verdicts.dispose()
    vi.advanceTimersByTime(1); expect(commit).not.toHaveBeenCalled()
  })
  it('keeps standalone toasts unmaterialed when no reader supplied a snapshot', () => {
    verdicts.queue(card({ id: 'a' }), 'tempered', vi.fn())
    const toast = document.querySelector<HTMLElement>('.ws-verdict-toast')!
    expect(toast.dataset.act).toBe('toast')
    expect(toast.hasAttribute('data-ws-act-material')).toBe(false)
    expect(toast.style.cssText).toBe('')
  })

  it('writes only after six seconds and keeps a polite, named Undo toast', () => {
    const commit = vi.fn()
    verdicts.queue(card({ id: 'music', name: 'Music' }), 'tempered', commit)
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe('Tempered Music · Undo z')
    vi.advanceTimersByTime(5999)
    expect(commit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.ws-verdict-toast')).toBeNull()
  })
  it('keeps different fibers independent and z undoes only the latest pending verdict', () => {
    const first = vi.fn(), second = vi.fn()
    verdicts.queue(card({ id: 'a', uid: 'a' }), 'tempered', first)
    vi.advanceTimersByTime(1000)
    verdicts.queue(card({ id: 'b', uid: 'b' }), 'composted', second)
    key('z')
    vi.advanceTimersByTime(6000)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  })
  it('Undo cancels its own fiber, not another toast', () => {
    const first = vi.fn(), second = vi.fn()
    verdicts.queue(card({ id: 'a', uid: 'a', name: 'First' }), 'tempered', first)
    verdicts.queue(card({ id: 'b', uid: 'b', name: 'Second' }), 'composted', second)
    document.querySelector<HTMLButtonElement>('[aria-label="Undo verdict on First"]')!.click()
    vi.advanceTimersByTime(6000)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
  it('typing, IME, command shortcuts and held z cannot cancel a verdict', () => {
    const commit = vi.fn()
    const input = document.createElement('textarea'); document.body.append(input)
    verdicts.queue(card({ id: 'a' }), 'tempered', commit)
    key('z', {}, input)
    for (const init of [{ isComposing: true }, { keyCode: 229 }, { metaKey: true }, { ctrlKey: true }, { repeat: true }]) key('z', init)
    vi.advanceTimersByTime(6000)
    expect(commit).toHaveBeenCalledTimes(1)
  })
  it('disposing loses uncommitted writes', () => {
    const commit = vi.fn()
    verdicts.queue(card({ id: 'a' }), 'tempered', commit)
    verdicts.dispose()
    vi.advanceTimersByTime(6000)
    expect(commit).not.toHaveBeenCalled()
  })
})
