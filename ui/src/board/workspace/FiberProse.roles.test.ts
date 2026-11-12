// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mapFeltJsonToFiber } from '../KanbanFiber.js'
import type { KanbanCard } from '../KanbanTypes.js'
import type { Channel } from './documents.js'
import { buildFiberProse } from './FiberProse.js'

const card: KanbanCard = {
  id: 'notes/task', uid: 'task', name: 'Task', path: '/fibers/task/task.md',
  originId: 'host-a', status: 'active', column: 'inFlight', turn: 'none', createdAt: '', fiberDir: '/fibers/task',
  shuttleKind: 'oneshot', effectiveHorizon: 'now', drifted: false, isCycle: false, cycleStart: '',
}
const channel: Channel = { uid: 'task', owner: 'host-a', name: 'Task', body: '', labels: ['Task'], documents: [] }

let base = 0
/** A daemon whose charter catalogue is charters (`slug=id`) and whose fiber index holds them and ids. */
function daemon(charters: string[], ids: string[] = []): string {
  const shuttleBase = `http://roles-${++base}.invalid`
  const catalogue = charters.map(entry => { const [slug, id] = entry.split('='); return { slug, id, name: slug, outcome: '' } })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/api/v1/roles')
    ? new Response(JSON.stringify(catalogue))
    : new Response(JSON.stringify({ fibers: [...catalogue.map(c => c.id), ...ids].map(id => ({ fiber: { id, name: id } })) }))))
  return shuttleBase
}
/** Resolves once the role chip has read its catalogue: its link is live, or gone. */
const settle = (pane: HTMLElement) => vi.waitFor(() => { expect(pane.querySelector('.ws-fiber-role a:not(.kbn-wikilink-live)')).toBeNull() })

afterEach(() => { vi.unstubAllGlobals() })

describe('constitution role', () => {
  it('reads one office from shuttle.role, independently of seat', () => {
    expect(mapFeltJsonToFiber({ id: 'a', shuttle: { role: 'surveyor' } })?.shuttleRole).toBe('surveyor')
    expect(mapFeltJsonToFiber({ id: 'a', shuttle: { role: 'surveyor', seat: false } })?.shuttleSeat).toBe(false)
  })

  it('ignores top-level collaboration and string seats without deriving an office', () => {
    const fiber = mapFeltJsonToFiber({ id: 'a', collaboration: { surveyor: ['sol'] }, shuttle: { seat: 'surveyor' } })!
    expect(fiber.shuttleRole).toBeUndefined()
    expect(fiber.shuttleSeat).toBeUndefined()
    expect(fiber).not.toHaveProperty('roles')
    expect(fiber).not.toHaveProperty('collaboration')
    expect(mapFeltJsonToFiber({ id: 'a', collaboration: { surveyor: [] }, shuttle: { role: 'scribe' } })?.shuttleRole).toBe('scribe')
  })

  it.each(['', 'roles/surveyor', 'Surveyor', 'two roles', 'surveyor--scribe'])('rejects invalid role slug %j', role => {
    expect(mapFeltJsonToFiber({ id: 'a', shuttle: { role } })?.shuttleRole).toBeUndefined()
  })

  it('names the office and opens its charter through the wikilink path', async () => {
    const shuttleBase = daemon(['surveyor=roles/surveyor'])
    const onFiber = vi.fn()
    const pane = buildFiberProse({ ...card, shuttleRole: 'surveyor' }, channel, { shuttleBase, onFiber, onFile: vi.fn() })
    await settle(pane)
    const roles = pane.querySelector<HTMLElement>('.ws-fiber-roles')!
    expect(roles.querySelectorAll('.ws-fiber-role')).toHaveLength(1)
    expect(roles.textContent).toBe('surveyor')
    roles.querySelector<HTMLAnchorElement>('a.kbn-wikilink-live')!.click()
    expect(onFiber).toHaveBeenCalledWith('roles/surveyor')
  })

  it('opens the charter the catalogue names, in a mount too', async () => {
    const onFiber = vi.fn()
    const pane = buildFiberProse({ ...card, shuttleRole: 'scribe' }, channel, { shuttleBase: daemon(['scribe=shared/roles/scribe'], ['roles/scribe/opus']), onFiber, onFile: vi.fn() })
    await settle(pane)
    pane.querySelector<HTMLAnchorElement>('.ws-fiber-role a.kbn-wikilink-live')!.click()
    expect(onFiber).toHaveBeenCalledWith('shared/roles/scribe')
  })

  it('opens nothing for an office the catalogue lacks, whatever fibers look like a charter', async () => {
    const shuttleBase = daemon([], ['notes/roles/scribe', 'roles/scribe/opus', 'Roles/Scribe', 'scribe-notes'])
    const pane = buildFiberProse({ ...card, shuttleRole: 'scribe' }, channel, { shuttleBase, onFiber: vi.fn(), onFile: vi.fn() })
    await settle(pane)
    const role = pane.querySelector('.ws-fiber-role')!
    expect(role.querySelector('a')).toBeNull()
    expect(role.textContent).toBe('scribe')
  })

  it('names the person responsible beside the office, and opens the office charter', async () => {
    expect(mapFeltJsonToFiber({ id: 'a', role: 'scribe/sam', shuttle: { role: 'scribe', person: 'sam' } })?.shuttlePerson).toBe('sam')
    const onFiber = vi.fn()
    const pane = buildFiberProse({ ...card, shuttleRole: 'scribe', shuttlePerson: 'sam' }, channel, { shuttleBase: daemon(['scribe=roles/scribe']), onFiber, onFile: vi.fn() })
    await settle(pane)
    const role = pane.querySelector('.ws-fiber-role')!
    expect(role.textContent).toBe('scribe · sam')
    role.querySelector<HTMLAnchorElement>('a.kbn-wikilink-live')!.click()
    expect(onFiber).toHaveBeenCalledWith('roles/scribe')
    const desk = buildFiberProse({ ...card, shuttleRole: 'sam', shuttlePerson: 'sam' }, channel, { shuttleBase: daemon([]), onFiber, onFile: vi.fn() })
    expect(desk.querySelector('.ws-fiber-role')!.textContent).toBe('sam')
  })

  it('leaves the office plain text when the index cannot be read', async () => {
    const shuttleBase = `http://roles-${++base}.invalid`
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    const pane = buildFiberProse({ ...card, shuttleRole: 'surveyor' }, channel, { shuttleBase, onFiber: vi.fn(), onFile: vi.fn() })
    await settle(pane)
    const role = pane.querySelector('.ws-fiber-role')!
    expect(role.querySelector('a')).toBeNull()
    expect(role.textContent).toBe('surveyor')
  })

  it('draws nothing for a fiber without an office', () => {
    const pane = buildFiberProse(card, channel, { shuttleBase: daemon([]), onFiber: vi.fn(), onFile: vi.fn() })
    expect(pane.querySelector('.ws-fiber-roles')).toBeNull()
  })
})
