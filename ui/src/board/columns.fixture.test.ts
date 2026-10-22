import { describe, expect, it } from 'vitest'
import source from '../../../daemon/test/fixtures/columns/cases.json?raw'
import { card } from './testFixtures.js'
import { deskColumn } from './deskColumn.js'
import { threadState, type ThreadState } from './threads.js'
import { effectiveHorizon } from './KanbanRules.js'
import type { ShuttleKind } from './KanbanTypes.js'

/** The cases the daemon's roster and `shuttle status --json` are held to (daemon/test/fixtures/columns). */
interface Case {
  name: string
  live: boolean
  column: string
  state: string
  fiber: { status?: string; tempered?: boolean; horizon?: string; due?: string; shuttle: { kind: ShuttleKind; seat?: boolean; role?: string; ask?: { text: string; at: string } } }
}
const cases: Case[] = JSON.parse(source)

// The wire's column names and the roster's state words, from the board's own.
const COLUMN: Record<string, string> = {
  drafts: 'drafts', inFlight: 'in_flight', awaitingReview: 'awaiting_review', tempered: 'tempered',
  composted: 'discarded', resting: 'resting', scheduled: 'resting', roles: 'roles',
}
const STATE: Record<ThreadState, string> = {
  waiting: 'Waiting', working: 'Working', 'to-review': 'To review', drafts: 'Draft', archived: 'Archived', resting: 'Resting', roles: 'Resting',
}

describe('the board files every shared column case as the daemon and the CLI do', () => {
  for (const c of cases) {
    it(c.name, () => {
      const { fiber } = c
      const kanban = card({
        id: 'hub/thread',
        status: fiber.status ?? '',
        tempered: fiber.tempered,
        shuttleKind: fiber.shuttle.kind,
        shuttleSeat: fiber.shuttle.seat,
        shuttleRole: fiber.shuttle.role,
        ask: fiber.shuttle.ask,
        effectiveHorizon: effectiveHorizon({ due: fiber.due, horizon: fiber.horizon }).effectiveHorizon,
        ...(c.live ? { workerState: 'running', runtimePhase: 'working', lastActivityAt: Date.now() } : {}),
      })
      expect(COLUMN[deskColumn(kanban)]).toBe(c.column)
      expect(STATE[threadState(kanban)]).toBe(c.state)
    })
  }
})
