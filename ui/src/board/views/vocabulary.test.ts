import { describe, expect, it } from 'vitest'
import {
  MARK_GLYPH,
  STATE_GLYPH,
  STATE_KEY_ITEMS,
  STATE_WORD,
  cardState,
  type LifecycleState,
  type StateBearing,
} from './vocabulary.js'

const card = (over: Partial<StateBearing> = {}): StateBearing => ({
  status: 'open',
  ...over,
})

describe('cardState', () => {
  it('reads a closed fiber by its verdict', () => {
    expect(cardState(card({ status: 'closed', tempered: true }))).toBe('tempered')
    expect(cardState(card({ status: 'closed', tempered: false }))).toBe('composted')
    expect(cardState(card({ status: 'closed' }))).toBe('awaitingReview')
  })

  it('asks closed FIRST — a finished fiber keeps the block that ran it', () => {
    // Every field below would otherwise claim the card: a live worker, a
    // pinned kind, a stash. None of them outranks a verdict.
    expect(
      cardState({
        status: 'closed',
        tempered: true,
        runningWorker: 'sess-1',
        shuttleKind: 'pinned',
        effectiveHorizon: 'stashed',
      }),
    ).toBe('tempered')
  })

  it('calls a running worker in flight, whatever the fiber does at rest', () => {
    expect(cardState(card({ runningWorker: 'sess-1' }))).toBe('inFlight')
    expect(cardState(card({ runningWorker: 'sess-1', shuttleKind: 'pinned' }))).toBe('inFlight')
    expect(cardState(card({ runningWorker: 'sess-1', shuttleKind: 'standing' }))).toBe('inFlight')
    expect(cardState(card({ runningWorker: 'sess-1', effectiveHorizon: 'stashed' }))).toBe(
      'inFlight',
    )
  })

  it('folds the three ways of being off the desk into resting', () => {
    expect(cardState(card({ effectiveHorizon: 'stashed' }))).toBe('resting')
    expect(cardState(card({ status: 'active', shuttleKind: 'pinned' }))).toBe('resting')
    expect(cardState(card({ shuttleKind: 'pinned' }))).toBe('resting')
    // An armed standing role fires on its own cron — nothing owed until it does.
    expect(cardState(card({ status: 'active', shuttleKind: 'standing' }))).toBe('resting')
  })

  it('calls an armed one-shot in flight before any worker exists', () => {
    expect(cardState(card({ status: 'active' }))).toBe('inFlight')
    expect(cardState(card({ status: 'active', shuttleKind: 'oneshot' }))).toBe('inFlight')
  })

  it('falls through to draft', () => {
    expect(cardState(card())).toBe('draft')
    expect(cardState(card({ shuttleKind: 'oneshot' }))).toBe('draft')
    expect(cardState(card({ status: 'something-new' }))).toBe('draft')
  })
})

describe('the state vocabulary', () => {
  const states = Object.keys(STATE_GLYPH) as LifecycleState[]

  it('gives every state a glyph and a word, and lists each once in the key', () => {
    for (const state of states) {
      expect(STATE_GLYPH[state]).toBeTruthy()
      expect(STATE_WORD[state]).toBeTruthy()
    }
    expect([...STATE_KEY_ITEMS].sort()).toEqual([...states].sort())
  })

  it('spends no glyph twice, and none on an obligation', () => {
    const glyphs = states.map((s) => STATE_GLYPH[s])
    expect(new Set(glyphs).size).toBe(glyphs.length)
    for (const mark of Object.values(MARK_GLYPH)) expect(glyphs).not.toContain(mark)
  })
})
