import { describe, expect, it } from 'vitest'
import { buildChannel, compareDocuments, documentActivity, docKey } from './documents.js'

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const j = seed % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
const input = { uid: 'u', owner: 'host', name: 'Note', path: '/fiber/note.md', fiberDir: '/fiber', body: '' }
describe('channel order properties', () => {
  it('anchors prose, orders latest activity, first delivery ascending, then identity; invalid dates last', () => {
    const channel = buildChannel({ ...input,
      embeds: [{ path: 'modified.txt' }, { path: 'unknown.txt' }],
      fileModifiedAt: new Map([[docKey('host', '/fiber/modified.txt', 'host'), new Date(60).toISOString()]]),
      sent: [{ path: 'b.txt', time: 10 }, { path: 'b.txt', time: 50 }, { path: 'a.txt', time: 20 }, { path: 'a.txt', time: 50 }, { path: 'bad.txt', time: NaN }],
    })
    expect(channel.documents.map(d => d.name)).toEqual(['Note', 'modified.txt', 'b.txt', 'a.txt', 'bad.txt', 'unknown.txt'])
    expect(documentActivity(channel.documents.at(-1)!)).toBeUndefined()
  })
  it('is independent of feed and declaration permutations, including prior order', () => {
    const sent = Array.from({ length: 25 }, (_, i) => ({ path: `${i % 9}.html`, time: i % 4 ? i % 3 : NaN, session: String(i) }))
    const embeds = Array.from({ length: 9 }, (_, i) => ({ path: `${i}.html` }))
    const expected = buildChannel({ ...input, sent, embeds })
    for (let seed = 1; seed <= 100; seed++) {
      const actual = buildChannel({ ...input, sent: shuffled(sent, seed), embeds: shuffled(embeds, seed + 1), previous: { ...expected, documents: shuffled(expected.documents, seed + 2) } })
      expect(actual.documents.map(d => d.key)).toEqual(expected.documents.map(d => d.key))
      const docs = actual.documents.slice(1)
      for (const a of docs) for (const b of docs) {
        expect(Math.sign(compareDocuments(a, b)) + Math.sign(compareDocuments(b, a))).toBe(0)
        for (const c of docs) if (compareDocuments(a, b) <= 0 && compareDocuments(b, c) <= 0) expect(compareDocuments(a, c)).toBeLessThanOrEqual(0)
      }
    }
  })
})
