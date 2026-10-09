// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { normalizeRecord } from '../src/board/transcript/records.js'
import { workspaceExample, WORKSPACE_UID, WORKSPACE_ID } from './workspace-fixtures.js'
import {
  WORKSPACE_EARLIER_SESSION,
  WORKSPACE_LATEST_SESSION,
  workspaceTranscriptBytes,
} from './transcript-fixtures.js'

const NOW = Date.parse('2026-10-04T14:00:00Z')

describe('fictional workspace transcripts', () => {
  it('uses valid UUIDs and keeps the latest ledger session aligned with the card runtime', () => {
    for (const session of [WORKSPACE_LATEST_SESSION, WORKSPACE_EARLIER_SESSION]) {
      expect(session).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    }
    const example = workspaceExample(NOW, { transcriptScenario: 'live' })
    const row = example.feed.fibers.find(entry => (entry.fiber as { uid?: string }).uid === WORKSPACE_UID)!
    const fiber = row.fiber as { id: string; status: string; shuttle: { runtime: { session_uuid: string } } }
    expect(fiber.id).toBe(WORKSPACE_ID)
    expect(fiber.status).toBe('active')
    expect(fiber.shuttle.runtime.session_uuid).toBe(WORKSPACE_LATEST_SESSION)
    expect((row.runtime as { session_uuid: string }).session_uuid).toBe(WORKSPACE_LATEST_SESSION)
    expect(example.sessions[0].session).toBe(WORKSPACE_LATEST_SESSION)

    const ordinary = workspaceExample(NOW).feed.fibers.find(entry => (entry.fiber as { id?: string }).id === WORKSPACE_ID)!
    expect((ordinary.fiber as { status: string }).status).toBe('closed')
  })

  it('adds live records as a byte-stable suffix', () => {
    const before = workspaceTranscriptBytes('live', NOW)
    const after = workspaceTranscriptBytes('live', NOW, { updates: 1 })
    expect(after.byteLength).toBeGreaterThan(before.byteLength)
    expect(after.slice(0, before.byteLength)).toEqual(before)
    const added = new TextDecoder()
      .decode(after.slice(before.byteLength))
      .trim()
      .split('\n')
      .map(value => JSON.parse(value) as unknown)
    expect(added.flatMap(normalizeRecord)).toEqual([
      { kind: 'prompt', text: 'Append live fixture update 1; do not replace the prior result.', images: 0, dispatch: false, at: NOW },
      { kind: 'text', text: 'Live worker update 1: the next fictional validation batch is in progress.', model: 'claude-opus-4-1', at: NOW + 500 },
    ])
  })

  it('stages a multi-megabyte transcript with thousands of prompt-bounded turns', () => {
    const bytes = workspaceTranscriptBytes('large', NOW)
    const text = new TextDecoder().decode(bytes)
    const records = text.trim().split('\n').map(value => JSON.parse(value) as unknown)
    expect(bytes.byteLength).toBeGreaterThan(1_000_000)
    expect(records).toHaveLength(12_000)
    expect(records.flatMap(normalizeRecord).filter(entry => entry.kind === 'prompt')).toHaveLength(3000)
  })
})
