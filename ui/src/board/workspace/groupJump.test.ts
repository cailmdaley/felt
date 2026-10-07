import { describe, expect, it } from 'vitest'
import { groupJump } from './groupJump.js'

type Row = { id: string; stop: string }
const rows: Row[] = [
  { id: 'r1', stop: 'review' }, { id: 'r2', stop: 'review' },
  { id: 'n1', stop: 'flight:needsYou' },
  { id: 'w1', stop: 'flight:working' }, { id: 'w2', stop: 'flight:working' },
  { id: 'l1', stop: 'lately' },
]
const at = (id: string): number => rows.findIndex(row => row.id === id)
const jump = (from: string, step: 1 | -1, memory = new Map<string, string>()): string | undefined =>
  groupJump(rows, at(from), step, row => row.stop, row => row.id, memory)?.id

describe('groupJump', () => {
  it('steps through each stop in drawn order, In flight split into its bands', () => {
    expect(jump('r2', 1)).toBe('n1')
    expect(jump('n1', 1)).toBe('w1')
    expect(jump('w2', 1)).toBe('l1')
    expect(jump('w2', -1)).toBe('n1')
    expect(jump('n1', -1)).toBe('r1')
  })
  it('skips groups with no cards', () => {
    const sparse = rows.filter(row => row.stop !== 'flight:needsYou')
    expect(groupJump(sparse, 1, 1, row => row.stop, row => row.id, new Map())?.id).toBe('w1')
  })
  it('lands on the remembered card while it is still in the stop, else the first', () => {
    expect(jump('l1', -1, new Map([['flight:working', 'w2']]))).toBe('w2')
    expect(jump('l1', -1, new Map([['flight:working', 'r2']]))).toBe('w1')
    expect(jump('l1', -1, new Map([['flight:working', 'gone']]))).toBe('w1')
  })
  it('stops at the ends and does nothing off the list', () => {
    expect(jump('r1', -1)).toBeUndefined()
    expect(jump('l1', 1)).toBeUndefined()
    expect(groupJump(rows, -1, 1, row => row.stop, row => row.id, new Map())).toBeUndefined()
  })
})
