import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { apply, lifecycleTable, REQUESTS, STATES, stateKey, VERBS, type Verb } from '../harness/lifecycleModel.js'

const TABLE = fileURLToPath(new URL('../../daemon/test/fixtures/lifecycle/model.json', import.meta.url))
/** The table is read against a fixed instant, so it never depends on the day it was written. */
export const TABLE_NOW = Date.parse('2026-11-09T12:00:00Z')

/** One JSON line per row, so a change to the model reads as a diff of the rows it moved. */
function render(): string {
  const { states, answers } = lifecycleTable(TABLE_NOW)
  const lines = (map: Record<string, unknown>) => Object.entries(map).map(([key, value]) => `    ${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(',\n')
  return `{\n  "states": {\n${lines(states)}\n  },\n  "answers": {\n${lines(answers)}\n  }\n}\n`
}

describe('the lifecycle model', () => {
  it('is the table the daemon and the Shuttle CLI read (`npm run lifecycle:model` rewrites it)', () => {
    const want = render()
    if (process.env.UPDATE_LIFECYCLE_MODEL) writeFileSync(TABLE, want)
    expect(readFileSync(TABLE, 'utf8') === want, 'daemon/test/fixtures/lifecycle/model.json is stale: run `npm run lifecycle:model`').toBe(true)
  })

  it('names every state once', () => {
    expect(new Set(STATES.map(stateKey)).size).toBe(STATES.length)
  })

  // The model's own coherence: a verb it offers must be one some request can carry out.
  it('offers no verb that no single request can reach', () => {
    for (const s of STATES) {
      for (const verb of Object.keys(VERBS) as Verb[]) {
        if (!VERBS[verb].offered(s)) continue
        const stopped = s.worker === 'none' ? s : apply(s, { route: 'kill' }).next
        const reachable = REQUESTS.some(r => {
          const once = apply(stopped, r)
          return once.outcome === 'ok' && VERBS[verb].reached(s, once.next)
        })
        expect(reachable, `${verb} on ${stateKey(s)}`).toBe(true)
      }
    }
  })
})
