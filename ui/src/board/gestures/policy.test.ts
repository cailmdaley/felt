import { describe, expect, it } from 'vitest'
import { pickTarget, planPress, type HitOutcome } from './policy.js'

const el = (area: number, extra: Partial<{ structural: boolean; interactive: boolean }> = {}) =>
  ({ area, structural: false, interactive: false, ...extra })
const SLIDE = 1280 * 720

describe('what the pointer is on', () => {
  it('takes the innermost real element, not the container it sits in', () => {
    expect(pickTarget([el(4_000), el(90_000), el(SLIDE, { structural: true })], SLIDE)).toEqual({ kind: 'element', index: 0 })
  })

  it('skips scaffolding and any box covering most of the slide', () => {
    // Cail's complaint: pressing a slide grabbed the section or a full-bleed
    // wrapper instead of the paragraph he aimed at.
    const chain = [el(SLIDE * 0.95), el(SLIDE, { structural: true }), el(SLIDE * 0.2)]
    expect(pickTarget(chain, SLIDE)).toEqual({ kind: 'element', index: 2 })
  })

  it('hands controls back to the deck', () => {
    expect(pickTarget([el(600, { interactive: true }), el(9_000)], SLIDE)).toEqual({ kind: 'pass-through' })
  })

  it('calls bare slide background empty', () => {
    expect(pickTarget([el(SLIDE, { structural: true })], SLIDE)).toEqual({ kind: 'empty' })
    expect(pickTarget([], SLIDE)).toEqual({ kind: 'empty' })
  })
})

describe('what a press means', () => {
  const base = { insideGroupBox: false, insideSelectionBox: false, onSelection: false }
  const on: HitOutcome = { kind: 'element', index: 0 }
  const empty: HitOutcome = { kind: 'empty' }

  it('picks an element up on the press, with no long-press to wait out', () => {
    expect(planPress({ ...base, hit: on })).toBe('element')
  })

  it('keeps a group whole: every press inside its outline moves it', () => {
    expect(planPress({ ...base, hit: on, insideGroupBox: true })).toBe('group')
    expect(planPress({ ...base, hit: empty, insideGroupBox: true })).toBe('group')
  })

  it('moves a single selection from its own box, and swaps to another element', () => {
    expect(planPress({ ...base, hit: on, onSelection: true, insideSelectionBox: true })).toBe('selection')
    expect(planPress({ ...base, hit: empty, insideSelectionBox: true })).toBe('selection')
    expect(planPress({ ...base, hit: on, insideSelectionBox: true })).toBe('element')
  })

  it('sweeps a marquee from background, and never touches a control', () => {
    expect(planPress({ ...base, hit: empty })).toBe('marquee')
    expect(planPress({ ...base, hit: { kind: 'pass-through' } })).toBe('none')
    expect(planPress({ ...base, hit: { kind: 'pass-through' }, insideGroupBox: true })).toBe('none')
  })
})
