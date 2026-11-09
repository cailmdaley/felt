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

interface Sent { route: string; body: Record<string, unknown>; outcome: Outcome | 'unmodeled'; delivered?: boolean }
type Gesture = Verb | 'send' | 'open'
const MESSAGE = 'Use the 400-mock catalogue.'

/** The owning daemon, answering every lifecycle request from the model. */
class ModelOwner {
  state: LifeState
  sent: Sent[] = []
  constructor(state: LifeState) { this.state = state }

  private answer(route: string, body: Record<string, unknown>, request: LifeRequest | null): Response {
    if (!request) {
      this.sent.push({ route, body, outcome: 'unmodeled' })
      return Response.json({})
    }
    const held = this.state.worker
    const { outcome, next, delivered } = apply(this.state, request)
    this.sent.push({ route, body, outcome, delivered })
    this.state = next
    // A launch and a 409 both name the worker, and its terminal when the owner can find one.
    const worker = (w: LifeState['worker']) => ({ tmux_session: 'model-worker', terminal: w === 'live' ? 'rex' : null })
    if (outcome === 'ok') return Response.json(route === 'dispatch' ? { dispatched: true, ...worker(next.worker) } : { ok: true })
    if (outcome === 'conflict') return Response.json({ dispatched: false, reason: 'already_running', ...worker(held) }, { status: 409 })
    return Response.json({ error: 'refused' }, { status: route === 'attach' ? 502 : 422 })
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), 'http://owner.test')
    const route = url.pathname.replace(/^\/api\/v1\//, '')
    if (init?.method !== 'POST') {
      if (route === 'fibers/composite') return Response.json({ host: 'model-host', fibers: [ownerRow(ID, this.state, Date.now())] })
      return Response.json({ fibers: [], files: [], entries: [] })
    }
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
    switch (route) {
      case 'transition': return this.answer(route, body, { route: 'transition', target: body.target as never })
      case 'lifecycle':
        return this.answer(route, body, body.action === 'rest' || body.action === 'resume' ? { route: 'lifecycle', action: body.action } : null)
      case 'kill': return this.answer(route, body, { route: 'kill' })
      case 'dispatch': return this.answer(route, body, { route: 'dispatch', said: typeof body.user_message === 'string' && body.user_message !== '' })
      case 'attach': return this.answer(route, body, typeof body.tmux_session === 'string' || typeof body.session === 'string' ? { route: 'attach', past: typeof body.session === 'string' } : null)
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

async function mount(state: LifeState): Promise<void> {
  owner = new ModelOwner(state)
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
function selected(): KanbanCard | undefined {
  const card = inside.workspaceCards().find(c => c.id === ID)
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
        await mount(start)
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
            const refused = owner.sent.slice(sentBefore).filter(s => s.outcome === 'refused' || s.outcome === 'conflict')
            expect(refused, `the owner refused a request: ${story()}`).toEqual([])
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
