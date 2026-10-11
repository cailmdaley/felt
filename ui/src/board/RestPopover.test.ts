// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { restPopover } from './RestPopover.js'
import { isoDayLocal } from './civilDay.js'
import { shiftCivilDay } from './civilDay.js'
import { card } from './testFixtures.js'

let close: (() => void) | undefined
afterEach(() => { close?.(); document.body.replaceChildren() })

const key = (k: string): void => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
}
const open = (): { submit: ReturnType<typeof vi.fn>; anchor: HTMLElement } => {
  const anchor = document.createElement('button')
  document.body.append(anchor)
  anchor.focus()
  const submit = vi.fn(async (_until: string) => {})
  close = restPopover(card({ id: 'f' }), anchor, submit)
  return { submit, anchor }
}
const today = (): string => isoDayLocal(Date.now())

describe('rest date dialog', () => {
  it('Enter rests until tomorrow by default and restores focus', () => {
    const { submit, anchor } = open()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    key('Enter')
    expect(submit).toHaveBeenCalledWith(shiftCivilDay(today(), 1))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(anchor)
  })
  it('moves by vim motions with a count prefix', () => {
    const { submit } = open()
    key('3'); key('j')
    key('l')
    key('Enter')
    expect(submit).toHaveBeenCalledWith(shiftCivilDay(today(), 1 + 21 + 1))
  })
  it('never moves before tomorrow', () => {
    const { submit } = open()
    key('h'); key('k'); key('H')
    key('Enter')
    expect(submit).toHaveBeenCalledWith(shiftCivilDay(today(), 1))
  })
  it('n rests without a return day', () => {
    const { submit } = open()
    key('n')
    expect(submit).toHaveBeenCalledWith('')
  })
  it('w jumps to next Monday', () => {
    const { submit } = open()
    key('w'); key('Enter')
    const until = submit.mock.calls[0]![0] as string
    expect(new Date(`${until}T00:00:00Z`).getUTCDay()).toBe(1)
    expect(until > today()).toBe(true)
  })
  it('Escape dismisses without resting', () => {
    const { submit } = open()
    key('Escape')
    expect(submit).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})
