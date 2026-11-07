import { expect, it } from 'vitest'
import { card } from '../testFixtures.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { ThreadIndex } from '../threads.js'
import { familyModel, type MapFeeds } from './model.js'
import { opening, outline, underAll, type Line } from './outline.js'

const now = 1_800_000_000_000, hour = 3_600_000
const noFeeds: MapFeeds = { marks: () => undefined, files: () => [] }
const at = (back: number): string => new Date(now - back * hour).toISOString()
const running = (phase: string, age: number): Partial<KanbanCard> => ({ status: 'active', workerState: 'running', runtimePhase: phase as KanbanCard['runtimePhase'], lastActivityAt: now - age * hour, workerStartedAt: now - 100 * hour })
const thread = (id: string, over: Partial<KanbanCard>, orchestrator = 'hub'): KanbanCard => card({ id, orchestrator, createdAt: at(200), ...over })
const root = card({ id: 'hub', createdAt: at(300), ...running('working', 0) })
const model = (cards: KanbanCard[]) => familyModel(new ThreadIndex(cards), cards[0], cards[0], noFeeds, now)
const said = (lines: Line[]): string[] => lines.map(line => line.kind === 'section' ? `[${line.section}]` : line.kind === 'aside' ? `${'  '.repeat(line.level)}(${line.threads.length} aside)` : `${'  '.repeat(line.level)}${line.thread.card.id.split('/').at(-1)}`)

const family = [root,
  thread('hub/review', { status: 'closed', closedAt: at(1) }),
  thread('hub/turn-old', running('waiting', 9)),
  thread('hub/working', running('working', 1)),
  thread('hub/turn-new', running('waiting', 2)),
  thread('hub/lead', running('working', 3)),
  thread('hub/lead/asks', { ...running('working', 4), ask: { text: 'Which?', at: at(4) } }, 'hub/lead'),
  thread('hub/lead/done', { status: 'closed', tempered: true, closedAt: at(30) }, 'hub/lead'),
  thread('hub/archived', { status: 'closed', tempered: true, closedAt: at(5) }),
  thread('hub/draft', { status: 'open' }),
]

it('lists the root\'s threads under one divider per kind of attention, each once, newest first within one, and the set-aside behind one fold at the end', () => {
  expect(said(outline(model(family), new Set()))).toEqual(['[question]', 'lead', '[turn]', 'turn-new', 'turn-old', '[review]', 'review', '[working]', 'working', '(2 aside)'])
})
it('puts a row in the section of the most urgent thing it holds, and counts what asks under it', () => {
  const m = model(family), under = underAll(m), lead = [...m.threads.values()].find(t => t.card.id === 'hub/lead')!
  expect(under.get(lead.key)).toMatchObject({ section: 'question', threads: 2, asks: 1 })
  expect(under.get(lead.key)!.from!.card.id).toBe('hub/lead/asks')
  expect(under.get(m.root.key)!.section).toBe('question')
})
it('unfolds an open row to its own threads beneath it without dividers, its set-aside behind its own fold', () => {
  const m = model(family), lead = [...m.threads.values()].find(t => t.card.id === 'hub/lead')!
  expect(said(outline(m, new Set([lead.key])))).toEqual(['[question]', 'lead', '  asks', '  (1 aside)', '[turn]', 'turn-new', 'turn-old', '[review]', 'review', '[working]', 'working', '(2 aside)'])
  expect(said(outline(m, new Set([lead.key, `aside:${lead.key}`])))).toContain('  done')
})
it('groups set-aside threads at each level: resting, drafts, seats, then archived', () => {
  const cards = [root,
    thread('hub/archive', { status: 'closed', tempered: true, closedAt: at(1) }),
    thread('hub/rest', { status: 'open', effectiveHorizon: 'stashed', shuttleKind: 'oneshot' }),
    thread('hub/draft', { status: 'open' }),
    thread('hub/seat', { status: 'open', shuttleKind: 'oneshot', shuttleSeat: true, shuttleRole: 'keeper' }),
    thread('hub/rest/deep', { status: 'closed', tempered: true }, 'hub/rest'),
  ]
  const m = model(cards), rest = [...m.threads.values()].find(t => t.card.id === 'hub/rest')!
  const open = new Set([`aside:${m.root.key}`, rest.key, `aside:${rest.key}`])
  expect(said(outline(m, open))).toEqual(['(4 aside)', '[resting]', 'rest', '  (1 aside)', '[archived]', '  deep', '[drafts]', 'draft', '[roles]', 'seat', '[archived]', 'archive'])
  const sections = outline(m, open).filter(line => line.kind === 'section')
  expect(sections.map(line => line.level)).toEqual([0, 1, 0, 0, 0])
  expect(new Set(sections.map(line => line.key)).size).toBe(sections.length)
})
it('opens every fold above a thread to show it, the set-aside fold that hides it included', () => {
  const m = model(family), done = [...m.threads.values()].find(t => t.card.id === 'hub/lead/done')!
  const open = new Set(opening(m, done.key))
  const lines = outline(m, open)
  expect(lines.some(line => line.kind === 'thread' && line.thread === done)).toBe(true)
  expect(opening(m, m.root.key)).toEqual([])
})
it('holds a lone constitution with no lines under its head', () => {
  expect(outline(model([root]), new Set())).toEqual([])
})
