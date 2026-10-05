// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { DocumentSeen } from './DocumentSeen.js'
import { buildChannel } from './documents.js'
const input = { uid: 'u', owner: 'host', name: 'Note', path: '/note.md', fiberDir: '/', body: '' }
beforeEach(() => {
  vi.restoreAllMocks()
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => values.set(key, value)) })
})
it('establishes a quiet baseline, persists per document, and clears only the selected mark', () => {
  const first = buildChannel({ ...input, sent: [{ path: '/a.html', time: 1 }] })
  const seen = new DocumentSeen()
  expect(seen.observe(first, first.documents[0].key).size).toBe(0)
  const next = buildChannel({ ...input, sent: [{ path: '/a.html', time: Date.now() + 10000 }, { path: '/b.html', time: Date.now() + 10000 }] })
  expect(new DocumentSeen().observe(next, next.documents[0].key).size).toBe(2)
  expect(seen.observe(next, next.documents[1].key).size).toBe(1)
  expect(new DocumentSeen().observe(next, next.documents[0].key).size).toBe(1)
})
it('waits for the complete first channel and tolerates denied storage', () => {
  vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('denied') })
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('denied') })
  const seen = new DocumentSeen()
  const first = buildChannel(input)
  expect(seen.observe(first, first.documents[0].key, false).size).toBe(0)
  const loaded = buildChannel({ ...input, sent: [{ path: '/a.html', time: 1 }] })
  expect(seen.observe(loaded, loaded.documents[0].key).size).toBe(0)
  const next = buildChannel({ ...input, sent: [{ path: '/a.html', time: Date.now() + 10000 }] })
  expect(seen.observe(next, next.documents[0].key).size).toBe(1)
})
