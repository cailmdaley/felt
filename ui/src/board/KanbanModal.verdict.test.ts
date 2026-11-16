// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KanbanModal } from './KanbanModal.js'
import type { KanbanCard, KanbanResponse } from './KanbanTypes.js'
import { card, response } from './testFixtures.js'
import { Verdicts, type Verdict } from './workspace/Verdicts.js'

interface TransitionBoard {
  transition(card: KanbanCard, target: Verdict, committed?: boolean): void
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
    () => board.transition(queued, target, true))) }
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
    expect(document.querySelector('.ws-verdict-undo')).toBeNull()
    expect(board.showBanner).toHaveBeenCalledWith(expect.stringContaining('already in'), 'info')
  })
  it('queues a verdict on a card closed for review, and writes nothing yet', () => {
    const fiber = card({ id: 'work/review', status: 'closed', shuttleKind: 'oneshot' })
    const board = setup(fiber)
    board.lastResponse = response({ now: { drafts: [], inFlight: [], awaitingReview: [fiber] } })
    board.transition(fiber, 'tempered')
    expect(board.workspace.queueVerdict).toHaveBeenCalledExactlyOnceWith(fiber, 'tempered')
    expect(board.commitTransition).not.toHaveBeenCalled()
  })
  it('leaves the live-worker confirmation to queue time and does not ask again at delayed commit', () => {
    const fiber = card({ id: 'work/running', status: 'active', shuttleKind: 'oneshot', workerState: 'running' })
    const board = setup(fiber)
    board.lastResponse = response({ now: { drafts: [], inFlight: [fiber], awaitingReview: [] } })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    board.transition(fiber, 'composted')
    vi.advanceTimersByTime(6000)
    expect(confirm).not.toHaveBeenCalled()
    expect(board.commitTransition).toHaveBeenCalledOnce()
  })
  it('asks at the gesture and honors refusal without a workspace', () => {
    const fiber = card({ id: 'work/running', status: 'active', shuttleKind: 'oneshot', workerState: 'running' })
    const board = setup(fiber)
    ;(board as unknown as { workspace: null }).workspace = null
    board.lastResponse = response({ now: { drafts: [], inFlight: [fiber], awaitingReview: [] } })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    board.transition(fiber, 'composted')
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
    expect(board.commitTransition).toHaveBeenCalledExactlyOnceWith(fiber, 'tempered')
  })
})
