import { describe, expect, it } from 'vitest'
import claudeSource from './fixtures/claude-usage.jsonl?raw'
import codexSource from './fixtures/codex-usage.jsonl?raw'
import piSource from './fixtures/pi-usage.jsonl?raw'
import codexResetSource from './fixtures/codex-compaction-reset.jsonl?raw'
import { normalizeRecord, type Entry } from './records.js'
import { TranscriptModel } from './model.js'

const records = (source: string): Record<string, any>[] => source.trim().split('\n').map((line) => JSON.parse(line))
const claude = records(claudeSource)
const codex = records(codexSource)
const pi = records(piSource)
const modelFor = (...raw: unknown[]): TranscriptModel => {
  const model = new TranscriptModel()
  model.append(raw.flatMap(normalizeRecord))
  return model
}
const usage = (at: number, cache: { read: number; write: number; hourWrite: number }): Entry => ({ kind: 'usage', at, cache })

describe('native transcript head facts', () => {
  it('reads disjoint Claude input counts, model and hour TTL from a sanitized captured line', () => {
    expect(modelFor(claude[0]).stats()).toMatchObject({
      model: 'claude-opus-5-5', context: 53327,
      cacheUntil: Date.parse(claude[0].timestamp) + 3_600_000,
    })
    expect(modelFor(claude[0]).stats().window).toBeUndefined()
  })

  it('uses only Codex last usage and recorded effective window, never double counts cached input', () => {
    expect(modelFor(codex[0]).stats()).toMatchObject({ context: 20915, window: 258400 })
    expect(modelFor(codex[0]).stats().cacheUntil).toBeUndefined()
    const next = structuredClone(codex[0])
    next.payload.info.total_token_usage.input_tokens = 999999
    next.payload.info.last_token_usage.input_tokens = 12345
    expect(modelFor(codex[0], next).stats().context).toBe(12345)
  })

  it('reads Pi input plus cache counts, excluding output/reasoning/total and omitting unrecorded TTL/window', () => {
    const stats = modelFor(pi[0]).stats()
    expect(stats).toMatchObject({ model: 'gpt-6-luna', context: 16767 })
    expect(stats.window).toBeUndefined()
    expect(stats.cacheUntil).toBeUndefined()
  })

  it('invalidates pre-compaction counts; only Claude has an explicit after count', () => {
    expect(modelFor(claude[0], claude[2]).stats().context).toBe(24705)
    expect(modelFor(codex[0], codex[1]).stats().context).toBeUndefined()
    expect(modelFor(pi[0], pi[1]).stats().context).toBeUndefined()
    expect(modelFor(pi[0], pi[1], pi[0]).stats().context).toBe(16767)
    expect(modelFor(claude[0], claude[2]).stats().cacheUntil).toBeUndefined()
  })

  it('keeps context unknown across Codex compaction and reset-only placeholders in separate append batches', () => {
    const [compacted, placeholder, genuine] = records(codexResetSource)
    const model = modelFor(codex[0])
    expect(model.stats().context).toBe(20915)
    model.append(normalizeRecord(compacted))
    expect(model.stats().context).toBeUndefined()
    model.append(normalizeRecord(placeholder))
    expect(model.stats().context).toBeUndefined()
    expect(model.stats().window).toBe(258400)
    model.append(normalizeRecord(genuine))
    expect(model.stats().context).toBe(43002)
    expect(model.stats().window).toBe(258400)
  })

  it('refreshes hour TTL on a read while active, but an expired hour write is not sticky', () => {
    const model = new TranscriptModel()
    model.append([usage(0, { read: 0, write: 100, hourWrite: 100 })])
    model.append([usage(3_000_000, { read: 100, write: 0, hourWrite: 0 })])
    expect(model.stats().cacheUntil).toBe(6_600_000)
    model.append([usage(7_000_000, { read: 100, write: 0, hourWrite: 0 })])
    expect(model.stats().cacheUntil).toBe(7_300_000)
    model.append([usage(7_100_000, { read: 0, write: 50, hourWrite: 0 })])
    expect(model.stats().cacheUntil).toBe(7_400_000)
  })

  it('defaults a read with no preceding write evidence to five minutes', () => {
    const stats = modelFor(claude[1]).stats()
    expect(stats.cacheUntil).toBe(Date.parse(claude[1].timestamp) + 300_000)
  })

  it('does not fabricate context from missing or invalid counters and clears facts on reset', () => {
    const record = structuredClone(pi[0])
    delete record.message.usage.cacheRead
    expect(modelFor(record).stats().context).toBeUndefined()
    record.message.usage.cacheRead = -1
    expect(modelFor(record).stats().context).toBeUndefined()
    const model = modelFor(claude[0])
    model.reset()
    expect(model.stats().context).toBeUndefined()
    expect(model.stats().cacheUntil).toBeUndefined()
  })

  it('ignores sidechains and Pi error/aborted zero usage', () => {
    expect(modelFor({ ...claude[0], isSidechain: true }).stats().context).toBeUndefined()
    const record = structuredClone(pi[0])
    record.message.stopReason = 'error'
    expect(modelFor(record).stats().context).toBeUndefined()
  })
})
