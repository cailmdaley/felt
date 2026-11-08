import { describe, expect, it } from 'vitest'
import source from '../../../daemon/test/fixtures/columns/cases.json?raw'
import { card } from './testFixtures.js'
import { WIRE_COLUMN } from './KanbanComposite.js'
import { threadState, type ThreadState } from './threads.js'
import type { Turn } from './turn.js'
import { ownerColumn, ownerTurn } from '../../harness/ownerLifecycle.js'

/** The cases the daemon's `Shuttle.Lifecycle` and `shuttle status --json` are held to (daemon/test/fixtures/columns). */
interface Case {
  name: string
  live: boolean
  runtime?: Record<string, unknown>
  error?: string
  column: string
  turn: Turn
  state: string
  fiber: Record<string, unknown>
}
const cases: Case[] = JSON.parse(source)

// The rails' state words, from the board's own.
const STATE: Record<ThreadState, string> = {
  waiting: 'Waiting', working: 'Working', 'to-review': 'To review', drafts: 'Draft', archived: 'Archived', resting: 'Resting', roles: 'Resting',
}

describe('the mock owner serves every shared case as the daemon does', () => {
  for (const c of cases) {
    it(c.name, () => {
      const runtime = c.runtime ?? (c.live ? { state: 'running' } : undefined)
      expect(ownerColumn(c.fiber, c.live)).toBe(c.column)
      expect(ownerTurn(c.fiber, runtime, c.error)).toBe(c.turn)
    })
  }
})

describe('the board files every served column and turn as the daemon does', () => {
  for (const c of cases) {
    it(c.name, () => {
      const served = card({
        id: 'hub/thread',
        column: WIRE_COLUMN[c.column],
        turn: c.turn,
        ...(c.live ? { workerState: 'running' } : {}),
      })
      expect(STATE[threadState(served)]).toBe(c.state)
    })
  }
})
