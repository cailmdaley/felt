// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STACK_DWELL_MS } from './KanbanRules.js'
import { KanbanSurfaceRenderer } from './KanbanSurfaces.js'
import { card, response } from './testFixtures.js'

const detail = vi.fn()
const transition = vi.fn()
const stack = vi.fn()
const stackQueueRow = vi.fn()
const stopAutoScroll = vi.fn()

function dragEvent(type: string, x: number, y: number): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y })
  Object.defineProperty(event, 'dataTransfer', {
    value: { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn(() => '') },
  })
  return event
}

describe('queue row drop on a card', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    document.body.replaceChildren()
    detail.mockReset()
    transition.mockReset()
    stack.mockReset()
    stackQueueRow.mockReset()
    stopAutoScroll.mockReset()
  })

  it.each(['working', 'waiting'])('opens the row on click and moves it to a card in the %s band after dwell', (phase) => {
    vi.useFakeTimers()
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      overflowX: 'visible', overflowY: 'visible',
    } as CSSStyleDeclaration)

    const head = card({ id: 'work/review-head', status: 'closed', closedAt: '2026-10-04T12:00:00Z' })
    const source = card({
      id: 'work/queued-source', status: 'open', dependsOn: [head.id],
      dependsOnShape: 'scalar', foldedUnder: head.id,
    })
    const child = card({
      id: 'work/queued-child', status: 'open', dependsOn: [source.id],
      dependsOnShape: 'scalar', foldedUnder: head.id,
    })
    const target = card({ id: 'work/in-flight-target', status: 'active', workerState: 'running', runtimePhase: phase })
    const data = response({
      now: { drafts: [], inFlight: [target], awaitingReview: [head] },
      folded: [source, child],
    })
    const renderer = new KanbanSurfaceRenderer({
      getDragSourceId: () => null,
      setDragSourceId: () => {},
      getLastResponse: () => data,
      stopDragAutoScroll: stopAutoScroll,
      transition,
      setSurface: () => {},
      pin: () => {},
      stack,
      stackQueueRow,
      reorderQueue: () => {},
      unqueueRow: () => {},
      openDetail: detail,
      onRefresh: () => {},
    })
    document.body.append(renderer.renderNowSection(data.now, {}))

    const headEl = document.querySelector<HTMLElement>(`[data-fiber-id="${head.id}"]`)!
    headEl.querySelector<HTMLElement>('.kbn-card-queued')!.click()
    const row = document.querySelector<HTMLElement>('.kbn-card-queued-row')!
    row.click()
    expect(detail).toHaveBeenCalledWith(source)
    expect(detail).not.toHaveBeenCalledWith(head)

    const targetEl = document.querySelector<HTMLElement>(`[data-fiber-id="${target.id}"]`)!
    expect(targetEl.closest<HTMLElement>('[data-flight-band]')?.dataset.flightBand)
      .toBe(phase === 'waiting' ? 'needsYou' : 'working')
    const rect = { x: 120, y: 120, left: 120, top: 120, right: 420, bottom: 320, width: 300, height: 200, toJSON: () => ({}) }
    vi.spyOn(targetEl, 'getBoundingClientRect').mockReturnValue(rect)
    for (let node = targetEl.parentElement; node; node = node.parentElement) {
      vi.spyOn(node, 'getBoundingClientRect').mockReturnValue({ ...rect, x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700, toJSON: () => ({}) })
    }

    row.dispatchEvent(dragEvent('dragstart', 0, 0))
    targetEl.dispatchEvent(dragEvent('dragover', 270, 220))
    vi.advanceTimersByTime(STACK_DWELL_MS)
    const over = dragEvent('dragover', 270, 220)
    targetEl.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)
    expect(targetEl.classList.contains('kbn-card-stack-target')).toBe(true)
    expect(targetEl.closest('.kbn-col')?.classList.contains('kbn-col-drop')).toBe(false)
    targetEl.dispatchEvent(dragEvent('drop', 270, 220))

    expect(stackQueueRow).toHaveBeenCalledWith(source.id, {
      writes: [
        { fiberId: child.id, newDep: head.id },
        { fiberId: source.id, newDep: target.id },
      ],
      protectedIds: [],
    })
    expect(transition).not.toHaveBeenCalled()
    expect(stack).not.toHaveBeenCalled()
    expect(stopAutoScroll).toHaveBeenCalled()
  })
})
