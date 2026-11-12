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
function daemon(ids: string[]): string {
  const shuttleBase = `http://roles-${++base}.invalid`
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ fibers: ids.map(id => ({ fiber: { id, name: id } })) }))))
  return shuttleBase
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

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
    const shuttleBase = daemon(['roles/surveyor'])
    const onFiber = vi.fn()
    const pane = buildFiberProse({ ...card, shuttleRole: 'surveyor' }, channel, { shuttleBase, onFiber, onFile: vi.fn() })
    await settle()
    const roles = pane.querySelector<HTMLElement>('.ws-fiber-roles')!
    expect(roles.querySelectorAll('.ws-fiber-role')).toHaveLength(1)
    expect(roles.textContent).toBe('surveyor')
    roles.querySelector<HTMLAnchorElement>('a.kbn-wikilink-live')!.click()
    expect(onFiber).toHaveBeenCalledWith('roles/surveyor')
  })

  it('opens a charter in a mount, the store\'s own first', async () => {
    for (const [ids, want] of [
      [['shared/roles/scribe'], 'shared/roles/scribe'],
      [['shared/roles/scribe', 'roles/scribe'], 'roles/scribe'],
    ] as const) {
      const onFiber = vi.fn()
      const pane = buildFiberProse({ ...card, shuttleRole: 'scribe' }, channel, { shuttleBase: daemon([...ids]), onFiber, onFile: vi.fn() })
      await settle()
      pane.querySelector<HTMLAnchorElement>('.ws-fiber-role a.kbn-wikilink-live')!.click()
      expect(onFiber).toHaveBeenCalledWith(want)
    }
  })

  it('opens only a charter, never a deeper path, holder, case or title match', async () => {
    const shuttleBase = daemon(['a/b/roles/scribe', 'roles/scribe/opus', 'Roles/Scribe', 'scribe-notes'])
    const pane = buildFiberProse({ ...card, shuttleRole: 'scribe' }, channel, { shuttleBase, onFiber: vi.fn(), onFile: vi.fn() })
    await settle()
    const role = pane.querySelector('.ws-fiber-role')!
    expect(role.querySelector('a')).toBeNull()
    expect(role.textContent).toBe('scribe')
  })

  it('leaves the office plain text when the index cannot be read', async () => {
    const shuttleBase = `http://roles-${++base}.invalid`
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    const pane = buildFiberProse({ ...card, shuttleRole: 'surveyor' }, channel, { shuttleBase, onFiber: vi.fn(), onFile: vi.fn() })
    await settle()
    const role = pane.querySelector('.ws-fiber-role')!
    expect(role.querySelector('a')).toBeNull()
    expect(role.textContent).toBe('surveyor')
  })

  it('draws nothing for a fiber without an office', () => {
    const pane = buildFiberProse(card, channel, { shuttleBase: daemon([]), onFiber: vi.fn(), onFile: vi.fn() })
    expect(pane.querySelector('.ws-fiber-roles')).toBeNull()
  })
})
