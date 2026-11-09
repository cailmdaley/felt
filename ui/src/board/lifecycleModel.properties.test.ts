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
 * `LIFECYCLE_FUZZ_RUNS` deepens it; a failure prints the fast-check seed and
 * the shrunk sequence that reproduces it.
 */
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, ownerRow, served, STATES, stateKey, VERBS, type LifeRequest, type LifeState, type Outcome, type Verb } from '../../harness/lifecycleModel.js'
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

interface Sent { route: string; body: Record<string, unknown>; outcome: Outcome | 'unmodeled' }

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
    const { outcome, next } = apply(this.state, request)
    this.sent.push({ route, body, outcome })
    this.state = next
    if (outcome === 'ok') return Response.json({ ok: true })
    return Response.json({ error: outcome === 'conflict' ? 'already_running' : 'refused' }, { status: outcome === 'conflict' ? 409 : 422 })
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
      case 'dispatch': return this.answer(route, body, { route: 'dispatch' })
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
  board = new KanbanModal({ shuttleBase: '' })
  inside = board as unknown as BoardInternals
  vi.spyOn(inside, 'startPolling').mockImplementation(() => {})
  board.mount(document.body)
  await inside.fetchAndRender()
  await settle()
}

function press(key: string, target: EventTarget = document): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

/** A human performs `verb` on the card from the Desk, by its key, and lets the board finish. */
async function perform(verb: Verb): Promise<boolean> {
  const card = inside.workspaceCards().find(c => c.id === ID)
  if (!card) return false
  inside.deskKeyboard.select({ uid: card.uid ?? card.id, origin: card.originId }, false)
  press(VERB_KEY[verb])
  await settle()
  // The rest popover asks until when: undated.
  const popover = document.querySelector<HTMLElement>('.kbn-rest-popover')
  if (popover) { press('n', popover); await settle() }
  // The verdict waits out its undo window, then commits.
  await vi.advanceTimersByTimeAsync(10_000)
  for (let i = 0; i < 4; i++) await settle()
  await inside.fetchAndRender()
  await settle()
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
            const offered = (Object.keys(VERBS) as Verb[]).filter(verb => VERBS[verb].offered(before))
            if (offered.length === 0) return
            const verb = offered[pick % offered.length]
            const sentBefore = owner.sent.length
            const reached = await perform(verb)
            // A verdict archives the card off the Desk; its remaining verbs live on other surfaces.
            if (!reached) return
            const after = owner.state
            const story = `${verb} on ${stateKey(before)} → ${stateKey(after)}\n  sent: ${JSON.stringify(owner.sent.slice(sentBefore))}`
            const refused = owner.sent.slice(sentBefore).filter(s => s.outcome === 'refused' || s.outcome === 'conflict')
            expect(refused, `the owner refused a request: ${story}`).toEqual([])
            expect(VERBS[verb].reached(before, after), `${verb} did not do what it promised: ${story}`).toBe(true)
            if (!VERBS[verb].mayLookSame?.(before)) {
              expect(drawn(after), `${verb} changed nothing the human can see: ${story}\n  drawn: ${drawn(before)}`).not.toBe(drawn(before))
            }
            expect(boardCard(inside.lastResponse)?.column, `the board draws the card where the owner does not: ${story}`)
              .toBe(modelCard(after).column)
          }
        } finally {
          board.unmount(); document.body.replaceChildren()
        }
      },
    ), { seed: SEED, numRuns: RUNS, endOnFailure: true })
  }, 120_000)
})
