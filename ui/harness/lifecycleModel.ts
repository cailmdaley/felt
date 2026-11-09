/**
 * The constitution lifecycle, written once: what the owning daemon does with
 * each lifecycle request, and what the board offers and means by each verb.
 *
 * Two layers, both pure:
 *
 *  - The request layer (`apply`) is the owner's contract. For every state and
 *    every request the board can send (`/transition`, `/lifecycle`, `/kill`,
 *    a force `/dispatch`, a `/felt-edit` that unsets the horizon) it says
 *    whether the owner accepts it, which Shuttle CLI write it runs, and the
 *    state that follows. `lifecycleTable()` enumerates it into
 *    `daemon/test/fixtures/lifecycle/model.json`, which the daemon (mix) and
 *    the Shuttle CLI (Go) hold their own halves to.
 *  - The gesture layer (`VERBS`) is the board's contract: for each state, the
 *    verbs the board offers, their words, and the state each verb must leave.
 *    `lifecycleModel.properties.test.ts` drives the real board against an owner
 *    that answers from the request layer and checks the board keeps it.
 *
 * Every served row is stamped by `ownerLifecycle`, the owner's column and turn,
 * itself held to `daemon/test/fixtures/columns/cases.json`.
 *
 * To add a verb: name it in `Verb`, give it a precondition, a word and an
 * effect in `VERBS`, and teach the driver in the property test how a human
 * performs it. To add a request: add it to `REQUESTS` and to `apply`, run
 * `npm run lifecycle:model`, and teach the daemon and Go links what it means.
 */
import { ownerColumn, ownerTurn } from './ownerLifecycle.js'

export type Kind = 'oneshot' | 'standing'
/** `status`, with a closed fiber's verdict folded in. */
export type Life = 'open' | 'active' | 'closed' | 'tempered' | 'discarded'
/** A seat of an office, and whether it carries a pulse (a schedule of its own). */
export type Seat = 'none' | 'seat' | 'pulsed'
/**
 * The owner's worker record. `gone` is a worker the owner still holds whose
 * terminal it can see no longer exists: every request against it must still
 * land. `unseen` is one the owner cannot observe at all (no receipt, and the
 * process scan failed): it refuses a second launch rather than risk two
 * workers. The board is served both as a running worker with no terminal and
 * cannot tell them apart; it learns which from the owner's answer.
 */
export type Worker = 'none' | 'live' | 'gone' | 'unseen'

export interface LifeState {
  kind: Kind
  life: Life
  /** `horizon: stashed`. */
  stashed: boolean
  seat: Seat
  /** An outstanding `shuttle ask`; it counts only while the fiber is active. */
  ask: boolean
  worker: Worker
}

const KINDS: readonly Kind[] = ['oneshot', 'standing']
const LIVES: readonly Life[] = ['open', 'active', 'closed', 'tempered', 'discarded']
const SEATS: readonly Seat[] = ['none', 'seat', 'pulsed']
const WORKERS: readonly Worker[] = ['none', 'live', 'gone', 'unseen']

/** Every state the model distinguishes. */
export const STATES: readonly LifeState[] = KINDS.flatMap(kind => LIVES.flatMap(life => [false, true].flatMap(stashed =>
  SEATS.flatMap(seat => [false, true].flatMap(ask => WORKERS.map(worker => ({ kind, life, stashed, seat, ask, worker })))))))

/** A short stable name: `oneshot/active/stashed/seat/ask/live`. */
export function stateKey(s: LifeState): string {
  return [s.kind, s.life, s.stashed ? 'stashed' : 'now', s.seat, s.ask ? 'ask' : 'quiet', s.worker].join('/')
}

export const ASK_TEXT = 'Which mock catalogue should the covariance use?'
export const PULSE = '4h'
/** Every modeled constitution has run before: this is its last session. */
export const SESSION = 'model-session'

/** The fiber document a state stands for, as the owner reads its frontmatter. */
export function lifeDoc(s: LifeState): Record<string, unknown> {
  const closed = s.life === 'closed' || s.life === 'tempered' || s.life === 'discarded'
  const shuttle: Record<string, unknown> = {
    kind: s.kind, host: 'model-host', agent: 'claude-opus', project_dir: '/work/model',
    ...(s.kind === 'standing' ? { schedule: { expr: '0 9 * * 1', tz: 'UTC' } } : {}),
    ...(s.seat !== 'none' ? { role: 'analyst', seat: true } : {}),
    ...(s.seat === 'pulsed' ? { pulse: PULSE } : {}),
    ...(s.ask ? { ask: { text: ASK_TEXT, at: '2026-11-09T09:00:00Z' } } : {}),
    runtime: { session_uuid: SESSION },
  }
  return {
    status: closed ? 'closed' : s.life,
    ...(s.life === 'tempered' ? { tempered: true } : s.life === 'discarded' ? { tempered: false } : {}),
    ...(s.stashed ? { horizon: 'stashed' } : {}),
    shuttle,
  }
}

/** The owner's worker record for a state, as `/fibers/composite` serves it. */
export function lifeRuntime(s: LifeState, nowMs: number): Record<string, unknown> | undefined {
  if (s.worker === 'none') return undefined
  const held = { state: 'running', tmux_session: 'model-worker', session_uuid: SESSION, started_at: nowMs - 3_600_000 }
  // A gone or unseen worker is the fir phantom: held, but with no terminal the owner can find.
  return s.worker === 'live' ? { ...held, phase: 'waiting', terminal: 'rex' } : { ...held, terminal: null }
}

/** The column and turn the owner serves for a state. */
export function served(s: LifeState, nowMs: number): { column: string; turn: string } {
  const doc = lifeDoc(s), runtime = lifeRuntime(s, nowMs)
  return { column: ownerColumn(doc, runtime !== undefined, nowMs), turn: ownerTurn(doc, runtime, undefined, nowMs) }
}

/** A `/fibers/composite` row for a fiber `id` in state `s`, as its owner serves it. */
export function ownerRow(id: string, s: LifeState, nowMs: number): Record<string, unknown> {
  const runtime = lifeRuntime(s, nowMs)
  return {
    origin: 'model-host', felt_store: '/work/model', path: `${id}/${id.split('/').at(-1)}.md`,
    fiber: { id, uid: `${id}-uid`, name: id, ...lifeDoc(s) },
    ...served(s, nowMs),
    ...(runtime ? { runtime } : {}),
  }
}

// ── The request layer: the owner's contract ─────────────────────────────────

export type TransitionTarget = 'drafts' | 'inFlight' | 'awaitingReview' | 'tempered' | 'composted'
export type LifeRequest =
  | { route: 'transition'; target: TransitionTarget }
  | { route: 'lifecycle'; action: 'rest' | 'resume' }
  | { route: 'kill' }
  | { route: 'dispatch'; said: boolean }
  | { route: 'attach'; past: boolean }
  | { route: 'unstash' }

/** Every request the board sends about a constitution's lifecycle. */
export const REQUESTS: readonly LifeRequest[] = [
  ...(['drafts', 'inFlight', 'awaitingReview', 'tempered', 'composted'] as const).map(target => ({ route: 'transition', target }) as const),
  { route: 'lifecycle', action: 'rest' },
  { route: 'lifecycle', action: 'resume' },
  { route: 'kill' },
  { route: 'dispatch', said: false },
  { route: 'dispatch', said: true },
  { route: 'attach', past: false },
  { route: 'attach', past: true },
  { route: 'unstash' },
]

export function requestKey(r: LifeRequest): string {
  switch (r.route) {
    case 'transition': return `transition:${r.target}`
    case 'lifecycle': return `lifecycle:${r.action}`
    case 'dispatch': return r.said ? 'dispatch:said' : 'dispatch'
    case 'attach': return r.past ? 'attach:past' : 'attach'
    default: return r.route
  }
}

/**
 * The owner's answer. `refused` is a 4xx or 5xx naming why; `conflict` is the
 * 409 a second launch of a held worker gets. `cli` is the Shuttle write the
 * owner runs (`--local` and `-C <store>` implied); on a refusal it is the
 * write that refuses. It is absent when the owner answers without a document
 * write. `delivered` marks an answer that put the human's message in front of
 * a worker: typed into a live one, or opening a launch.
 */
export type Outcome = 'ok' | 'refused' | 'conflict'
export interface Applied { outcome: Outcome; cli?: string[]; next: LifeState; delivered?: boolean }

const closedLife = (life: Life): boolean => life === 'closed' || life === 'tempered' || life === 'discarded'
const running = (s: LifeState): boolean => s.worker !== 'none'

/** Arming moves an open or closed fiber to active: its verdict and its rest go, and so does a question nobody answered.
 *  A reopen clears the question whichever way it reopens. */
function armed(s: LifeState): LifeState {
  return { ...s, life: 'active', stashed: false, ask: false }
}

export function apply(s: LifeState, r: LifeRequest): Applied {
  const same = (outcome: Outcome): Applied => ({ outcome, next: s })
  switch (r.route) {
    case 'kill':
      // Stopping is prompt and total: a held worker with no terminal is forgotten, not waited on.
      return { outcome: 'ok', next: { ...s, worker: 'none' } }
    case 'unstash':
      return { outcome: 'ok', next: { ...s, stashed: false } }
    case 'dispatch':
      // A message for a live worker is typed into its conversation, and answers its question.
      if (s.worker === 'live' && r.said) return { outcome: 'ok', next: { ...s, ask: false }, delivered: true }
      // A second launch of a worker the owner can reach, or cannot rule out, is refused.
      if (s.worker === 'live' || s.worker === 'unseen') return same('conflict')
      // A gone worker is reaped and replaced; the launch carries what was said.
      return { outcome: 'ok', next: { ...armed(s), worker: 'live' }, delivered: r.said }
    case 'attach':
      // A live terminal is revealed; any other opens the past session, if the request names it.
      return s.worker === 'live' || r.past ? same('ok') : same('refused')
    case 'lifecycle':
      if (r.action === 'rest') {
        // Rest reaches any state: open, put down, verdict cleared, worker stopped.
        return { outcome: 'ok', cli: ['rest'], next: { ...s, life: 'open', stashed: true, worker: 'none' } }
      }
      // The writer refuses to resume a closed fiber: reopen is how it comes back.
      if (closedLife(s.life)) return { outcome: 'refused', cli: ['resume'], next: s }
      return { outcome: 'ok', cli: ['resume'], next: armed(s) }
    case 'transition':
      return transition(s, r.target)
  }
}

/** `Shuttle.Actions`: a column target resolved against the fiber and whether the owner holds a worker. */
function transition(s: LifeState, target: TransitionTarget): Applied {
  const close = (tempered?: boolean): Applied => ({
    outcome: 'ok',
    cli: tempered === undefined ? ['close'] : ['close', `--tempered=${tempered}`],
    next: { ...s, life: tempered === undefined ? 'closed' : tempered ? 'tempered' : 'discarded' },
  })
  // A standing constitution has no review: its runs keep the schedule.
  // Tempered ends the run of an armed one: its ask clears, its run is
  // concluded, and it stays armed for the next tick.
  if (s.kind === 'standing' && target === 'tempered' && s.life === 'active') {
    return { outcome: 'ok', cli: ['close', '--tempered=true'], next: { ...s, ask: false } }
  }
  if (s.kind === 'standing' && (target === 'awaitingReview' || target === 'tempered')) return { outcome: 'refused', next: s }
  if (target === 'awaitingReview') return close()
  if (target === 'tempered') return close(true)
  if (target === 'composted') return close(false)
  if (running(s)) {
    // Drafts and In flight pause a worker's fiber; the board stops the worker itself.
    return { outcome: 'ok', cli: ['pause'], next: { ...s, life: 'open' } }
  }
  if (closedLife(s.life)) {
    return target === 'drafts'
      ? { outcome: 'ok', cli: ['reopen', '--as-draft'], next: { ...s, life: 'open', ask: false } }
      : { outcome: 'ok', cli: ['reopen'], next: armed(s) }
  }
  if (target === 'drafts') return { outcome: 'ok', cli: ['pause'], next: { ...s, life: 'open' } }
  if (s.life === 'open') return { outcome: 'ok', cli: ['reopen'], next: armed(s) }
  // In flight on an armed fiber with no worker launches it now.
  return { outcome: 'ok', next: { ...s, worker: 'live' } }
}

/** A state as the shared table holds it: the document, the owner's worker, the column served. */
export interface TableState { fiber: Record<string, unknown>; worker: Worker; column: string }
/** One request's answer in the shared table: `[outcome, next state, cli write?]`. */
export type TableAnswer = [Outcome, string] | [Outcome, string, string[]]
export interface LifecycleTable {
  states: Record<string, TableState>
  answers: Record<string, Record<string, TableAnswer>>
}

/** The whole request layer, as the daemon and the Go writer read it. */
export function lifecycleTable(nowMs: number): LifecycleTable {
  const states: Record<string, TableState> = {}
  const answers: Record<string, Record<string, TableAnswer>> = {}
  for (const s of STATES) {
    states[stateKey(s)] = { fiber: lifeDoc(s), worker: s.worker, column: served(s, nowMs).column }
    answers[stateKey(s)] = Object.fromEntries(REQUESTS.map(r => {
      const { outcome, cli, next } = apply(s, r)
      return [requestKey(r), cli ? [outcome, stateKey(next), cli] : [outcome, stateKey(next)]]
    }))
  }
  return { states, answers }
}

// ── The gesture layer: the board's contract ─────────────────────────────────

export type Verb = 'review' | 'temper' | 'discard' | 'rest'

export interface VerbSpec {
  /** Whether the board offers the verb on a card in this state. */
  offered(s: LifeState): boolean
  /** The word the board gives it on this card. */
  label(s: LifeState): string
  /** Whether a state after the gesture is the one the verb promised. */
  reached(before: LifeState, after: LifeState): boolean
  /** A verb that may leave the card looking as it did (re-dating a rest). */
  mayLookSame?(s: LifeState): boolean
}

const constitutionColumn = (s: LifeState, nowMs: number): string => served(s, nowMs).column
/** A schedule Rest pauses and resumes: a standing constitution's cron, or a seat's pulse. */
export const scheduled = (s: LifeState): boolean => s.kind === 'standing' || s.seat === 'pulsed'
const retired = (s: LifeState): boolean => s.kind === 'standing' && closedLife(s.life)

/** A oneshot that can still take a verdict: work on its way or put down, but not a seat at rest. */
function verdictable(s: LifeState, nowMs = Date.now()): boolean {
  const column = constitutionColumn(s, nowMs)
  if (s.kind === 'standing') return false
  if (column === 'drafts' || column === 'in_flight' || column === 'awaiting_review') return true
  return column === 'resting' && s.seat === 'none'
}

/** An armed standing run waiting on the human: its worker is held, or it asked. A seat at rest among the Roles has none. */
function runAwaitsHuman(s: LifeState, nowMs = Date.now()): boolean {
  return s.kind === 'standing' && s.life === 'active' && (s.worker !== 'none' || s.ask) && constitutionColumn(s, nowMs) !== 'roles'
}

export const VERBS: Record<Verb, VerbSpec> = {
  review: {
    offered: s => s.kind === 'oneshot' && ['drafts', 'in_flight'].includes(constitutionColumn(s, Date.now())),
    label: () => 'Close for review',
    reached: (_, after) => after.life === 'closed' && after.worker === 'none',
  },
  temper: {
    // On a standing constitution, Temper run: offered while an armed run waits
    // on the human (its worker is held, or it asked), it ends that run and
    // keeps the schedule.
    offered: s => verdictable(s) || runAwaitsHuman(s),
    label: s => s.kind === 'standing' ? 'Temper run' : 'Temper',
    reached: (before, after) => before.kind === 'standing'
      ? after.life === 'active' && !after.ask && after.worker === 'none'
      : after.life === 'tempered' && after.worker === 'none',
  },
  discard: {
    // A seat at rest takes no verdict: its office keeps it.
    offered: s => verdictable(s) || (s.kind === 'standing' && !retired(s) && constitutionColumn(s, Date.now()) !== 'roles'),
    label: s => s.kind === 'standing' ? 'Retire' : 'Discard',
    reached: (_, after) => after.life === 'discarded' && after.worker === 'none',
  },
  rest: {
    // A seat at rest is already at rest, unless it has a schedule to pause.
    offered: s => !retired(s) && (scheduled(s) || constitutionColumn(s, Date.now()) !== 'roles'),
    label: s => !scheduled(s) ? 'Rest' : s.life === 'open' ? 'Resume schedule' : 'Pause schedule',
    reached: (before, after) => scheduled(before) && before.life === 'open'
      ? after.life === 'active'
      : after.life === 'open' && after.worker === 'none' && (scheduled(before) || after.stashed),
    // Rest on a constitution already at rest only changes what it waits for.
    mayLookSame: s => !scheduled(s) && s.life === 'open' && s.stashed && s.worker === 'none',
  },
}

const VERB_ORDER: readonly Verb[] = ['review', 'rest', 'temper', 'discard']
/** The verbs the board offers a state, in the order it draws them: header
 *  order, except that a standing run waiting on the human leads with Temper run. */
export function offeredVerbs(s: LifeState): Verb[] {
  const verbs = VERB_ORDER.filter(verb => VERBS[verb].offered(s))
  return s.kind === 'standing' && verbs.includes('temper') ? ['temper', ...verbs.filter(verb => verb !== 'temper')] : verbs
}
