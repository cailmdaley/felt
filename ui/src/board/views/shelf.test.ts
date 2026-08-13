/**
 * Shelf — the pure parts: what the canvas is a canvas of (dedupe, kind), how
 * the lenses order it, and what survives a reload.
 */

import { describe, expect, it } from 'vitest'

import {
  dedupeByPath,
  normalizeShelfFiles,
  pickOrigins,
  shelfKind,
  fileUrl,
  type ShelfFile,
} from './shelfData.js'
import {
  coercePersist,
  emptyPersist,
  isPlaced,
  layoutShelf,
  loadShelfPersist,
  saveShelfPersist,
  SHELF_METRICS,
  SHELF_PERSIST_KEY,
  type ShelfCardState,
} from './shelfLayout.js'
import { relativeAge } from './ShelfView.js'

const MIN = 60_000

function file(path: string, minutesAgo: number, uid?: string): ShelfFile {
  return {
    fullPath: path,
    basename: path.split('/').pop() ?? path,
    timestamp: 1_700_000_000_000 - minutesAgo * MIN,
    ...(uid ? { uid } : {}),
  }
}

describe('normalizeShelfFiles', () => {
  it('reads a composite envelope and keeps the shelf fields', () => {
    const out = normalizeShelfFiles({
      items: [
        {
          fullPath: '/w/report.html',
          basename: 'report.html',
          timestamp: 1700,
          uid: 'lensing',
          host: 'candide',
          caption: 'the B-mode null',
        },
      ],
      origins: { candide: { kind: 'remote', stale: true } },
    })
    expect(out).toEqual([
      {
        fullPath: '/w/report.html',
        basename: 'report.html',
        timestamp: 1700,
        sessionId: undefined,
        uid: 'lensing',
        host: 'candide',
        caption: 'the B-mode null',
      },
    ])
  })

  it('accepts a bare array, an ISO timestamp, and a `fiber`/`origin` dialect', () => {
    const out = normalizeShelfFiles([
      { fullPath: '/w/a.svg', timestamp: '2023-11-14T22:13:20.000Z', fiber: 'shear', origin: 'laptop' },
    ])
    expect(out[0].timestamp).toBe(Date.parse('2023-11-14T22:13:20.000Z'))
    expect(out[0].uid).toBe('shear')
    expect(out[0].host).toBe('laptop')
    expect(out[0].basename).toBe('a.svg')
  })

  it('drops pathless records rather than drawing a card that opens nothing', () => {
    expect(normalizeShelfFiles([{ basename: 'ghost.html' }, null, 7])).toEqual([])
    expect(normalizeShelfFiles('nonsense')).toEqual([])
  })

  it('reads the origins block, and shrugs at a body that has none', () => {
    expect(pickOrigins({ origins: { laptop: { kind: 'local', stale: false } } })).toEqual({
      laptop: { kind: 'local', stale: false },
    })
    expect(pickOrigins([])).toEqual({})
  })
})

describe('dedupeByPath', () => {
  it('keeps the latest send of a path, with its metadata, newest first', () => {
    const out = dedupeByPath([
      { ...file('/w/r.html', 100), uid: 'old' },
      { ...file('/w/r.html', 5), uid: 'new' },
      file('/w/other.html', 50),
    ])
    expect(out.map((f) => f.fullPath)).toEqual(['/w/r.html', '/w/other.html'])
    expect(out[0].uid).toBe('new')
  })
})

describe('shelfKind / fileUrl', () => {
  it('names the face a path wears', () => {
    expect(shelfKind('/w/r.html')).toBe('page')
    expect(shelfKind('/w/fig.SVG')).toBe('page')
    expect(shelfKind('/w/fig.png')).toBe('image')
    expect(shelfKind('/w/paper.pdf')).toBe('pdf')
    expect(shelfKind('/w/notes.md')).toBe('text')
    expect(shelfKind('/w/bundle.tar.gz')).toBe('opaque')
    expect(shelfKind('/w/Makefile')).toBe('opaque')
  })

  it('routes a remote file through its owner and escapes both parts', () => {
    expect(fileUrl('http://d:4000', { ...file('/w/a b.html', 0), host: 'candide' })).toBe(
      'http://d:4000/api/v1/file?path=%2Fw%2Fa%20b.html&origin=candide',
    )
    expect(fileUrl('', file('/w/a.html', 0))).toBe('/api/v1/file?path=%2Fw%2Fa.html')
  })
})

describe('layoutShelf — the recency lens', () => {
  const metrics = { ...SHELF_METRICS, width: 3 * (SHELF_METRICS.cardW + SHELF_METRICS.gap) }

  it('gives recency a direction: newest at the top-left, filling right then down', () => {
    const files = [file('/a', 1), file('/b', 2), file('/c', 3), file('/d', 4)]
    const { cards } = layoutShelf(files, 'recency', {}, metrics)
    expect(cards.map((c) => c.file.fullPath)).toEqual(['/a', '/b', '/c', '/d'])
    expect(cards[0]).toMatchObject({ x: 0, y: 0 })
    expect(cards[1].x).toBeGreaterThan(0)
    expect(cards[1].y).toBe(0)
    expect(cards[3].y).toBeGreaterThan(0)
    expect(cards[3].x).toBe(0)
  })

  it('sorts a starred-but-unplaced card ahead of newer unstarred ones', () => {
    const files = [file('/a', 1), file('/b', 2), file('/old', 900)]
    const states: Record<string, ShelfCardState> = { '/old': { starred: true } }
    const { cards } = layoutShelf(files, 'recency', states, metrics)
    expect(cards[0].file.fullPath).toBe('/old')
    expect(cards[0].starred).toBe(true)
  })

  it('draws a placed card at its own coordinates and takes it out of the flow', () => {
    const files = [file('/a', 1), file('/pinned', 2), file('/c', 3)]
    const states: Record<string, ShelfCardState> = {
      '/pinned': { x: 900, y: 640, w: 400, h: 300, starred: true },
    }
    const { cards } = layoutShelf(files, 'recency', states, metrics)
    const pinned = cards.find((c) => c.file.fullPath === '/pinned')!
    expect(pinned).toMatchObject({ x: 900, y: 640, w: 400, h: 300, pinned: true, starred: true })
    // The flow closes over it: /c takes the second slot, not the third.
    const flowed = cards.filter((c) => !c.pinned).map((c) => c.file.fullPath)
    expect(flowed).toEqual(['/a', '/c'])
    expect(cards.find((c) => c.file.fullPath === '/c')!.x).toBeGreaterThan(0)
    expect(cards.find((c) => c.file.fullPath === '/c')!.y).toBe(0)
  })

  it('stretches the surface to reach a card dragged past the flow', () => {
    const { width, height } = layoutShelf(
      [file('/a', 1)],
      'recency',
      { '/a': { x: 2000, y: 1500, w: 300, h: 200 } },
      metrics,
    )
    expect(width).toBeGreaterThanOrEqual(2300)
    expect(height).toBeGreaterThanOrEqual(1700)
  })
})

describe('layoutShelf — the fiber lens', () => {
  const metrics = { ...SHELF_METRICS, width: 3 * (SHELF_METRICS.cardW + SHELF_METRICS.gap) }

  it('bands the cards by fiber, most-recently-touched band first', () => {
    const files = [
      file('/x1', 5, 'shear'),
      file('/y1', 60, 'lensing'),
      file('/x2', 90, 'shear'),
    ]
    const { cards, captions } = layoutShelf(files, 'fiber', {}, metrics)
    expect(captions.map((c) => c.uid)).toEqual(['shear', 'lensing'])
    const y = (p: string) => cards.find((c) => c.file.fullPath === p)!.y
    expect(y('/x1')).toBe(y('/x2'))
    expect(y('/y1')).toBeGreaterThan(y('/x1'))
  })

  it('captions the fiberless band for what it is, and sorts it last', () => {
    const { captions } = layoutShelf([file('/n', 1), file('/s', 50, 'shear')], 'fiber', {}, metrics)
    expect(captions.map((c) => c.uid)).toEqual(['shear', ''])
    expect(captions[1].label).toBe('unattributed')
  })
})

describe('persistence', () => {
  function memoryStorage(): Storage {
    const map = new Map<string, string>()
    return {
      get length() { return map.size },
      clear: () => map.clear(),
      key: (i: number) => [...map.keys()][i] ?? null,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { map.set(k, v) },
      removeItem: (k: string) => { map.delete(k) },
    } as Storage
  }

  it('round-trips a lens, a pan and a placed card', () => {
    const store = memoryStorage()
    const state = {
      lens: 'fiber' as const,
      pan: { x: -120, y: 40 },
      cards: { '/w/r.html': { x: 10, y: 20, w: 300, h: 240, starred: true } },
    }
    saveShelfPersist(state, store)
    expect(store.getItem(SHELF_PERSIST_KEY)).toBeTruthy()
    expect(loadShelfPersist(store)).toEqual(state)
  })

  it('opens on an empty shelf when the store is missing or corrupt', () => {
    const store = memoryStorage()
    expect(loadShelfPersist(store)).toEqual(emptyPersist())
    store.setItem(SHELF_PERSIST_KEY, '{not json')
    expect(loadShelfPersist(store)).toEqual(emptyPersist())
  })

  it('refuses half a position — one axis is not a placement', () => {
    const persisted = coercePersist({ cards: { '/a': { x: 10 }, '/b': { x: 1, y: 2 } } })
    expect(isPlaced(persisted.cards['/a'])).toBe(false)
    expect(persisted.cards['/a']).toBeUndefined()
    expect(isPlaced(persisted.cards['/b'])).toBe(true)
  })

  it('keeps a star that has no geometry, and drops junk fields', () => {
    const persisted = coercePersist({
      lens: 'sideways',
      pan: 'nowhere',
      cards: { '/a': { starred: true, w: 'wide' }, '/b': 'nope' },
    })
    expect(persisted.lens).toBe('recency')
    expect(persisted.pan).toEqual({ x: 0, y: 0 })
    expect(persisted.cards['/a']).toEqual({ starred: true })
    expect(persisted.cards['/b']).toBeUndefined()
  })
})

describe('relativeAge', () => {
  it('says how long ago in the fewest characters that stay true', () => {
    const now = 1_700_000_000_000
    expect(relativeAge(now - 20_000, now)).toBe('now')
    expect(relativeAge(now - 9 * MIN, now)).toBe('9m')
    expect(relativeAge(now - 3 * 60 * MIN, now)).toBe('3h')
    expect(relativeAge(now - 50 * 60 * MIN, now)).toBe('2d')
    expect(relativeAge(now + 5000, now)).toBe('now')
  })
})
