import { describe, expect, it } from 'vitest'
import type { KanbanCard } from '../KanbanTypes.js'
import { ThreadIndex } from '../threads.js'
import { buildTree, openByDefault, pathTo, visibleRows, type TreeFeeds, type TreeItem } from './treeModel.js'

const NOW = Date.parse('2026-11-07T04:00:00Z')
const card = (id: string, over: Partial<KanbanCard> = {}): KanbanCard => ({
  id, uid: id, name: id.split('/').at(-1)!, path: `${id}.md`, originId: 'here', status: 'closed', closedAt: '2026-11-01T00:00:00Z', tempered: true,
  createdAt: '2026-10-01T00:00:00Z', effectiveHorizon: 'now', drifted: false, isCycle: false, cycleStart: null, shuttleKind: 'oneshot', ...over,
} as KanbanCard)
const working = (id: string, over: Partial<KanbanCard> = {}): KanbanCard => card(id, { status: 'active', closedAt: undefined, tempered: undefined, workerState: 'running', runtimePhase: 'working', ...over } as Partial<KanbanCard>)
const asking = (id: string, over: Partial<KanbanCard> = {}): KanbanCard => working(id, { runtimePhase: 'attention', ...over } as Partial<KanbanCard>)
const draft = (id: string): KanbanCard => card(id, { status: 'open', closedAt: undefined, tempered: undefined })
const resting = (id: string): KanbanCard => card(id, { status: 'open', closedAt: undefined, tempered: undefined, effectiveHorizon: 'stashed', dispatchedAt: 'x' } as Partial<KanbanCard>)
const none: TreeFeeds = { files: () => [], lead: () => undefined }
const tree = (cards: KanbanCard[], feeds = none): TreeItem => buildTree(new ThreadIndex(cards), cards, feeds, NOW)
const names = (node: TreeItem): string[] => node.children.map(child => child.name)
const find = (node: TreeItem, name: string): TreeItem => {
  const hit = visibleRows(node, () => true).find(row => row.item.name === name)
  if (!hit) throw new Error(`no ${name}`)
  return hit.item
}

describe('buildTree', () => {
  it('hangs threads from their orchestrators and roots along their fiber paths', () => {
    const top = tree([
      working('science/cmbx/hub'), working('science/cmbx/hub/a', { orchestrator: 'science/cmbx/hub' }),
      working('science/cmbx/hub/note'), working('science/unions/x'), working('science/unions/y'),
    ])
    expect(names(top)).toEqual(['science'])
    const science = top.children[0]
    expect(names(science)).toEqual(['unions', 'hub'])
    expect(names(find(top, 'hub')).filter(name => name !== 'Constitution').sort()).toEqual(['a', 'note'])
  })
  it('lets a group holding one thing give way to it', () => {
    const top = tree([working('life/admin/deep/thing'), working('life/admin/wide/one'), working('life/admin/wide/two'), working('life/admin/other/three')])
    expect(names(top)).toEqual(['life/admin'])
    expect(names(top.children[0])).toEqual(['wide', 'thing', 'three'])
    const chain = tree([working('a/b/c/one'), working('a/b/c/two')])
    expect(names(chain)).toEqual(['a/b/c'])
  })
  it('never loops through a root sitting on the path of its own thread, or of a family hanging from it', () => {
    const top = tree([
      working('p/q/r'), working('p/q/r/s/t', { orchestrator: 'p/q/r' }),
      working('p/q/r/s'), working('p/q', { orchestrator: 'p/q/r/s' }),
    ])
    const rows = visibleRows(top, () => true)
    expect(rows.filter(row => row.item.thread).length).toBe(4)
  })
  it('stands in-play threads in their parent and folds the rest by shelf', () => {
    const top = tree([
      working('work/hub'), asking('work/hub/live', { orchestrator: 'work/hub' }), card('work/hub/done', { orchestrator: 'work/hub' }),
      draft('work/hub/idea'), resting('work/hub/later'),
    ].map((c, n) => n >= 3 ? { ...c, orchestrator: 'work/hub' } : c))
    const hub = top.children[0]
    expect(hub.name).toBe('hub')
    expect(names(hub)).toEqual(['live', 'Drafts', 'Resting', 'Archived', 'Constitution'])
    expect(find(top, 'Archived').children.map(child => child.name)).toEqual(['done'])
    expect(find(top, 'done').parent?.kind).toBe('fold')
  })
  it('needs no fold where a parent has nothing else to show', () => {
    const top = tree([card('quiet/a'), card('quiet/b'), working('other/x'), working('other/y')])
    expect(names(top)).toEqual(['other', 'quiet'])
    expect(names(top.children[1])).toEqual(['a', 'b'])
    const family = tree([card('h'), card('h/a', { orchestrator: 'h' })])
    expect(names(family.children[0])).toEqual(['a', 'Constitution'])
  })
  it('keeps resting ancestors of live work in view', () => {
    const top = tree([working('g/x'), resting('g/old'), { ...resting('g/old/kid') }, working('g/old/kid/live', { orchestrator: 'g/old/kid' })].map(c => c.id === 'g/old/kid' ? { ...c, orchestrator: 'g/old' } : c))
    expect(find(top, 'old').live).toBe(true)
    expect(find(top, 'old').parent?.kind).not.toBe('fold')
  })
  it('lists a thread\'s tapestry first, sent files by the feed, its constitution last, and folds them beside threads', () => {
    const file = (name: string, at: number) => ({ key: `/f/${name}`, name, at, unread: false })
    const feeds: TreeFeeds = {
      files: c => c.id === 'leaf' ? [file('b.png', 9), file('a.png', 8)] : c.id === 'hub' ? [file('c.png', 7)] : [],
      lead: c => c.id === 'leaf' ? file('Tapestry', 5) : undefined,
    }
    const top = tree([working('leaf'), working('hub'), working('hub/kid', { orchestrator: 'hub' })], feeds)
    const leaf = find(top, 'leaf')
    expect(names(leaf)).toEqual(['Tapestry', 'b.png', 'a.png', 'Constitution'])
    expect(leaf.files).toBe(3)
    const hub = find(top, 'hub')
    expect(names(hub)).toEqual(['Files', 'kid'])
    expect(names(hub.children[0])).toEqual(['c.png', 'Constitution'])
    expect(hub.threads).toBe(1)
    expect(hub.files).toBe(1)
  })
  it('rolls up what asks through collapsed rows, itself not counted', () => {
    const top = tree([asking('a/b/x'), asking('a/b/y'), working('a/c/z'), working('a/c/w')])
    const a = top.children[0]
    expect(a.rollup).toMatchObject({ question: 2, working: 2 })
    expect(find(top, 'x').rollup.question).toBe(0)
    expect(a.threads).toBe(4)
  })
})

describe('visibleRows', () => {
  const top = tree([working('s/hub'), working('s/hub/kid', { orchestrator: 's/hub' }), card('s/hub/old', { orchestrator: 's/hub', name: 'Polarization rotation' }), working('s/other')])
  it('opens what holds something live and leaves folds shut', () => {
    const rows = visibleRows(top, openByDefault)
    expect(rows.map(row => [row.item.name, row.level, row.open])).toContainEqual(['Archived', 3, false])
    expect(rows.map(row => row.item.name)).toContain('kid')
    expect(rows.map(row => row.item.name)).not.toContain('Polarization rotation')
  })
  it('keeps the way to a match shown, through folds', () => {
    const rows = visibleRows(top, () => false, 'POLAR rot')
    expect(rows.map(row => row.item.name)).toEqual(['s', 'hub', 'Archived', 'Polarization rotation'])
    expect(rows.map(row => row.level)).toEqual([1, 2, 3, 4])
    expect(rows.at(-1)!.open).toBeNull()
  })
  it('sizes each row among its shown siblings', () => {
    const rows = visibleRows(top, openByDefault)
    const first = rows[0]
    expect([first.pos, first.size]).toEqual([1, 1])
  })
  it('walks the path down to a row, folds left out', () => {
    expect(pathTo(find(top, 'Polarization rotation')).map(node => node.name)).toEqual(['s', 'hub', 'Polarization rotation'])
  })
})
