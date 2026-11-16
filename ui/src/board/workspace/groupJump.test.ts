import { describe, expect, it } from 'vitest'
import { groupJump, groupStops } from './groupJump.js'

type Row = { id: string; stop: string }
const rows: Row[] = [
  { id: 'r1', stop: 'waiting' }, { id: 'r2', stop: 'waiting' },
  { id: 'n1', stop: 'working:root' },
  { id: 'w1', stop: 'working:threads' }, { id: 'w2', stop: 'working:threads' },
  { id: 'l1', stop: 'quiet' },
]
const at = (id: string): number => rows.findIndex(row => row.id === id)
const jump = (from: string, step: 1 | -1, memory = new Map<string, string>()): string | undefined =>
  groupJump(rows, at(from), step, row => row.stop, row => row.id, memory)?.id

describe('groupJump', () => {
  it('steps through each stop in drawn order', () => {
    expect(jump('r2', 1)).toBe('n1')
    expect(jump('n1', 1)).toBe('w1')
    expect(jump('w2', 1)).toBe('l1')
    expect(jump('w2', -1)).toBe('n1')
    expect(jump('n1', -1)).toBe('r1')
  })
  it('skips groups with no cards', () => {
    const sparse = rows.filter(row => row.stop !== 'working:root')
    expect(groupJump(sparse, 1, 1, row => row.stop, row => row.id, new Map())?.id).toBe('w1')
  })
  it('lands on the remembered card while it is still in the stop, else the first', () => {
    const holding = '["working:threads",1]'
    expect(jump('l1', -1, new Map([[holding, 'w2']]))).toBe('w2')
    expect(jump('l1', -1, new Map([[holding, 'r2']]))).toBe('w1')
    expect(jump('l1', -1, new Map([[holding, 'gone']]))).toBe('w1')
  })
  it('stops at the ends and does nothing off the list', () => {
    expect(jump('r1', -1)).toBeUndefined()
    expect(jump('l1', 1)).toBeUndefined()
    expect(groupJump(rows, -1, 1, row => row.stop, row => row.id, new Map())).toBeUndefined()
  })
  it('names the same stops the index strip draws, each with its cards', () => {
    expect(groupStops(rows, row => row.stop).map(stop => [stop.caption, stop.key, stop.cards.length]))
      .toEqual([
        ['waiting', '["waiting",1]', 2],
        ['working:root', '["working:root",1]', 1],
        ['working:threads', '["working:threads",1]', 2],
        ['quiet', '["quiet",1]', 1],
      ])
  })
  it('keeps repeated caption runs distinct for the index and J/K memory', () => {
    const repeated: Row[] = [
      { id: 'd1', stop: 'Waiting on you' },
      { id: 'flight', stop: 'Working' },
      { id: 'd2', stop: 'Waiting on you' }, { id: 'd3', stop: 'Waiting on you' },
    ]
    const stops = groupStops(repeated, row => row.stop)
    expect(stops.map(stop => [stop.caption, stop.key])).toEqual([
      ['Waiting on you', '["Waiting on you",1]'],
      ['Working', '["Working",1]'],
      ['Waiting on you', '["Waiting on you",2]'],
    ])
    const memory = new Map([[stops[0].key, 'd1'], [stops[2].key, 'd3']])
    expect(groupJump(repeated, 1, 1, row => row.stop, row => row.id, memory)?.id).toBe('d3')
  })
})
