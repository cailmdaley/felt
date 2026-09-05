// The back gesture's state machine.
//
// Every case here is a bug the naive version had: a self-issued back read as
// the user's, a reopen racing its own release, a buried layer popping the
// sheet above it. The driver is a pair of spies, so none of this needs a real
// History object.

import { describe, expect, it } from 'vitest'
import { SheetHistory } from './sheetHistory.js'

const spied = (): { h: SheetHistory; log: string[] } => {
  const log: string[] = []
  const h = new SheetHistory({
    push: () => log.push('push'),
    back: () => log.push('back'),
  })
  return { h, log }
}

describe('SheetHistory', () => {
  it('pushes on open and gives the entry back on close', () => {
    const { h, log } = spied()
    h.set('detail', true)
    expect(log).toEqual(['push'])
    h.set('detail', false)
    expect(log).toEqual(['push', 'back'])
    expect(h.depth).toBe(0)
  })

  it('is idempotent in both directions', () => {
    const { h, log } = spied()
    h.set('detail', true)
    h.set('detail', true)
    h.set('detail', false)
    h.set('detail', false)
    expect(log).toEqual(['push', 'back'])
  })

  // The bug: history.back() fires a popstate a tick later, which the naive
  // handler read as the user pressing back and used to close the NEXT sheet.
  it('swallows the pop caused by its own back', () => {
    const { h } = spied()
    h.set('detail', true)
    h.set('detail', false)
    expect(h.popped()).toBeNull()
  })

  it('reports the top layer when the user actually presses back', () => {
    const { h } = spied()
    h.set('detail', true)
    h.set('viewer', true)
    expect(h.popped()).toBe('viewer')
    expect(h.depth).toBe(1)
    expect(h.popped()).toBe('detail')
    expect(h.popped()).toBeNull()
  })

  // A user-pressed back already consumed the entry, so the layer must NOT
  // issue one of its own while closing.
  it('does not issue a back for a layer the user already popped', () => {
    const { h, log } = spied()
    h.set('detail', true)
    h.popped()
    h.set('detail', false)
    expect(log).toEqual(['push'])
  })

  // THE RACE. open() begins with close(); released and re-pushed, the queued
  // pop takes the new panel down with it. A swap keeps the entry instead.
  it('keeps one entry across a close-then-open swap, with no history calls', () => {
    const { h, log } = spied()
    h.set('detail', true)
    log.length = 0
    h.swap('detail', () => {
      h.set('detail', false) // the inner close
      h.set('detail', true) // the new content
    })
    expect(log).toEqual([])
    expect(h.holds('detail')).toBe(true)
    expect(h.depth).toBe(1)
  })

  it('leaves a layer closed when the swap never reopens it', () => {
    const { h, log } = spied()
    h.set('detail', true)
    log.length = 0
    h.swap('detail', () => h.set('detail', false))
    // The deferral ends with the swap; the layer is still held, and a real
    // close after it releases normally.
    h.set('detail', false)
    expect(log).toEqual(['back'])
    expect(h.depth).toBe(0)
  })

  it('nests swaps without releasing early', () => {
    const { h, log } = spied()
    h.set('detail', true)
    log.length = 0
    h.swap('detail', () => {
      h.swap('detail', () => h.set('detail', false))
      expect(h.holds('detail')).toBe(true)
    })
    expect(log).toEqual([])
  })

  // History cannot remove an entry from the middle, and a back issued for a
  // buried layer would pop the sheet on top of it.
  it('gives up a buried layer’s claim without issuing a back', () => {
    const { h, log } = spied()
    h.set('detail', true)
    h.set('viewer', true)
    log.length = 0
    h.set('detail', false)
    expect(log).toEqual([])
    expect(h.holds('viewer')).toBe(true)
    // The viewer is now the only claim, and closing it does give one back.
    h.set('viewer', false)
    expect(log).toEqual(['back'])
  })

  it('unwinds a three-sheet stack newest first', () => {
    const { h } = spied()
    h.set('detail', true)
    h.set('viewer', true)
    h.set('linked', true)
    expect(h.popped()).toBe('linked')
    expect(h.popped()).toBe('viewer')
    expect(h.popped()).toBe('detail')
    expect(h.depth).toBe(0)
  })
})
