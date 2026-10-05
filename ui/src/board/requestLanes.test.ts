import { afterEach, describe, expect, it } from 'vitest'
import { inLane, laneSlots, resetLanes } from './requestLanes.js'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve() }

afterEach(() => resetLanes())

describe('request lanes', () => {
  it('leaves HTTP/1.1 connections for the page: one slow read and two quiet ones', () => {
    expect([laneSlots('slow', false), laneSlots('quiet', false)]).toEqual([1, 2])
    expect(laneSlots('slow', true)).toBeGreaterThan(1)
    expect(laneSlots('quiet', true)).toBeGreaterThan(2)
  })

  it('holds a slot until the job settles, then runs the lowest rank in arrival order', async () => {
    const started: string[] = []
    const gates = new Map<string, ReturnType<typeof deferred>>()
    const job = (name: string, rank: number) => {
      const gate = deferred(); gates.set(name, gate)
      return inLane('quiet', async () => { started.push(name); await gate.promise }, { rank })
    }
    void job('a', 2); void job('b', 2); void job('late', 2); void job('urgent', 0); void job('later', 2)
    await settle()
    expect(started).toEqual(['a', 'b'])
    gates.get('a')!.resolve(); await settle()
    expect(started).toEqual(['a', 'b', 'urgent'])
    gates.get('b')!.resolve(); gates.get('urgent')!.resolve(); await settle()
    expect(started).toEqual(['a', 'b', 'urgent', 'late', 'later'])
  })

  it('frees a slot when a job throws and skips a job aborted while queued', async () => {
    const gate = deferred()
    const first = inLane('slow', async () => { await gate.promise; throw new Error('owner unreachable') })
    const controller = new AbortController()
    let ran = false
    const skipped = inLane('slow', async () => { ran = true }, { signal: controller.signal })
    const next = inLane('slow', async () => 'read')
    controller.abort()
    await expect(skipped).rejects.toBeDefined()
    gate.resolve()
    await expect(first).rejects.toThrow('owner unreachable')
    await expect(next).resolves.toBe('read')
    expect(ran).toBe(false)
  })
})
