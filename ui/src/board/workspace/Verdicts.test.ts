// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanCard } from '../KanbanTypes.js'
import { card } from '../testFixtures.js'
import { markVerdictHost, Verdicts } from './Verdicts.js'

let verdicts: Verdicts
beforeEach(() => { vi.useFakeTimers(); verdicts = new Verdicts() })
afterEach(() => { verdicts.dispose(); document.body.replaceChildren(); vi.useRealTimers() })
const key = (key: string, init: KeyboardEventInit = {}, target: EventTarget = window): void => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
}
/** A verdict control pair, as the fiber page and the Desk mark theirs. */
const host = (fiber: KanbanCard): HTMLElement => {
  const el = document.createElement('div')
  const temper = document.createElement('button')
  temper.textContent = 'Temper'
  el.append(temper)
  markVerdictHost(el, fiber)
  document.body.append(el)
  return el
}
const flush = (): Promise<void> => Promise.resolve()

describe('late verdicts', () => {
  it('draws the undo line in place of the controls, and nowhere else', () => {
    const fiber = card({ id: 'a', name: 'Music' })
    const pair = host(fiber), other = host(card({ id: 'b' }))
    verdicts.queue(fiber, 'composted', vi.fn())
    const line = pair.querySelector<HTMLElement>(':scope > .ws-verdict-undo')!
    expect(pair.dataset.verdictPending).toBe('discarded')
    expect(line.textContent).toBe('Discarded·undo z')
    const word = line.querySelector<HTMLElement>('.ws-verdict-word')!
    expect([word.dataset.verdict, word.textContent]).toEqual(['discarded', 'Discarded'])
    expect(other.querySelector('.ws-verdict-undo')).toBeNull()
    expect(document.querySelectorAll('.ws-verdict-undo')).toHaveLength(1)
  })

  it('writes only after four seconds, with the line still up, and keeps a polite, named announcement', () => {
    const fiber = card({ id: 'music', name: 'Music' }), pair = host(fiber)
    const commit = vi.fn(() => expect(pair.querySelector('.ws-verdict-undo')).not.toBeNull())
    verdicts.queue(fiber, 'tempered', commit)
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe('Tempered Music · undo z')
    vi.advanceTimersByTime(3999)
    expect(commit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(pair.querySelector('.ws-verdict-undo')).toBeNull()
    expect(pair.hasAttribute('data-verdict-pending')).toBe(false)
  })

  it('repaints a host its surface rebuilds during the window, partway through its fade', async () => {
    const fiber = card({ id: 'a' })
    verdicts.queue(fiber, 'tempered', vi.fn())
    vi.advanceTimersByTime(3000)
    const rebuilt = host(fiber)
    await flush()
    const line = rebuilt.querySelector<HTMLElement>('.ws-verdict-undo')!
    expect(line.style.getPropertyValue('--ws-verdict-left')).toBe('1000ms')
    expect(line.hasAttribute('data-fresh')).toBe(false)
  })

  it('moves focus from the control that gave the verdict to its undo, and back', () => {
    const fiber = card({ id: 'a' }), pair = host(fiber)
    pair.querySelector('button')!.focus()
    verdicts.queue(fiber, 'tempered', vi.fn())
    expect(document.activeElement?.closest('.ws-verdict-undo')).not.toBeNull()
    key('z')
    expect(document.activeElement?.textContent).toBe('Temper')
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
  it('undo cancels its own fiber, not another line', () => {
    const first = vi.fn(), second = vi.fn()
    const a = card({ id: 'a', uid: 'a', name: 'First' }), b = card({ id: 'b', uid: 'b', name: 'Second' })
    host(a); host(b)
    verdicts.queue(a, 'tempered', first)
    verdicts.queue(b, 'composted', second)
    document.querySelector<HTMLButtonElement>('[aria-label="Undo verdict on First"]')!.click()
    expect(document.querySelectorAll('.ws-verdict-undo')).toHaveLength(1)
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
  it('disposing loses uncommitted writes and clears every line; navigation does not', () => {
    const commit = vi.fn(), fiber = card({ id: 'a' }), pair = host(fiber)
    verdicts.queue(fiber, 'tempered', commit)
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(pair.querySelector('.ws-verdict-undo')).not.toBeNull()
    verdicts.dispose()
    vi.advanceTimersByTime(6000)
    expect(commit).not.toHaveBeenCalled()
    expect(pair.querySelector('.ws-verdict-undo')).toBeNull()
  })
})
