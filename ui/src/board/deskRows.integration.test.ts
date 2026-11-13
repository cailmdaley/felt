// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanSurfaceRenderer, restingOrder } from './KanbanSurfaces.js'
import type { KanbanCard, KanbanResponse } from './KanbanTypes.js'
import { card, response, settle } from './testFixtures.js'

function options(data: KanbanResponse) {
  return {
    getDragSourceId: () => null, setDragSourceId: () => {}, getLastResponse: () => data,
    stopDragAutoScroll: () => {}, transition: vi.fn(), setSurface: () => {}, openDetail: vi.fn(),
    onRest: vi.fn(),
  }
}
const storage = new Map<string, string>()
beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v) } })
})
afterEach(() => { document.body.replaceChildren(); storage.clear(); vi.unstubAllGlobals() })

describe('a Desk row is a line, not a card', () => {
  const review = card({ id: 'work/run', name: 'Null tests on the reprocessed maps', status: 'closed', shuttleKind: 'oneshot', shuttleAgent: 'codex-sol', outcome: 'Ran the **comparison**; figures in report.html.', due: '2026-10-21' })
  const asked = card({ id: 'asked', status: 'active', shuttleKind: 'oneshot', ask: { text: 'Which cut?', at: '2026-10-18T12:00:00Z' } })
  const data = response({ now: { drafts: [card({ id: 'draft', shuttleKind: 'oneshot', outcome: 'Plan it.' })], inFlight: [asked], awaitingReview: [review] } })
  const draw = () => new KanbanSurfaceRenderer(options(data)).renderNowSection(data.now, data.staleness)

  it('carries the title and the glance facts, and nothing read', () => {
    const root = draw()
    expect(root.querySelector('[data-fiber-id="work/run"] .kbn-card-name')?.textContent).toBe('run')
    expect(root.querySelector<HTMLElement>('[data-fiber-id="work/run"] .kbn-card-name')?.title).toBe(review.name)
    for (const heavy of ['.kbn-card-outcome', '.kbn-card-id', '.kbn-card-question', '.kbn-card-actor', '.kbn-card-due', '.ws-thumbnail']) expect(root.querySelector(heavy), heavy).toBeNull()
  })

  it('keeps the verdict undo host at the row’s right end', () => {
    expect(draw().querySelector<HTMLElement>('[data-fiber-id="work/run"] > .kbn-card-meta')!.dataset.verdictKey).toBeTruthy()
  })
})

describe('a Resting line takes its verdicts', () => {
  const resting = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>) => card({ status: 'open', effectiveHorizon: 'stashed', storedHorizon: 'stashed', ...over })
  const once = resting({ id: 'once', uid: 'U-ONCE', shuttleKind: 'oneshot' })
  const standing = resting({ id: 'standing', uid: 'U-STAND', shuttleKind: 'standing', status: 'active', shuttleSchedule: '0 8 * * *' })
  const todo = resting({ id: 'todo', uid: 'U-TODO' })
  const data = response({ stash: [once, standing, todo] })
  it('offers Temper and Discard on a constitution at rest, Pause schedule and Retire on a standing one, none on a plain note', async () => {
    const root = new KanbanSurfaceRenderer(options(data)).renderStashSection(restingOrder(data.stash), {})
    document.body.append(root)
    const labels = async (id: string) => {
      root.querySelector<HTMLElement>(`[data-fiber-id="${id}"]`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      await settle()
      const menu = document.querySelector('[role="menu"]')!
      const labels = [...menu.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])')].map(b => b.textContent)
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await settle()
      return labels
    }
    expect(await labels('once')).toEqual(['Rest', 'Temper', 'Discard'])
    expect(await labels('standing')).toEqual(['Pause schedule', 'Retire'])
    expect(await labels('todo')).toEqual([])
    expect(root.querySelector<HTMLElement>('[data-fiber-id="once"] .kbn-cluster-item-verdicts')?.dataset.verdictKey).toBeTruthy()
  })
  it('keeps a Resting menu on its title line without pinned subentries or a tree', () => {
    const root = resting({ id: 'family', uid: 'family', shuttleKind: 'oneshot' })
    const child = card({ id: 'family/child', orchestrator: 'family', tags: ['pinned'], status: 'active' })
    const data = response({ stash: [root], threads: [child] })
    const surfaces = new KanbanSurfaceRenderer(options(data))
    const row = surfaces.renderStashSection(restingOrder(data.stash), {}).querySelector<HTMLElement>('[data-fiber-id="family"]')!
    const end = row.querySelector<HTMLElement>('.kbn-cluster-item-verdicts')!
    const trees = [...row.querySelectorAll<HTMLElement>(':scope > .kbn-thread-tree')]
    expect(trees).toHaveLength(0)
    expect(row.querySelector('.kbn-thread-subentries, .kbn-thread-pin')).toBeNull()
    expect(end.dataset.verdictKey).toBeTruthy()
  })
  it('sends the verdict through the board transition, without opening the card', async () => {
    const o = options(data)
    const root = new KanbanSurfaceRenderer(o).renderStashSection(restingOrder(data.stash), {})
    document.body.append(root)
    root.querySelector<HTMLElement>('[data-fiber-id="once"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await settle()
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(b => b.textContent === 'Discard')!.click()
    await settle()
    expect(o.transition).toHaveBeenCalledWith(expect.objectContaining({ id: 'once' }), 'composted')
    expect(o.openDetail).not.toHaveBeenCalled()
  })
})
