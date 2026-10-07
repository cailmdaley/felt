// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import type { KanbanCard } from '../KanbanTypes.js'
import type { Channel } from './documents.js'
import { buildFiberProse } from './FiberProse.js'
import { roleHolds, roleSlug } from './RolePage.js'

const role = card({ id: 'roles/surveyor', uid: 'surveyor', name: 'Surveyor', outcome: 'Maps a project.' })
const channel: Channel = { uid: 'surveyor', owner: 'local', name: 'Surveyor', body: 'Reads first.', labels: ['Note'], documents: [] }
const work = (id: string, over: Partial<KanbanCard>): KanbanCard =>
  card({ id, uid: id, name: id, shuttleKind: 'oneshot', roles: ['surveyor'], ...over })
const draft = work('draft', { status: 'open', outcome: 'A *draft* to write.' })
const flying = work('flying', { status: 'active', workerState: 'running', tmuxSession: 'flying-shuttle' })
const review = work('review', { status: 'closed' })
const tempered = work('tempered', { status: 'closed', tempered: true })

let base = 0
function daemon(ids: string[]): string {
  const shuttleBase = `http://role-page-${++base}.invalid`
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ fibers: ids.map(id => ({ fiber: { id, name: id } })) }))))
  return shuttleBase
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const names = (root: ParentNode, selector: string) => [...root.querySelectorAll(selector)].map(el => el.textContent)

afterEach(() => { vi.unstubAllGlobals() })

describe('role page', () => {
  it('is exactly a fiber at roles/<slug>, never a holder beneath it or a role elsewhere', () => {
    expect(roleSlug(role)).toBe('surveyor')
    expect(roleSlug(card({ id: 'roles/surveyor/opus' }))).toBeNull()
    expect(roleSlug(card({ id: 'projects/roles/surveyor' }))).toBeNull()
    expect(roleSlug(card({ id: 'roles' }))).toBeNull()
  })

  it('holds the constitutions whose roster names the role, in the Desk order', () => {
    const other = work('other', { roles: ['scribe'] })
    expect(roleHolds([tempered, draft, other, flying, review], 'surveyor').map(c => c.id)).toEqual(['review', 'flying', 'draft', 'tempered'])
  })

  it('lists holds and holders under the lede, before the body, and opens each', async () => {
    const shuttleBase = daemon(['roles/surveyor', 'roles/surveyor/opus', 'roles/surveyor/fable', 'roles/surveyor/opus/notes', 'roles/scribe/opus'])
    const onCard = vi.fn(), onFiber = vi.fn()
    const pane = buildFiberProse(role, channel, { shuttleBase, onFiber, onFile: vi.fn(), holds: [review, flying, draft], onCard })
    await settle(); await settle()
    const ledger = pane.querySelector<HTMLElement>('[data-part="role-ledger"]')!
    expect(ledger.previousElementSibling?.querySelector('.kbn-detail-lede')).not.toBeNull()
    expect(ledger.nextElementSibling?.classList.contains('ws-prose-body')).toBe(true)
    expect(names(ledger, '.ws-role-caption')).toEqual(['Held by', 'Holds'])
    // Only the direct children are holders.
    expect(names(ledger, '.ws-role-holder')).toEqual(['fable', 'opus'])
    ledger.querySelector<HTMLAnchorElement>('.ws-role-holder a.kbn-wikilink-live')!.click()
    expect(onFiber).toHaveBeenCalledWith('roles/surveyor/fable')
    const rows = [...ledger.querySelectorAll<HTMLButtonElement>('.ws-role-hold')]
    expect(rows.map(row => row.dataset.column)).toEqual(['awaitingReview', 'inFlight', 'drafts'])
    expect(names(ledger, '.ws-role-hold-column')).toEqual(['Review', 'In flight', 'Draft'])
    expect(rows[2].querySelector('.ws-role-hold-outcome')?.textContent).toBe('A draft to write.')
    rows[1].click()
    expect(onCard).toHaveBeenCalledWith(flying)
  })

  it('shows live work whole and folds the rest past five rows', async () => {
    const settled = Array.from({ length: 6 }, (_, i) => work(`done-${i}`, { status: 'closed', tempered: true }))
    const holds = [review, flying, ...settled]
    const pane = buildFiberProse(role, channel, { shuttleBase: daemon([]), onFiber: vi.fn(), onFile: vi.fn(), holds, onCard: vi.fn() })
    expect(pane.querySelectorAll('.ws-role-hold')).toHaveLength(5)
    const more = pane.querySelector<HTMLButtonElement>('.ws-role-more')!
    expect(more.textContent).toBe('3 more')
    more.click()
    expect(pane.querySelectorAll('.ws-role-hold')).toHaveLength(8)
    expect(pane.querySelector('.ws-role-more')).toBeNull()
  })

  it('draws no heading for a role that holds nothing and no one holds', async () => {
    const pane = buildFiberProse(role, channel, { shuttleBase: daemon(['roles/surveyor']), onFiber: vi.fn(), onFile: vi.fn(), holds: [] })
    await settle(); await settle()
    expect(pane.querySelector('.ws-role-caption')).toBeNull()
    expect(pane.querySelector<HTMLElement>('[data-part="role-holders"]')?.hidden).toBe(true)
  })

  it('gives a holder page and any other fiber no ledger', () => {
    for (const id of ['roles/surveyor/opus', 'notes/task']) {
      const pane = buildFiberProse(card({ id }), channel, { shuttleBase: daemon([]), onFiber: vi.fn(), onFile: vi.fn(), holds: [draft] })
      expect(pane.querySelector('[data-part="role-ledger"]')).toBeNull()
    }
  })
})
