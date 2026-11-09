// @vitest-environment jsdom
/**
 * The board's gestures, run against an owner that answers from the lifecycle
 * model (`harness/lifecycleModel.ts`). Random sequences of the verbs the board
 * offers go through the real Desk (selection, keys, the row menu, the verdict
 * window, the rest popover, the refetch) and, after each, the property checks
 * the seams between board and owner:
 *
 *  - every request the board sent was one the owner accepts;
 *  - the owner's state is the one the verb promised (`VERBS[verb].reached`);
 *  - the verb visibly changed the card (its column, its words, its verbs);
 *  - the board draws the card in the column the owner now serves.
 *
 * Two gestures act on the worker rather than the lifecycle, and their checks
 * are about what the board claims:
 *
 *  - `send` types a message into the band's worker line and presses Enter.
 *    The board says "Sent" exactly when the owner delivered it; otherwise the
 *    message stays in the line and the band says why. Only a worker the owner
 *    cannot observe may refuse it.
 *  - `open` presses `c`. One request reaches the owner, and it accepts it: a
 *    held worker whose terminal is gone opens its past session.
 *
 * A second property serves a family: a root and two threads in random
 * states. It enters the family's page by any of them, walks the highlight to
 * a random row with `j`, and performs a gesture on it by its key. Every
 * request must name the highlighted fiber, and no other fiber may change.
 *
 * `LIFECYCLE_FUZZ_RUNS` deepens it; a failure prints the fast-check seed and
 * the shrunk sequence that reproduces it.
 */
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, ownerRow, served, STATES, stateKey, VERBS, type LifeRequest, type LifeState, type Outcome, type Verb } from '../../harness/lifecycleModel.js'
import { workerOpener } from './sessionHistory.js'
import { isAgentCard } from './KanbanModalShared.js'
import { onDesk } from './workspace/fiberPageState.js'
import { KanbanModal } from './KanbanModal.js'
import type { KanbanCard, KanbanResponse } from './KanbanTypes.js'
import { MOBILE_MEDIA } from './mobile.js'
import { modelCard, settle } from './testFixtures.js'
import { lifecycleVerbsFor, verbSpec } from './workspace/lifecycleVerbs.js'
import { fiberPageKicker } from './workspace/fiberPageState.js'
import { VERB_KEY } from './workspace/lifecycleVerbs.js'

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const RUNS = Number(env.LIFECYCLE_FUZZ_RUNS ?? 25)
const SEED = env.LIFECYCLE_FUZZ_SEED === undefined ? 20261109 : Number(env.LIFECYCLE_FUZZ_SEED)
const ID = 'model/fiber'

interface Sent { route: string; body: Record<string, unknown>; fiber?: string; outcome: Outcome | 'unmodeled'; delivered?: boolean }
type Gesture = Verb | 'send' | 'open'
const MESSAGE = 'Use the 400-mock catalogue.'

/** A held worker's terminal and its past session, named for its fiber so a request says whose it is. */
const workerName = (id: string): string => `${id.replaceAll('/', '-')}-worker`
const sessionName = (id: string): string => `${id.replaceAll('/', '-')}-session`

/** The owning daemon of one constitution family, answering every lifecycle request from the model. */
class ModelOwner {
  states: Map<string, LifeState>
  sent: Sent[] = []
  private readonly parents: Record<string, string>
  /** `states` by fiber id; `parents` names each thread's orchestrator. */
  constructor(states: Record<string, LifeState>, parents: Record<string, string> = {}) {
    this.states = new Map(Object.entries(states))
    this.parents = parents
  }
  /** The single fiber's state, for a family of one. */
  get state(): LifeState { return this.states.get(ID)! }

  /** The fiber a request names: by id, or by its worker's terminal and past session, which must agree. */
  private fiberOf(body: Record<string, unknown>): string | undefined {
    const named = body.fiber_id ?? body.fiber
    if (typeof named === 'string') return named
    const ids = new Set([...this.states.keys()].filter(id => body.tmux_session === workerName(id) || body.session === sessionName(id)))
    const [id] = ids
    return ids.size === 1 && (body.tmux_session === undefined || body.tmux_session === workerName(id)) && (body.session === undefined || body.session === sessionName(id)) ? id : undefined
  }

  private answer(route: string, body: Record<string, unknown>, request: LifeRequest | null): Response {
    const fiber = this.fiberOf(body)
    const state = fiber === undefined ? undefined : this.states.get(fiber)
    if (!request || !fiber || !state) {
      this.sent.push({ route, body, fiber, outcome: 'unmodeled' })
      return Response.json({})
    }
    const { outcome, next, delivered } = apply(state, request)
    this.sent.push({ route, body, fiber, outcome, delivered })
    this.states.set(fiber, next)
    // A launch and a 409 both name the worker, and its terminal when the owner can find one.
    const worker = (w: LifeState['worker']) => ({ tmux_session: workerName(fiber), terminal: w === 'live' ? 'rex' : null })
    if (outcome === 'ok') return Response.json(route === 'dispatch' ? { dispatched: true, ...worker(next.worker) } : { ok: true })
    if (outcome === 'conflict') return Response.json({ dispatched: false, reason: 'already_running', ...worker(state.worker) }, { status: 409 })
    return Response.json({ error: 'refused' }, { status: route === 'attach' ? 502 : 422 })
  }

  /** `/fibers/composite`: each fiber as the model serves it, its worker and session named for it. */
  private rows(): Record<string, unknown>[] {
    return [...this.states].map(([id, s]) => {
      const row = ownerRow(id, s, Date.now()) as { fiber: { shuttle: { runtime: object } }; runtime?: object }
      row.fiber.shuttle.runtime = { ...row.fiber.shuttle.runtime, session_uuid: sessionName(id) }
      if (row.runtime) row.runtime = { ...row.runtime, tmux_session: workerName(id), session_uuid: sessionName(id) }
      // A thread names its orchestrator by uid, as the owner serves it.
      return { ...row, ...(this.parents[id] ? { orchestrator: `${this.parents[id]}-uid` } : {}) }
    })
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), 'http://owner.test')
    const route = url.pathname.replace(/^\/api\/v1\//, '')
    if (init?.method !== 'POST') {
      if (route === 'fibers/composite') return Response.json({ host: 'model-host', fibers: this.rows() })
      // A page's body read, by id or uid: the fiber's row, with its body.
      if (route.startsWith('fibers/') && url.searchParams.get('body') === 'true') {
        const id = route.slice('fibers/'.length).split('/').map(decodeURIComponent).join('/')
        const row = this.rows().find(r => { const f = r.fiber as { id: string; uid: string }; return f.id === id || f.uid === id })
        return row ? Response.json({ host: 'model-host', fibers: [{ ...row, fiber: { ...(row.fiber as object), body: '' } }] }) : Response.json({ fibers: [] }, { status: 404 })
      }
      return Response.json({ fibers: [], files: [], entries: [] })
    }
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
    switch (route) {
      case 'transition': return this.answer(route, body, { route: 'transition', target: body.target as never })
      case 'lifecycle':
        return this.answer(route, body, body.action === 'rest' || body.action === 'resume' ? { route: 'lifecycle', action: body.action } : null)
      case 'kill': return this.answer(route, body, { route: 'kill' })
      case 'dispatch': return this.answer(route, body, { route: 'dispatch', said: typeof body.user_message === 'string' && body.user_message !== '' })
      case 'attach': return this.answer(route, body, { route: 'attach', past: typeof body.session === 'string' })
      case 'felt-edit':
        return this.answer(route, body, Array.isArray(body.unset) && body.unset.includes('horizon') ? { route: 'unstash' } : null)
      default: return this.answer(route, body, null)
    }
  }
}

interface BoardInternals {
  lastResponse: KanbanResponse | null
  startPolling(): void
  fetchAndRender(): Promise<void>
  deskKeyboard: { select(address: { uid: string; origin: string }, scroll?: boolean): void }
  workspaceCards(): KanbanCard[]
  dock: { canOpenConversation(card: KanbanCard): boolean }
}

/** What a human sees of a card: its place, its status line, and the verbs it offers in their words. */
function drawn(s: LifeState): string {
  const card = modelCard(s)
  return [served(s, Date.now()).column, fiberPageKicker(card), ...lifecycleVerbsFor(card, true).map(verb => verbSpec(verb, card).label)].join(' | ')
}

function boardCard(data: KanbanResponse | null): KanbanCard | undefined {
  if (!data) return undefined
  const all = [...data.now.drafts, ...data.now.inFlight, ...data.now.awaitingReview, ...data.stash, ...data.roles, ...data.timeline.past, ...data.timeline.futureDated]
  return all.find(card => card.id === ID)
}

let board: KanbanModal
let inside: BoardInternals
let owner: ModelOwner

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  const stored = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key), clear: () => stored.clear() })
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === MOBILE_MEDIA ? false : false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('confirm', () => true)
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  window.history.replaceState(null, '', '/')
  // Every Desk section open, so every row a key could reach is drawn.
  stored.set('shuttle.desk.sections', JSON.stringify({ drafts: true, resting: true, roles: true }))
})
afterEach(() => { board?.unmount(); document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function mount(states: Record<string, LifeState>, parents: Record<string, string> = {}): Promise<void> {
  owner = new ModelOwner(states, parents)
  vi.stubGlobal('fetch', vi.fn(owner.fetch))
  board = new KanbanModal({ shuttleBase: '', onOpenWorker: workerOpener('', vi.fn()) })
  inside = board as unknown as BoardInternals
  vi.spyOn(inside, 'startPolling').mockImplementation(() => {})
  board.mount(document.body)
  await inside.fetchAndRender()
  await settle()
}

function press(key: string, target: EventTarget = document): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

/** The card on the Desk, selected, so the band acts on it; undefined once it has left the Desk. */
function selected(id = ID): KanbanCard | undefined {
  const card = inside.workspaceCards().find(c => c.id === id)
  if (card) inside.deskKeyboard.select({ uid: card.uid ?? card.id, origin: card.originId }, false)
  return card
}

const workerLine = (): HTMLTextAreaElement | null => document.querySelector<HTMLTextAreaElement>('.ws-worker-acts:not([hidden]) .ws-worker-message')
const receipt = (): string => document.querySelector('.ws-worker-receipt')?.textContent ?? ''
const bandError = (): string => [...document.querySelectorAll<HTMLElement>('.kbn-detail-error, .shuttle-toast.error')].filter(el => el.style.display !== 'none').map(el => el.textContent ?? '').join(' ')

/** The gestures the board offers on the selected card: its lifecycle verbs, a worker line to send from, a conversation to open. */
function gestures(s: LifeState): Gesture[] {
  const card = selected()
  if (!card) return []
  return [
    ...(Object.keys(VERBS) as Verb[]).filter(verb => VERBS[verb].offered(s)),
    // The constitution's page carries a worker line exactly for an agent's card on the Desk's lifecycle.
    ...(isAgentCard(card) && onDesk(card) ? ['send' as const] : []),
    ...(inside.dock.canOpenConversation(card) ? ['open' as const] : []),
  ]
}

/** Let the board finish what a gesture started: popovers, undo windows, the refetch. */
async function finish(): Promise<void> {
  await vi.advanceTimersByTimeAsync(10_000)
  for (let i = 0; i < 4; i++) await settle()
  await inside.fetchAndRender()
  await settle()
}

/** A human types the message into the band's worker line and presses Enter; returns what the band said. */
async function send(): Promise<{ receipt: string; left: string; error: string } | undefined> {
  selected()
  press('o')
  await settle()
  const line = workerLine()
  if (!line) return undefined
  line.value = MESSAGE
  line.dispatchEvent(new Event('input'))
  line.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  for (let i = 0; i < 4; i++) await settle()
  const said = { receipt: receipt(), left: line.value, error: bandError() }
  press('Escape')
  await finish()
  return said
}

/** A human performs `verb` on the card from the Desk, by its key, and lets the board finish. */
async function perform(verb: Verb): Promise<boolean> {
  if (!selected()) return false
  press(VERB_KEY[verb])
  await settle()
  // The rest popover asks until when: undated.
  const popover = document.querySelector<HTMLElement>('.kbn-rest-popover')
  if (popover) { press('n', popover); await settle() }
  // The verdict waits out its undo window, then commits.
  await finish()
  return true
}

describe('the board keeps the lifecycle model across random gesture sequences', () => {
  it('every offered verb is accepted, reaches its promise, shows, and is drawn where the owner serves it', async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom(...STATES),
      fc.array(fc.nat(), { minLength: 1, maxLength: 3 }),
      async (start, picks) => {
        await mount({ [ID]: start })
        try {
          for (const pick of picks) {
            const before = owner.state
            const offered = gestures(before)
            if (offered.length === 0) return
            const verb = offered[pick % offered.length]
            const sentBefore = owner.sent.length
            const story = (): string => `${verb} on ${stateKey(before)} → ${stateKey(owner.state)}\n  sent: ${JSON.stringify(owner.sent.slice(sentBefore))}`
            if (verb === 'send') {
              const said = await send()
              expect(said, `the page drew no worker line to send from: ${story()}`).toBeDefined()
              if (!said) return
              const dispatched = owner.sent.slice(sentBefore).filter(s => s.route === 'dispatch')
              expect(dispatched.map(s => s.body.user_message), `the message did not go to the owner once: ${story()}`).toEqual([MESSAGE])
              const delivered = dispatched[0].delivered === true
              if (delivered) {
                expect(said, `the owner took the message but the band did not say so: ${story()}`).toMatchObject({ receipt: 'Sent', left: '' })
              } else {
                expect(said.receipt, `the band said a message was sent that the owner never delivered: ${story()}`).not.toBe('Sent')
                expect(said.left, `an undelivered message left the line: ${story()}`).toBe(MESSAGE)
                expect(said.error, `the band did not say why the message did not arrive: ${story()}`).not.toBe('')
                expect(before.worker, `the owner refused a message to a worker it can observe: ${story()}`).toBe('unseen')
              }
              continue
            }
            if (verb === 'open') {
              selected()
              press('c')
              await finish()
              const attached = owner.sent.slice(sentBefore).filter(s => s.route === 'attach')
              expect(attached, `c reached the owner other than once: ${story()}`).toHaveLength(1)
              expect(attached[0].outcome, `the owner could not open the conversation c asked for: ${story()}`).toBe('ok')
              continue
            }
            const reached = await perform(verb)
            // A verdict archives the card off the Desk; its remaining verbs live on other surfaces.
            if (!reached) return
            const after = owner.state
            const refused = owner.sent.slice(sentBefore).filter(s => s.outcome !== 'ok')
            expect(refused, `the owner refused a request, or got one the model does not know: ${story()}`).toEqual([])
            expect(VERBS[verb].reached(before, after), `${verb} did not do what it promised: ${story()}`).toBe(true)
            if (!VERBS[verb].mayLookSame?.(before)) {
              expect(drawn(after), `${verb} changed nothing the human can see: ${story()}\n  drawn: ${drawn(before)}`).not.toBe(drawn(before))
            }
            expect(boardCard(inside.lastResponse)?.column, `the board draws the card where the owner does not: ${story()}`)
              .toBe(modelCard(after).column)
          }
        } finally {
          board.unmount(); document.body.replaceChildren()
        }
      },
    ), { seed: SEED, numRuns: RUNS, endOnFailure: true })
  }, 120_000)
})

const THREADS = [`${ID}/a`, `${ID}/b`]

/** The family page's rows, head first, by the fiber each names. */
function familyRows(): Array<{ el: HTMLElement; id: string }> {
  return [...document.querySelectorAll<HTMLElement>('.ws-selected .fp-row')]
    .map(el => ({ el, id: el.querySelector<HTMLElement>('.fp-name')?.title ?? '' }))
    .filter(row => row.id === ID || THREADS.includes(row.id))
}

describe('the band acts on the highlighted thread of a family', () => {
  it('every request a gesture sends names the highlighted fiber, and leaves the others alone', async () => {
    await fc.assert(fc.asyncProperty(
      fc.tuple(fc.constantFrom(...STATES), fc.constantFrom(...STATES), fc.constantFrom(...STATES)),
      fc.nat(),
      fc.array(fc.tuple(fc.nat(), fc.nat()), { minLength: 1, maxLength: 3 }),
      async ([root, a, b], entry, steps) => {
        await mount({ [ID]: root, [THREADS[0]]: a, [THREADS[1]]: b }, Object.fromEntries(THREADS.map(id => [id, ID])))
        try {
          // The page is entered by any of its fibers the Desk lists.
          const family = [ID, ...THREADS]
          if (!selected(family[entry % family.length]) && !selected()) return
          press('o')
          await settle()
          for (const [row, pick] of steps) {
            const rows = familyRows()
            if (rows.length === 0) return
            // The highlight moves from the head by j, as a human walks the page.
            rows[0].el.focus()
            for (let i = 0; i < row % rows.length; i++) document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }))
            await settle()
            const lit = familyRows().find(r => r.el.getAttribute('aria-selected') === 'true')
            expect(lit, 'the page highlights no row').toBeDefined()
            const target = lit!.id
            const state = owner.states.get(target)!
            const card = inside.workspaceCards().find(c => c.id === target)
            const offered: Gesture[] = [
              ...(Object.keys(VERBS) as Verb[]).filter(verb => VERBS[verb].offered(state)),
              ...(card && inside.dock.canOpenConversation(card) ? ['open' as const] : []),
            ]
            if (offered.length === 0) continue
            const gesture = offered[pick % offered.length]
                  const before = new Map(owner.states)
            const sentBefore = owner.sent.length
            // The key goes where a human's would: to the focused row, bubbling up.
            press(gesture === 'open' ? 'c' : VERB_KEY[gesture as Verb], document.activeElement ?? document)
            await settle()
            const popover = document.querySelector<HTMLElement>('.kbn-rest-popover')
            if (popover) { press('n', popover); await settle() }
            await finish()
            const sent = owner.sent.slice(sentBefore)
            const story = `${gesture} with ${target} highlighted (${stateKey(state)})\n  sent: ${JSON.stringify(sent)}\n  band: ${document.querySelector('.ws-band-title')?.textContent}; family: ${[...before].map(([id, s]) => `${id}=${stateKey(s)}`).join(' ')}`
            expect(sent.length, `the gesture reached no owner: ${story}`).toBeGreaterThan(0)
            expect(sent.map(s => s.fiber), `the band acted on a fiber that was not highlighted: ${story}`).toEqual(sent.map(() => target))
            for (const [id, s] of before) {
              if (id !== target) expect(stateKey(owner.states.get(id)!), `${id} changed though ${target} was highlighted: ${story}`).toBe(stateKey(s))
            }
          }
        } finally {
          board.unmount(); document.body.replaceChildren()
        }
      },
    ), { seed: SEED, numRuns: RUNS, endOnFailure: true })
  }, 120_000)
})
