import { describe, expect, it } from 'vitest'
import { offeredVerbs, STATES, stateKey, VERBS, type Verb } from '../../harness/lifecycleModel.js'
import { modelCard } from './testFixtures.js'
import { lifecycleVerbsFor, verbSpec } from './workspace/lifecycleVerbs.js'
import { constitutionAction } from './workspace/fiberPageState.js'
import type { KeyIntent } from './keymap.js'

const VERB_ORDER: Verb[] = ['review', 'rest', 'temper', 'discard']
const INTENT: Record<Verb, KeyIntent> = { review: 'toReview', rest: 'rest', temper: 'temper', discard: 'discard' }

describe('the board offers what the lifecycle model offers, in its words', () => {
  for (const s of STATES) {
    it(stateKey(s), () => {
      const card = modelCard(s)
      const want = offeredVerbs(s).map(verb => `${verb}:${VERBS[verb].label(s)}`)
      // The Desk row's menu and the reader's header both draw from the reachable set.
      const offered = lifecycleVerbsFor(card, true).map(verb => `${verb}:${verbSpec(verb, card).label}`)
      expect(offered).toEqual(want)
      // A verb's key reaches the card exactly when the verb is offered.
      const keyed = VERB_ORDER.filter(verb => constitutionAction(INTENT[verb], card, { verdict() {}, conversation() {}, rest() {} }))
      expect(keyed.map(verb => `${verb}:${verbSpec(verb, card).label}`).sort()).toEqual([...want].sort())
    })
  }
})
