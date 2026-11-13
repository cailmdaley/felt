import { describe, expect, it } from 'vitest'
import {
  MARK_GLYPH,
  STATE_GLYPH,
  STATE_KEY_ITEMS,
  STATE_WORD,
  cardState,
  diffClause,
  sumDiff,
  type LifecycleState,
} from './vocabulary.js'
import type { DeskColumn } from '../KanbanTypes.js'

describe('cardState', () => {
  it('reads every served column as the state a row names', () => {
    const states: Record<DeskColumn, LifecycleState> = {
      drafts: 'draft', inFlight: 'inFlight', awaitingReview: 'awaitingReview',
      tempered: 'tempered', composted: 'discarded',
      // Off the desk, or a thread with its orchestrator, is one claim on a row: nothing owed now.
      resting: 'resting', roles: 'resting', orchestratorReview: 'resting',
    }
    for (const [column, state] of Object.entries(states)) expect(cardState({ column: column as DeskColumn })).toBe(state)
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


describe('diffClause', () => {
  it('sets the diffstat insertions first, with a true minus sign', () => {
    expect(diffClause(512, 208)).toBe('+512 −208')
  })

  it('drops each side independently — a pure deletion adds nothing', () => {
    expect(diffClause(0, 208)).toBe('−208')
    expect(diffClause(512, 0)).toBe('+512')
  })

  it('prints nothing at all when the ledger recorded no change', () => {
    expect(diffClause(0, 0)).toBe('')
  })

  it('keeps big figures exact — a line count is checkable against git', () => {
    expect(diffClause(12345, 6789)).toBe('+12345 −6789')
  })
})

describe('sumDiff', () => {
  it('adds up what the ledger recorded', () => {
    expect(sumDiff([{ insertions: 10, deletions: 2 }, { insertions: 5, deletions: 0 }])).toEqual({
      insertions: 15,
      deletions: 2,
    })
  })

  it('sums an empty run to zeros, which print as no clause', () => {
    const total = sumDiff([])
    expect(total).toEqual({ insertions: 0, deletions: 0 })
    expect(diffClause(total.insertions, total.deletions)).toBe('')
  })
})
