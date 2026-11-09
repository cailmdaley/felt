import { describe, expect, it } from 'vitest'
import { ownerRow, STATES, stateKey, VERBS, type LifeState, type Verb } from '../../harness/lifecycleModel.js'
import { parseCompositeFeed } from './KanbanComposite.js'
import { cardFromCompositeEntry } from './KanbanReadModel.js'
import type { KanbanCard } from './KanbanTypes.js'
import { lifecycleVerbsFor, verbSpec } from './workspace/lifecycleVerbs.js'
import { constitutionAction } from './workspace/fiberPageState.js'
import type { KeyIntent } from './keymap.js'

const NOW = Date.parse('2026-11-09T12:00:00Z')

/** The card the board builds from the row the owner serves for a state. */
export function modelCard(s: LifeState, id = 'model/fiber', nowMs = NOW): KanbanCard {
  const feed = parseCompositeFeed({ host: 'local', fibers: [ownerRow(id, s, nowMs)] })
  return cardFromCompositeEntry(feed.entries[0], nowMs)
}

const VERB_ORDER: Verb[] = ['review', 'rest', 'temper', 'discard']
const INTENT: Record<Verb, KeyIntent> = { review: 'toReview', rest: 'rest', temper: 'temper', discard: 'discard' }

describe('the board offers what the lifecycle model offers, in its words', () => {
  for (const s of STATES) {
    it(stateKey(s), () => {
      const card = modelCard(s)
      const want = VERB_ORDER.filter(verb => VERBS[verb].offered(s)).map(verb => `${verb}:${VERBS[verb].label(s)}`)
      // The Desk row's menu and the reader's header both draw from the reachable set.
      const offered = lifecycleVerbsFor(card, true).map(verb => `${verb}:${verbSpec(verb, card).label}`)
      expect(offered).toEqual(want)
      // A verb's key reaches the card exactly when the verb is offered.
      const keyed = VERB_ORDER.filter(verb => constitutionAction(INTENT[verb], card, { verdict() {}, conversation() {}, rest() {} }))
      expect(keyed.map(verb => `${verb}:${verbSpec(verb, card).label}`)).toEqual(want)
    })
  }
})
