import { describe, expect, it } from 'vitest'
import { buildChannel, compareDocuments, documentActivity, docKey, firstSent } from './documents.js'

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
  it('anchors prose, then unsent declarations in body order, then sends by first delivery; unknown times last', () => {
    const channel = buildChannel({ ...input,
      embeds: [{ path: 'zeta.txt' }, { path: 'alpha.txt' }, { path: 'sent-embed.txt' }],
      fileModifiedAt: new Map([[docKey('host', '/fiber/alpha.txt', 'host'), new Date(600).toISOString()]]),
      sent: [{ path: 'b.txt', time: 10 }, { path: 'b.txt', time: 90 }, { path: 'a.txt', time: 20 }, { path: 'sent-embed.txt', time: 30 }, { path: 'bad.txt', time: NaN }],
      links: [{ path: 'linked.txt' }],
    })
    expect(channel.documents.map(d => d.name)).toEqual(['Note', 'zeta.txt', 'alpha.txt', 'linked.txt', 'b.txt', 'a.txt', 'sent-embed.txt', 'bad.txt'])
    expect(firstSent(channel.documents.at(-1)!)).toBeUndefined()
    expect(documentActivity(channel.documents.find(d => d.name === 'b.txt')!)).toBe(90)
  })
  it('a re-send never moves a document', () => {
    const before = buildChannel({ ...input, sent: [{ path: 'old.html', time: 10 }, { path: 'new.html', time: 20 }] })
    const after = buildChannel({ ...input, previous: before, sent: [{ path: 'old.html', time: 10 }, { path: 'new.html', time: 20 }, { path: 'old.html', time: 99 }] })
    expect(after.documents.map(d => d.name)).toEqual(['Note', 'old.html', 'new.html'])
  })
  it('is independent of feed permutations and prior order, and the comparator is a total order', () => {
    const sent = Array.from({ length: 25 }, (_, i) => ({ path: `${i % 9}.html`, time: i % 4 ? i % 3 : NaN, session: String(i) }))
    const embeds = Array.from({ length: 12 }, (_, i) => ({ path: `${(i * 5) % 12}.html` }))
    const expected = buildChannel({ ...input, sent, embeds })
    const declared = new Map(embeds.map((e, i) => [docKey('host', `/fiber/${e.path}`, 'host'), i]))
    const compare = compareDocuments(declared)
    for (let seed = 1; seed <= 100; seed++) {
      const actual = buildChannel({ ...input, sent: shuffled(sent, seed), embeds, previous: { ...expected, documents: shuffled(expected.documents, seed + 2) } })
      expect(actual.documents.map(d => d.key)).toEqual(expected.documents.map(d => d.key))
    }
    const docs = expected.documents.slice(1)
    for (const a of docs) for (const b of docs) {
      expect(Math.sign(compare(a, b)) + Math.sign(compare(b, a))).toBe(0)
      for (const c of docs) if (compare(a, b) <= 0 && compare(b, c) <= 0) expect(compare(a, c)).toBeLessThanOrEqual(0)
    }
  })
})
