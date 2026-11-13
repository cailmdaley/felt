/**
 * The owning daemon's lifecycle stamp (`Shuttle.Lifecycle`), for the mocked
 * daemons that stand in for it: the harness and the test fixtures. Every
 * constitution row the daemon serves carries its `column` and `turn`; a mock
 * serves them by the same rule. `src/board/columns.fixture.test.ts` holds this
 * double to the cases the daemon and the CLI are held to
 * (`daemon/test/fixtures/columns/cases.json`).
 *
 * Nothing in the board itself imports this: the board renders what its owner
 * serves.
 */
import { isoDayLocal } from '../src/board/civilDay.js'

type Row = Record<string, unknown>
const record = (value: unknown): Row | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Row : undefined
const STARTING_MS = 5 * 60_000

/** The owner's Desk column for a fiber, in the wire's names. */
export function ownerColumn(fiber: Row, live: boolean, nowMs = Date.now()): string {
  const shuttle = record(fiber.shuttle) ?? {}
  const status = fiber.status
  if (status === 'closed') {
    if (fiber.tempered === true) return 'tempered'
    if (fiber.tempered === false) return 'discarded'
    // An unmarked thread's review belongs to its orchestrator.
    return record(shuttle.thread_parent) && shuttle.review == null ? 'orchestrator_review' : 'awaiting_review'
  }
  if (live) return 'in_flight'
  const seat = shuttle.seat === true && typeof shuttle.role === 'string' && shuttle.role !== ''
  if (seat && (status !== 'active' || shuttle.kind === 'standing')) return 'roles'
  // A standing constitution rests between firings and while paused, except
  // an armed one whose run asked something: that is the human's move.
  if (shuttle.kind === 'standing') return status === 'active' && asking(fiber) ? 'in_flight' : 'resting'
  if (status === 'active') return 'in_flight'
  const due = typeof fiber.due === 'string' ? fiber.due.slice(0, 10) : ''
  if (fiber.horizon === 'stashed' && (!due || due > isoDayLocal(nowMs))) return 'resting'
  return 'drafts'
}

/** An outstanding `shuttle ask` on an active constitution. */
function asking(fiber: Row): boolean {
  const ask = record(record(fiber.shuttle)?.ask)
  return fiber.status === 'active' && typeof ask?.text === 'string' && ask.text.trim() !== ''
}

/** The owner's turn for a fiber, from its worker's runtime record and any launch error. */
export function ownerTurn(fiber: Row, runtime: Row | undefined, error: unknown, nowMs = Date.now()): string {
  const shuttle = record(fiber.shuttle) ?? {}
  const phase = runtime?.state === 'blocked' ? 'blocked' : runtime?.phase
  if (error || runtime?.launch_error || phase === 'blocked') return 'blocked'
  if (!runtime) return asking(fiber) ? 'question' : 'none'
  if (phase === 'identity_failed') return 'blocked'
  if (phase === 'attention') return 'question'
  if (asking(fiber)) return 'question'
  if (phase === 'waiting') return 'idle'
  if (phase === 'working') return 'working'
  if (phase === 'identity_pending') return 'starting'
  const dispatched = Date.parse(String(record(shuttle.runtime)?.dispatched_at ?? ''))
  const started = typeof runtime.started_at === 'number' ? runtime.started_at : dispatched
  return Number.isFinite(started) && nowMs - started < STARTING_MS ? 'starting' : 'no-signal'
}

/** A served row: a constitution's own `column` and `turn` unless the row already states them. */
export function stampLifecycle<T extends Row>(row: T, nowMs = Date.now()): T {
  const fiber = record(row.fiber)
  if (!fiber || !record(fiber.shuttle)) return row
  const runtime = record(row.runtime)
  return {
    column: ownerColumn(fiber, runtime !== undefined, nowMs),
    turn: ownerTurn(fiber, runtime, row.dispatch_error, nowMs),
    ...row,
  }
}
