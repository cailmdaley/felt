import { describe, expect, it } from 'vitest'
import { planPress } from './press.js'

const context = { insideGroupBox: false, onEmptySpace: false, onStructural: false }

describe('what a press on the deck means', () => {
  it('arms a long-press on any element, with or without a group selection', () => {
    // The regression this guards: a group outline that swallows every press
    // inside it leaves the elements under it impossible to pick up and drag.
    expect(planPress(context)).toBe('element')
    expect(planPress({ ...context, insideGroupBox: true })).toBe('group-or-member')
  })

  it('drags the group from the gaps between its members', () => {
    expect(planPress({ ...context, insideGroupBox: true, onEmptySpace: true })).toBe('group')
    expect(planPress({ ...context, insideGroupBox: true, onStructural: true })).toBe('group')
  })

  it('sweeps a marquee from empty space outside any group', () => {
    expect(planPress({ ...context, onEmptySpace: true })).toBe('marquee')
  })

  it('ignores the deck scaffolding', () => {
    expect(planPress({ ...context, onStructural: true })).toBe('none')
  })
})
