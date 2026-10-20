// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KanbanModal, applyOptimisticSeat } from './KanbanModal.js'
import { KanbanSurfaceRenderer, seatDropRefusal } from './KanbanSurfaces.js'
import { rolePopover, validRole, type RoleChoice } from './RolePopover.js'
import { card, response } from './testFixtures.js'
import type { KanbanCard, KanbanResponse } from './KanbanTypes.js'

const draft = (over: Partial<KanbanCard> = {}) => card({ id: 'work/new-office', name: 'New office', shuttleKind: 'oneshot', ...over })
const roles = [{ slug: 'analyst', name: 'Analyst', outcome: 'Keeps the science right.' }, { slug: 'editor', name: 'Editor', outcome: 'Keeps writing clear.' }]
let close: (() => void) | undefined
afterEach(() => { close?.(); close = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })
function drop(type: string): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { getData: () => 'work/new-office', dropEffect: '' } })
  return event
}
function band(fiber: KanbanCard, makeSeat: (card: KanbanCard, anchor: HTMLElement) => void = vi.fn()): HTMLElement {
  const data = response({ now: { drafts: [fiber], inFlight: [], awaitingReview: [] }, cycles: fiber.isCycle ? [fiber] : [] })
  return new KanbanSurfaceRenderer({
    getDragSourceId: () => fiber.id, setDragSourceId: vi.fn(), getLastResponse: () => data,
    stopDragAutoScroll: vi.fn(), transition: vi.fn(), setSurface: vi.fn(), makeSeat, openDetail: vi.fn(), onRefresh: vi.fn(),
  }).renderRolesSection([], {})
}
interface SeatBoard {
  makeSeat(card: KanbanCard, anchor: HTMLElement): void
  commitSeat(card: KanbanCard, choice?: RoleChoice): Promise<void>
  closeRolePopover?: () => void
  lastResponse: KanbanResponse
  postJson: ReturnType<typeof vi.fn>
  setSurface: ReturnType<typeof vi.fn>
  applyResponse: ReturnType<typeof vi.fn>
  fetchAndRender: ReturnType<typeof vi.fn>
  showBanner: ReturnType<typeof vi.fn>
  announce: ReturnType<typeof vi.fn>
}
function board(fiber = draft()): SeatBoard {
  const modal = new KanbanModal({ shuttleBase: '' }) as unknown as SeatBoard
  modal.lastResponse = response({ now: { drafts: [fiber], inFlight: [], awaitingReview: [] } })
  modal.postJson = vi.fn().mockResolvedValue(undefined)
  modal.setSurface = vi.fn()
  modal.applyResponse = vi.fn()
  modal.fetchAndRender = vi.fn().mockResolvedValue(undefined)
  modal.showBanner = vi.fn()
  modal.announce = vi.fn()
  return modal
}

describe('dropping on the Roles band', () => {
  it('offers the ordinary band affordance and commits with its anchor', () => {
    const makeSeat = vi.fn()
    const fiber = draft({ shuttleRole: 'analyst' })
    const target = band(fiber, makeSeat)
    const over = drop('dragover')
    target.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)
    expect(target.classList.contains('kbn-section-drop')).toBe(true)
    target.dispatchEvent(drop('drop'))
    expect(makeSeat).toHaveBeenCalledExactlyOnceWith(fiber, target)
    expect(target.classList.contains('kbn-section-drop')).toBe(false)
    document.dispatchEvent(new Event('dragend'))
  })
  it.each([draft({ shuttleKind: undefined }), draft({ isCycle: true })])('refuses an ineligible card without writing', fiber => {
    const makeSeat = vi.fn()
    const target = band(fiber, makeSeat)
    const over = drop('dragover')
    target.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(false)
    expect(target.title).toBe(seatDropRefusal(fiber))
    expect(target.classList.contains('kbn-section-drop')).toBe(false)
    target.dispatchEvent(drop('drop'))
    expect(makeSeat).not.toHaveBeenCalled()
    document.dispatchEvent(new Event('dragend'))
    expect(target.title).toBe('')
  })
  it('marks a card with an office, then uses the Resting lifecycle path', async () => {
    const fiber = draft({ shuttleRole: 'analyst', status: 'active', workerState: 'running' })
    const modal = board(fiber)
    await modal.commitSeat(fiber)
    expect(modal.postJson).toHaveBeenCalledExactlyOnceWith('/api/v1/lifecycle', {
      action: 'seat', fiber: fiber.id, origin: fiber.originId,
    }, expect.any(String))
    expect(modal.setSurface).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ shuttleSeat: true, shuttleRole: 'analyst' }), 'stashed')
    expect(modal.postJson.mock.invocationCallOrder[0]).toBeLessThan(modal.setSurface.mock.invocationCallOrder[0])
  })
  it('does not rest an already-resting card or a standing constitution', async () => {
    for (const fiber of [draft({ effectiveHorizon: 'stashed' }), draft({ shuttleKind: 'standing', status: 'active' })]) {
      const modal = board(fiber)
      await modal.commitSeat(fiber, { role: 'analyst' })
      expect(modal.setSurface).not.toHaveBeenCalled()
      expect(modal.fetchAndRender).toHaveBeenCalledOnce()
    }
  })
  it('opens the picker for an unassigned drop and cancelling writes nothing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => roles }))
    const fiber = draft()
    const modal = board(fiber)
    band(fiber, (card, anchor) => modal.makeSeat(card, anchor)).dispatchEvent(drop('drop'))
    close = modal.closeRolePopover
    await vi.waitFor(() => expect(document.querySelector('.kbn-role-options')?.textContent).toContain('Analyst'))
    expect(modal.postJson).not.toHaveBeenCalled()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(modal.postJson).not.toHaveBeenCalled()
  })
  it('writes role, seat and rest in order and passes a new office name', async () => {
    const fiber = draft()
    const modal = board(fiber)
    await modal.commitSeat(fiber, { role: 'new-office', new_name: 'New office' })
    expect(modal.postJson.mock.calls.map(call => call[1].action)).toEqual(['role', 'seat'])
    expect(modal.postJson.mock.calls[0][1]).toMatchObject({ role: 'new-office', new_name: 'New office' })
    expect(modal.setSurface).toHaveBeenCalledOnce()
  })
  it('does not continue after a role write fails', async () => {
    const modal = board()
    modal.postJson.mockRejectedValueOnce(new Error('No charter'))
    await modal.commitSeat(draft(), { role: 'analyst' })
    expect(modal.postJson).toHaveBeenCalledOnce()
    expect(modal.setSurface).not.toHaveBeenCalled()
    expect(modal.fetchAndRender).toHaveBeenCalledOnce()
  })
})

describe('the office picker', () => {
  it('filters offices and selects using the keyboard', async () => {
    const submit = vi.fn().mockResolvedValue(undefined)
    close = rolePopover(draft(), document.body, async () => roles, submit)
    await vi.waitFor(() => expect(document.querySelectorAll('.kbn-role-options button')).toHaveLength(2))
    const filter = document.querySelector<HTMLInputElement>('input[type="search"]')!
    filter.value = 'science'
    filter.dispatchEvent(new Event('input'))
    expect(document.querySelectorAll('.kbn-role-options button')).toHaveLength(1)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(submit).toHaveBeenCalledExactlyOnceWith({ role: 'analyst' })
  })
  it('defaults a new office from the card and validates its slug', async () => {
    const submit = vi.fn().mockResolvedValue(undefined)
    close = rolePopover(draft(), document.body, async () => roles, submit)
    document.querySelector<HTMLButtonElement>('[aria-expanded]')!.click()
    const inputs = document.querySelectorAll<HTMLInputElement>('form input')
    expect([...inputs].map(input => input.value)).toEqual(['new-office', 'New office'])
    inputs[0].value = '../bad'
    const form = document.querySelector('form')!
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(submit).not.toHaveBeenCalled()
    inputs[0].value = 'new-office'
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(submit).toHaveBeenCalledExactlyOnceWith({ role: 'new-office', new_name: 'New office' })
  })
  it('click-away cancels without writing, even when the list loads late', async () => {
    const submit = vi.fn()
    let resolve!: (value: typeof roles) => void
    close = rolePopover(draft(), document.body, () => new Promise(done => { resolve = done }), submit)
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    resolve(roles)
    await Promise.resolve()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(submit).not.toHaveBeenCalled()
  })
  it.each(['editor', 'cmbx-chair', 'a0', '0'])('accepts the Go role grammar: %s', slug => expect(validRole(slug)).toBe(true))
  it.each(['../bad', 'Roles', '-a', 'a-', 'a--b', '', 'a_b', 'a/b'])('rejects %s', slug => expect(validRole(slug)).toBe(false))
})

describe('seat optimism', () => {
  it('moves a resting card into name-sorted Roles without mutating its source', () => {
    const fiber = draft({ effectiveHorizon: 'stashed' })
    const source = response({ stash: [fiber] })
    const updated = applyOptimisticSeat(source, { ...fiber, shuttleRole: 'analyst', shuttleSeat: true })!
    expect(source.stash).toEqual([fiber])
    expect(updated.stash).toEqual([])
    expect(updated.roles[0]).toMatchObject({ id: fiber.id, shuttleRole: 'analyst', shuttleSeat: true })
    expect(updated.totals.roles).toBe(1)
  })
  it('keeps a running standing seat in flight', () => {
    const fiber = draft({ status: 'active', shuttleKind: 'standing', workerState: 'running' })
    const source = response({ now: { drafts: [], inFlight: [fiber], awaitingReview: [] } })
    const updated = applyOptimisticSeat(source, { ...fiber, shuttleRole: 'analyst', shuttleSeat: true })!
    expect(updated.roles).toEqual([])
    expect(updated.now.inFlight[0].shuttleSeat).toBe(true)
  })
})
