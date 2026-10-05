// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KanbanModal } from './KanbanModal.js'
import type { ColumnKind, KanbanCard, KanbanResponse } from './KanbanTypes.js'
import { card, response } from './testFixtures.js'
import { Verdicts, type Verdict } from './workspace/Verdicts.js'

interface TransitionBoard {
  transition(card: KanbanCard, target: ColumnKind, opts?: { basis?: KanbanResponse; skipOptimistic?: boolean; verdictCommitted?: boolean }): void
  lastResponse: KanbanResponse
  workspace: { queueVerdict(card: KanbanCard, verdict: Verdict): void }
  commitTransition: ReturnType<typeof vi.fn>
  showBanner: ReturnType<typeof vi.fn>
  announce: ReturnType<typeof vi.fn>
}
let verdicts: Verdicts | undefined
const past = (fiber: KanbanCard): KanbanResponse => response({ timeline: { past: [fiber], futureDated: [] } })
function setup(fiber: KanbanCard): TransitionBoard {
  vi.useFakeTimers()
  const board = new KanbanModal({ shuttleBase: '' }) as unknown as TransitionBoard
  board.lastResponse = past(fiber)
  board.commitTransition = vi.fn()
  board.showBanner = vi.fn()
  board.announce = vi.fn()
  verdicts = new Verdicts()
  board.workspace = { queueVerdict: vi.fn((queued, target) => verdicts!.queue(queued, target,
    () => board.transition(queued, target, { verdictCommitted: true, skipOptimistic: true }))) }
  return board
}
afterEach(() => { verdicts?.dispose(); verdicts = undefined; vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren() })

describe('verdict transition authorization', () => {
  it.each(['tempered', 'composted'] as const)('does not queue a same-column %s verdict that could write after reopening', target => {
    const fiber = card({ id: 'work/review', status: 'closed', tempered: target === 'tempered' })
    const board = setup(fiber)
    board.transition(fiber, target)
    // Another actor reopens the card during the undo window.
    board.lastResponse = response({ now: { drafts: [{ ...fiber, status: 'open', tempered: undefined }], inFlight: [], awaitingReview: [] } })
    vi.advanceTimersByTime(6000)
    expect(board.commitTransition).not.toHaveBeenCalled()
    expect(board.workspace.queueVerdict).not.toHaveBeenCalled()
    expect(document.querySelector('.ws-verdict-toast')).toBeNull()
    expect(board.showBanner).toHaveBeenCalledWith(expect.stringContaining('already in'), 'info')
  })
  it('checks an explicit gesture basis before queuing, not its optimistic destination', () => {
    const fiber = card({ id: 'work/review', status: 'closed', tempered: true })
    const board = setup(fiber)
    board.lastResponse = response()
    board.transition(fiber, 'tempered', { basis: past(fiber) })
    expect(board.workspace.queueVerdict).not.toHaveBeenCalled()
    expect(board.showBanner).toHaveBeenCalledOnce()
  })
  it('queues a normal verdict using the explicit pre-paint basis', () => {
    const fiber = card({ id: 'work/review', status: 'closed', shuttleKind: 'oneshot' })
    const board = setup({ ...fiber, tempered: true })
    const basis = response({ now: { drafts: [], inFlight: [], awaitingReview: [fiber] } })
    board.transition(fiber, 'tempered', { basis })
    expect(board.workspace.queueVerdict).toHaveBeenCalledExactlyOnceWith(fiber, 'tempered')
    expect(board.commitTransition).not.toHaveBeenCalled()
  })
  it('keeps the live-worker confirmation at delayed commit and honors refusal', () => {
    const fiber = card({ id: 'work/running', status: 'active', shuttleKind: 'oneshot', workerState: 'running' })
    const board = setup(fiber)
    board.lastResponse = response({ now: { drafts: [], inFlight: [fiber], awaitingReview: [] } })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    board.transition(fiber, 'composted')
    expect(confirm).not.toHaveBeenCalled()
    vi.advanceTimersByTime(6000)
    expect(confirm).toHaveBeenCalledOnce()
    expect(board.commitTransition).not.toHaveBeenCalled()
  })
  it('commits a normal expired verdict without queuing it again', () => {
    const fiber = card({ id: 'work/review', status: 'closed', shuttleKind: 'oneshot' })
    const board = setup(fiber)
    board.lastResponse = response({ now: { drafts: [], inFlight: [], awaitingReview: [fiber] } })
    board.transition(fiber, 'tempered')
    vi.advanceTimersByTime(6000)
    expect(board.workspace.queueVerdict).toHaveBeenCalledOnce()
    expect(board.commitTransition).toHaveBeenCalledExactlyOnceWith(fiber, 'tempered', false, false)
  })
})
