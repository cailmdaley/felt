// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mapFeltJsonToFiber } from '../KanbanFiber.js'
import type { KanbanCard } from '../KanbanTypes.js'
import type { Channel } from './documents.js'
import { buildFiberProse } from './FiberProse.js'

const card: KanbanCard = {
  id: 'notes/task', uid: 'task', name: 'Task', path: '/fibers/task/task.md',
  originId: 'host-a', status: 'active', createdAt: '', fiberDir: '/fibers/task',
  shuttleKind: 'oneshot', effectiveHorizon: 'now', drifted: false, isCycle: false, cycleStart: '',
}
const channel: Channel = { uid: 'task', owner: 'host-a', name: 'Task', body: '', labels: ['Task'], documents: [] }

let base = 0
/** A daemon whose fiber index lists the given ids; each test gets its own base, so the shared index cache never answers for another. */
function daemon(ids: string[]): string {
  const shuttleBase = `http://roles-${++base}.invalid`
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ fibers: ids.map(id => ({ fiber: { id, name: id } })) }))))
  return shuttleBase
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

afterEach(() => { vi.unstubAllGlobals() })

describe('collaboration roster', () => {
  it('reads the role slugs in frontmatter order, empty holder lists included', () => {
    const fiber = mapFeltJsonToFiber({ id: 'a', collaboration: { surveyor: ['fable'], scribe: [] } })
    expect(fiber?.roles).toEqual(['surveyor', 'scribe'])
  })

  it('reads no roles from an absent roster or the older pointer shape', () => {
    expect(mapFeltJsonToFiber({ id: 'a' })?.roles).toBeUndefined()
    expect(mapFeltJsonToFiber({ id: 'a', collaboration: { role: { uid: 'x' }, collaborator: { uid: 'y' } } })?.roles).toBeUndefined()
  })

  it('names each role left of the acts and opens a resolved one through the wikilink path', async () => {
    const shuttleBase = daemon(['roles/surveyor'])
    const onFiber = vi.fn()
    const acts = document.createElement('div')
    acts.className = 'ws-fiber-acts'
    const pane = buildFiberProse({ ...card, roles: ['surveyor', 'archivist'] }, channel, { shuttleBase, acts, onFiber, onFile: vi.fn() })
    await settle()
    const roles = pane.querySelector<HTMLElement>('.ws-fiber-roles')!
    expect(roles.nextElementSibling).toBe(acts)
    expect([...roles.querySelectorAll('.ws-fiber-role')].map(role => role.textContent)).toEqual(['surveyor', 'archivist'])
    const live = roles.querySelectorAll<HTMLAnchorElement>('a.kbn-wikilink-live')
    expect(live).toHaveLength(1)
    live[0].click()
    expect(onFiber).toHaveBeenCalledWith('roles/surveyor')
    // An unresolved role is its bare name, not a link and not `[[…]]`.
    const inert = roles.querySelectorAll('.ws-fiber-role')[1]
    expect(inert.querySelector('a')).toBeNull()
    expect(inert.textContent).toBe('archivist')
  })

  it('opens only the exact role fiber, never a suffix, case or title match', async () => {
    // Each of these would satisfy a body wikilink's fuzzy fallbacks for `roles/scribe`.
    const shuttleBase = daemon(['projects/roles/scribe', 'Roles/Scribe', 'scribe-notes'])
    const pane = buildFiberProse({ ...card, roles: ['scribe'] }, channel, { shuttleBase, onFiber: vi.fn(), onFile: vi.fn() })
    await settle()
    const role = pane.querySelector('.ws-fiber-role')!
    expect(role.querySelector('a')).toBeNull()
    expect(role.textContent).toBe('scribe')
  })

  it('leaves every role plain text when the index cannot be read', async () => {
    const shuttleBase = `http://roles-${++base}.invalid`
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    const pane = buildFiberProse({ ...card, roles: ['surveyor'] }, channel, { shuttleBase, onFiber: vi.fn(), onFile: vi.fn() })
    await settle()
    const role = pane.querySelector('.ws-fiber-role')!
    expect(role.querySelector('a')).toBeNull()
    expect(role.textContent).toBe('surveyor')
  })

  it('draws nothing for a fiber without a roster', () => {
    const pane = buildFiberProse(card, channel, { shuttleBase: daemon([]), onFiber: vi.fn(), onFile: vi.fn() })
    expect(pane.querySelector('.ws-fiber-roles')).toBeNull()
  })
})
