// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { restPopover } from './RestPopover.js'
import { isoDayLocal } from '../sdk/civilDay.js'
import { shiftCivilDay } from '../sdk/civilDay.js'
import { card, settle } from './testFixtures.js'

let close: (() => void) | undefined
afterEach(async () => { close?.(); await settle(); document.body.replaceChildren() })

const key = (k: string): void => {
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
}
const open = async (): Promise<{ submit: ReturnType<typeof vi.fn>; anchor: HTMLElement }> => {
  const anchor = document.createElement('button')
  document.body.append(anchor)
  anchor.focus()
  const submit = vi.fn(async (_until: string) => {})
  close = restPopover(card({ id: 'f' }), submit)
  await settle()
  return { submit, anchor }
}
const headline = (): string => document.querySelector('.kbn-rest-headline')!.textContent!
const today = (): string => isoDayLocal(Date.now())

describe('rest date dialog', () => {
  it('makes the background inert and releases it on close', async () => {
    const { anchor } = await open()
    await vi.waitFor(() => expect(anchor.inert).toBe(true))
    key('Escape'); await settle()
    expect(anchor.inert).toBe(false)
    expect(document.activeElement).toBe(anchor)
  })
  it('opens on no date: Enter rests undated and restores focus', async () => {
    const { submit, anchor } = await open()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(headline()).toBe('No date press Enter to rest, or pick a day')
    expect(document.querySelector('[role="gridcell"][aria-selected="true"]')).toBeNull()
    key('Enter')
    expect(submit).toHaveBeenCalledWith('')
    await settle()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(anchor)
  })
  it('the Rest button rests undated until a day is chosen', async () => {
    const { submit } = await open()
    document.querySelector<HTMLButtonElement>('.kbn-rest-confirm')!.click()
    expect(submit).toHaveBeenCalledWith('')
  })
  it('t chooses tomorrow', async () => {
    const { submit } = await open()
    key('t')
    expect(headline()).toContain('tomorrow')
    key('Enter')
    expect(submit).toHaveBeenCalledWith(shiftCivilDay(today(), 1))
  })
  it('a click on a day chooses it', async () => {
    const { submit } = await open()
    const cell = document.querySelector<HTMLButtonElement>('.kbn-rest-day:not([disabled])')!
    const label = cell.getAttribute('aria-label')!
    cell.click()
    expect(headline()).toContain(label)
    document.querySelector<HTMLButtonElement>('.kbn-rest-confirm')!.click()
    expect(submit).toHaveBeenCalledWith(shiftCivilDay(today(), 1))
  })
  it('moves by vim motions with a count prefix', async () => {
    const { submit } = await open()
    key('3'); key('j')
    key('l')
    key('Enter')
    expect(submit).toHaveBeenCalledWith(shiftCivilDay(today(), 1 + 21 + 1))
  })
  it('never moves before tomorrow', async () => {
    const { submit } = await open()
    key('h'); key('k'); key('H')
    key('Enter')
    expect(submit).toHaveBeenCalledWith(shiftCivilDay(today(), 1))
  })
  it('n rests without a return day', async () => {
    const { submit } = await open()
    key('n')
    expect(submit).toHaveBeenCalledWith('')
  })
  it('w jumps to next Monday', async () => {
    const { submit } = await open()
    key('w'); key('Enter')
    const until = submit.mock.calls[0]![0] as string
    expect(new Date(`${until}T00:00:00Z`).getUTCDay()).toBe(1)
    expect(until > today()).toBe(true)
  })
  it('Escape dismisses without resting', async () => {
    const { submit } = await open()
    key('Escape')
    await settle()
    expect(submit).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})
