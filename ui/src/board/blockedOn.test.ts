// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KanbanCard } from './KanbanTypes.js'
import { ThreadIndex } from './threads.js'
import { untilLine, untilOf } from './blockedOn.js'

const UID = '01JB0CKER00000000000000000'
const card = (over: Partial<KanbanCard>): KanbanCard =>
  ({ id: 'hub/a', name: 'A', status: 'open', originId: 'local', tags: [], ...over }) as KanbanCard

describe('untilOf', () => {
  it('reads nothing when the rest waits for nothing', () => {
    expect(untilOf(card({}))).toBeNull()
  })
  it('reads free text as itself', () => {
    expect(untilOf(card({ shuttleBlockedOn: "Cail's review" }))).toEqual({ text: "Cail's review" })
  })
  it('names a constitution the board holds by its uid', () => {
    const blocker = card({ id: 'hub/mocks', uid: UID, name: 'The mocks land', status: 'active' })
    const until = untilOf(card({ shuttleBlockedOn: UID }), new ThreadIndex([blocker]))
    expect(until?.text).toBe('The mocks land')
    expect(until?.card?.id).toBe('hub/mocks')
  })
})

describe('untilLine', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is a chip that opens the constitution it names', () => {
    const blocker = card({ id: 'hub/mocks', uid: UID, name: 'The mocks land', status: 'active' })
    const open = vi.fn()
    const line = untilLine(untilOf(card({ shuttleBlockedOn: UID }), new ThreadIndex([blocker]))!, open)
    expect(line.textContent).toBe('⏸ until The mocks land')
    line.querySelector<HTMLElement>('.kbn-until-chip')!.click()
    expect(open).toHaveBeenCalledWith(blocker)
  })

  it('names a fiber off the board from the daemon\'s fiber index', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      fibers: [{ fiber: { id: UID, slug: 'notes/design', name: 'The design settles' } }],
    }))))
    const line = untilLine(untilOf(card({ shuttleBlockedOn: UID }))!)
    expect(line.textContent).toBe('⏸ until …')
    await vi.waitFor(() => expect(line.textContent).toBe('⏸ until The design settles'))
    expect(line.querySelector('.kbn-until-chip')).toBeNull()
  })
})
