import { describe, expect, it } from 'vitest'
import { buildChannel, compareDocuments, documentActivity, docKey, lastSent } from './documents.js'

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
  it('centres prose: declarations to its left, nearest first in body order; sends to its right by latest receipt, newest nearest, unknown times last', () => {
    const channel = buildChannel({ ...input,
      embeds: [{ path: 'zeta.txt' }, { path: 'alpha.txt' }, { path: 'sent-embed.txt' }],
      fileModifiedAt: new Map([[docKey('host', '/fiber/alpha.txt', 'host'), new Date(600).toISOString()]]),
      sent: [{ path: 'b.txt', time: 10 }, { path: 'b.txt', time: 90 }, { path: 'a.txt', time: 20 }, { path: 'sent-embed.txt', time: 30 }, { path: 'bad.txt', time: NaN }],
      links: [{ path: 'linked.txt' }],
    })
    expect(channel.documents.map(d => d.name)).toEqual(['linked.txt', 'sent-embed.txt', 'alpha.txt', 'zeta.txt', 'Note', 'b.txt', 'a.txt', 'bad.txt'])
    expect(lastSent(channel.documents[5])).toBe(90)
    expect(lastSent(channel.documents[7])).toBeUndefined()
    expect(documentActivity(channel.documents.find(d => d.name === 'b.txt')!)).toBe(90)
  })
  it('sets the declared report beside the fiber page wherever the body declares it', () => {
    const channel = buildChannel({ ...input, embeds: [{ path: 'notes.md' }, { path: 'out/report.html' }, { path: 'plot.png' }], sent: [{ path: 'log.txt', time: 5 }] })
    expect(channel.documents.map(d => d.name)).toEqual(['plot.png', 'notes.md', 'report.html', 'Note', 'log.txt'])
  })
  it('a re-send moves its document beside the fiber page', () => {
    const before = buildChannel({ ...input, sent: [{ path: 'old.html', time: 10 }, { path: 'new.html', time: 20 }] })
    expect(before.documents.map(d => d.name)).toEqual(['Note', 'new.html', 'old.html'])
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
    const docs = expected.documents.filter(d => d.kind !== 'fiber')
    for (const a of docs) for (const b of docs) {
      expect(Math.sign(compare(a, b)) + Math.sign(compare(b, a))).toBe(0)
      for (const c of docs) if (compare(a, b) <= 0 && compare(b, c) <= 0) expect(compare(a, c)).toBeLessThanOrEqual(0)
    }
  })
})
