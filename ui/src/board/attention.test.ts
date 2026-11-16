import { describe, expect, it } from 'vitest'
import { attentionOf, quietWord, wantOf, type Waits } from './attention.js'
import type { Wait } from './boardFeed.js'
import type { KanbanCard } from './KanbanTypes.js'
import { card } from './testFixtures.js'

const constitution = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard => card({ uid: over.id, shuttleKind: 'oneshot', ...over })
const none: Waits = new Map()
const waits = (uid: string, wait: Wait): Waits => new Map([[uid, wait]])

describe('a constitution waits on the human when something addressed to them stands', () => {
  it('a line the board says nothing handled waits, a post included, once its record is known', () => {
    const quiet = constitution({ id: 'chair', status: 'active' })
    const post = waits('chair', { id: 'p1', at: 5_000, kind: 'post', text: 'The new beam is in.' })
    expect(attentionOf(quiet, post)).toBe('waiting')
    expect(wantOf(quiet, post)).toMatchObject({ kind: 'post', text: 'The new beam is in.', at: 5_000 })
  })
  it('a line whose record is not read yet still waits', () => {
    expect(attentionOf(constitution({ id: 'chair', status: 'active' }), waits('chair', { id: 'p1', at: 5_000 }))).toBe('waiting')
  })
  it('a cleared post does not wait: the board stops naming it', () => {
    expect(attentionOf(constitution({ id: 'chair', status: 'active' }), none)).toBe('quiet')
  })
  it('an open ask with no board record waits, with the ask as its want', () => {
    const asking = constitution({ id: 'mask', status: 'active', ask: { text: 'Which mask?', at: '2026-11-10T09:00:00Z' } })
    expect(attentionOf(asking, none)).toBe('waiting')
    expect(wantOf(asking, none)).toMatchObject({ kind: 'ask', text: 'Which mask?', at: Date.parse('2026-11-10T09:00:00Z') })
  })
  it('a close for review beyond the board\'s reach waits, with the review mark\'s note or "for review"', () => {
    const closed = constitution({ id: 'cov', status: 'closed', closedAt: '2026-11-01T09:00:00Z' })
    expect(closed.column).toBe('awaitingReview')
    expect(wantOf(closed, none)).toMatchObject({ kind: 'review', text: 'for review' })
    expect(wantOf({ ...closed, reviewMark: { note: 'Check the null tests.', at: '2026-11-01T09:00:00Z' } }, none)).toMatchObject({ kind: 'review', text: 'Check the null tests.' })
  })
  it('a worker stopped on a harness prompt waits', () => {
    const prompt = constitution({ id: 'fit', status: 'active', workerState: 'running', runtimePhase: 'attention' })
    expect(attentionOf(prompt, none)).toBe('waiting')
    expect(wantOf(prompt, none)?.kind).toBe('ask')
  })
  it('a turn that could not start waits, saying why', () => {
    const blocked = constitution({ id: 'run', status: 'active', workerState: 'blocked', launchError: 'no project directory' })
    expect(attentionOf(blocked, none)).toBe('waiting')
    expect(wantOf(blocked, none)).toMatchObject({ kind: 'blocked', text: 'no project directory' })
  })
})

describe('everything else is working or quiet', () => {
  it('an idle live worker that asked nothing is working, not waiting', () => {
    const idle = constitution({ id: 'idle', status: 'active', workerState: 'running', runtimePhase: 'waiting' })
    expect(idle.turn).toBe('idle')
    expect(attentionOf(idle, none)).toBe('working')
  })
  it('a close its orchestrator reviews is quiet', () => {
    const thread = constitution({ id: 'hub/fit', orchestrator: 'hub', status: 'closed', closedAt: '2026-11-10T09:00:00Z', column: 'orchestratorReview' })
    expect(attentionOf(thread, none)).toBe('quiet')
  })
  it('a verdict settles a line the board still names', () => {
    const tempered = constitution({ id: 'done', status: 'closed', tempered: true })
    expect(attentionOf(tempered, waits('done', { id: 'c', at: 1, kind: 'closed' }))).toBe('quiet')
  })
  it('a quiet constitution says at most a faint word', () => {
    expect(quietWord(constitution({ id: 'd', status: 'open' }))).toBe('draft')
    expect(quietWord(constitution({ id: 'r', status: 'open', effectiveHorizon: 'stashed' }))).toBe('resting')
    expect(quietWord(constitution({ id: 's', status: 'open', effectiveHorizon: 'stashed', shuttleSeat: true, shuttleRole: 'chair' }))).toBe('seat')
    expect(quietWord(constitution({ id: 'h', status: 'active', held: true }))).toBe('held')
  })
})
