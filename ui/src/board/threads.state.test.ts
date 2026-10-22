import { describe, expect, it } from 'vitest'
import { card } from './testFixtures.js'
import { ThreadIndex, threadState } from './threads.js'

describe('thread state honours the live worker before the draft rule', () => {
  it('an open constitution whose live worker is stopped on a prompt is waiting on Cail', () => {
    expect(threadState(card({ id: 'a', status: 'open', workerState: 'running', runtimePhase: 'attention' }))).toBe('waiting-cail')
    expect(threadState(card({ id: 'b', status: 'open', workerState: 'running', runtimePhase: 'waiting' }))).toBe('waiting-cail')
    expect(threadState(card({ id: 'c', status: 'open', workerState: 'blocked' }))).toBe('waiting-cail')
  })
  it('an open constitution whose live worker is mid-turn is working, resting horizon or not', () => {
    expect(threadState(card({ id: 'a', status: 'open', workerState: 'running', runtimePhase: 'working' }))).toBe('working')
    expect(threadState(card({ id: 'b', status: 'open', effectiveHorizon: 'stashed', workerState: 'running', runtimePhase: 'working' }))).toBe('working')
  })
  it('without a live worker an open constitution is a draft or resting, whatever stale runtime it carries', () => {
    expect(threadState(card({ id: 'a', status: 'open' }))).toBe('drafts')
    expect(threadState(card({ id: 'b', status: 'open', effectiveHorizon: 'stashed' }))).toBe('resting')
    expect(threadState(card({ id: 'c', status: 'open', runtimePhase: 'attention' }))).toBe('drafts')
  })
  it('the family badge counts such a thread as waiting', () => {
    const root = card({ id: 'hub', status: 'active' })
    const child = card({ id: 'hub/child', orchestrator: 'hub', status: 'open', workerState: 'running', runtimePhase: 'attention' })
    expect(new ThreadIndex([root, child]).summary(root)).toMatchObject({ waitingOnCail: 1, drafts: 0 })
  })
})
