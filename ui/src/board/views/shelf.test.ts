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
  clampZoom,
  coercePersist,
  emptyPersist,
  isPlaced,
  layoutShelf,
  loadShelfPersist,
  resetLayout,
  saveShelfPersist,
  SHELF_METRICS,
  SHELF_PERSIST_KEY,
  ZOOM_MAX,
  ZOOM_MIN,
  type ShelfCardState,
} from './shelfLayout.js'
import { relativeAge } from './ShelfView.js'
import {
  coerceReaderPersist,
  defaultReaderGeom,
  emptyReaderPersist,
  loadReaderPersist,
  onScreen,
  READER_PERSIST_KEY,
  saveReaderPersist,
} from './ShelfReader.js'
import {
  advanceGesture,
  beginGesture,
  DRAG_THRESHOLD,
  MIN_CARD_H,
  MIN_CARD_W,
  settleGesture,
  travelled,
} from './shelfGesture.js'

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
          host: 'farhost',
          caption: 'the B-mode null',
        },
      ],
      origins: { farhost: { kind: 'remote', stale: true } },
    })
    expect(out).toEqual([
      {
        fullPath: '/w/report.html',
        basename: 'report.html',
        timestamp: 1700,
        sessionId: undefined,
        uid: 'lensing',
        host: 'farhost',
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
    expect(fileUrl('http://d:4000', { ...file('/w/a b.html', 0), host: 'farhost' })).toBe(
      'http://d:4000/api/v1/file?path=%2Fw%2Fa%20b.html&origin=farhost',
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

describe('layoutShelf — nothing overlaps', () => {
  const metrics = { ...SHELF_METRICS, width: 3 * (SHELF_METRICS.cardW + SHELF_METRICS.gap) }

  /** Every pair of cards on the laid-out board, except same-fiber piles. */
  function assertLegal(cards: ReturnType<typeof layoutShelf>['cards']): void {
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) {
        const a = cards[i]
        const b = cards[j]
        if (a.file.uid && a.file.uid === b.file.uid) continue
        const hit =
          a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
        expect(hit, `${a.file.fullPath} overlaps ${b.file.fullPath}`).toBe(false)
      }
    }
  }

  it('routes the flow around a placed card instead of under it', () => {
    // An anchor sitting exactly on the grid's second slot.
    const anchorX = SHELF_METRICS.cardW + SHELF_METRICS.gap
    const files = [file('/a', 1), file('/b', 2), file('/c', 3), file('/anchor', 4)]
    const states: Record<string, ShelfCardState> = {
      '/anchor': { x: anchorX, y: 0, w: SHELF_METRICS.cardW, h: SHELF_METRICS.cardH },
    }
    const { cards } = layoutShelf(files, 'recency', states, metrics)
    assertLegal(cards)
    // The flow skipped the occupied slot and stayed ON the grid.
    for (const card of cards.filter((c) => !c.pinned)) {
      expect(card.x % anchorX).toBe(0)
    }
    expect(cards.find((c) => c.file.fullPath === '/anchor')).toMatchObject({ x: anchorX, y: 0 })
  })

  it('routes each fiber band around an anchor too', () => {
    const anchorX = SHELF_METRICS.cardW + SHELF_METRICS.gap
    const files = [
      file('/x1', 1, 'shear'),
      file('/x2', 2, 'shear'),
      file('/anchor', 3, 'lensing'),
    ]
    const states: Record<string, ShelfCardState> = {
      '/anchor': { x: anchorX, y: 0, w: SHELF_METRICS.cardW, h: SHELF_METRICS.cardH },
    }
    assertLegal(layoutShelf(files, 'fiber', states, metrics).cards)
  })

  it('settles two cards dropped on the same ground, the active one keeping it', () => {
    const files = [file('/first', 5), file('/dropped', 1)]
    const states: Record<string, ShelfCardState> = {
      '/first': { x: 400, y: 300, w: 268, h: 212 },
      '/dropped': { x: 420, y: 320, w: 268, h: 212 },
    }
    const { cards } = layoutShelf(files, 'recency', states, metrics, '/dropped')
    expect(cards.find((c) => c.file.fullPath === '/dropped')).toMatchObject({ x: 420, y: 320 })
    assertLegal(cards)
  })

  it('lets one fiber pile, and only that pile', () => {
    const files = [file('/s1', 1, 'shear'), file('/s2', 2, 'shear'), file('/l', 3, 'lensing')]
    const states: Record<string, ShelfCardState> = {
      '/s1': { x: 400, y: 300, w: 268, h: 212 },
      '/s2': { x: 430, y: 325, w: 268, h: 212 },
      '/l': { x: 450, y: 340, w: 268, h: 212 },
    }
    const { cards } = layoutShelf(files, 'recency', states, metrics)
    const s1 = cards.find((c) => c.file.fullPath === '/s1')!
    const s2 = cards.find((c) => c.file.fullPath === '/s2')!
    expect(s1.x < s2.x + s2.w && s2.x < s1.x + s1.w).toBe(true) // still a pile
    assertLegal(cards)
  })

  it('never moves a starred card to make room', () => {
    const files = [file('/star', 5), file('/other', 1)]
    const states: Record<string, ShelfCardState> = {
      '/star': { x: 400, y: 300, w: 268, h: 212, starred: true },
      '/other': { x: 410, y: 310, w: 268, h: 212 },
    }
    const { cards } = layoutShelf(files, 'recency', states, metrics)
    expect(cards.find((c) => c.file.fullPath === '/star')).toMatchObject({ x: 400, y: 300 })
    assertLegal(cards)
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

describe('persistence', () => {
  it('round-trips a lens, a pan and a placed card', () => {
    const store = memoryStorage()
    const state = {
      lens: 'fiber' as const,
      pan: { x: -120, y: 40 },
      zoom: 0.75,
      cards: { '/w/r.html': { x: 10, y: 20, w: 300, h: 240, starred: true } },
      dismissed: ['/w/noisy.html'],
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

  it('reads a dismissal list, dropping duplicates and non-strings', () => {
    expect(coercePersist({ dismissed: ['/a', '/a', 7, '', '/b'] }).dismissed).toEqual(['/a', '/b'])
    expect(coercePersist({ dismissed: 'nope' }).dismissed).toEqual([])
    expect(coercePersist({}).dismissed).toEqual([])
  })

  it('opens at a sane zoom whatever the store says', () => {
    expect(coercePersist({ zoom: 0.9 }).zoom).toBe(0.9)
    expect(coercePersist({ zoom: 40 }).zoom).toBe(ZOOM_MAX)
    expect(coercePersist({ zoom: 0.001 }).zoom).toBe(ZOOM_MIN)
    expect(coercePersist({ zoom: 'wide' }).zoom).toBe(1)
    expect(coercePersist({}).zoom).toBe(1)
  })
})

describe('resetLayout — the furniture goes back, the judgements stay', () => {
  it('drops every placement, keeps every star, and re-centres the canvas', () => {
    const before = {
      ...emptyPersist(),
      lens: 'fiber' as const,
      pan: { x: -800, y: -600 },
      zoom: 0.5,
      cards: {
        '/dragged': { x: 900, y: 400, w: 500, h: 700 },
        '/held': { x: 100, y: 100, w: 300, h: 400, starred: true },
      },
      dismissed: ['/gone'],
    }
    const after = resetLayout(before)
    expect(after.cards['/dragged']).toBeUndefined()
    // The star survives, but with nothing left of the position it held.
    expect(after.cards['/held']).toEqual({ starred: true })
    expect(isPlaced(after.cards['/held'])).toBe(false)
    expect(after.pan).toEqual({ x: 0, y: 0 })
    expect(after.zoom).toBe(1)
    // A reset is about the surface, not about what is on it.
    expect(after.lens).toBe('fiber')
    expect(after.dismissed).toEqual(['/gone'])
  })

  it('hands a reset starred card back to the flow, still sorted to the front', () => {
    const files = [file('/new', 1), file('/old-but-held', 5000)]
    const persist = resetLayout({
      ...emptyPersist(),
      cards: { '/old-but-held': { x: 900, y: 900, w: 300, h: 400, starred: true } },
    })
    const { cards } = layoutShelf(files, 'recency', persist.cards, {
      ...SHELF_METRICS,
      width: 3 * (SHELF_METRICS.cardW + SHELF_METRICS.gap),
    })
    const held = cards.find((c) => c.file.fullPath === '/old-but-held')!
    expect(held.pinned).toBe(false)
    expect(held.starred).toBe(true)
    expect(held).toMatchObject({ x: 0, y: 0 })
  })
})

describe('the card is a page', () => {
  it('defaults to portrait at A4 proportion', () => {
    const ratio = SHELF_METRICS.cardH / SHELF_METRICS.cardW
    expect(ratio).toBeGreaterThan(1.4)
    expect(ratio).toBeLessThan(1.43)
  })
})

describe('shelfGesture — a click is not a drag', () => {
  const geom = { x: 100, y: 200, w: 268, h: 212 }
  const down = { clientX: 500, clientY: 400, pointerId: 1 }

  it('starts as a maybe, and paints nothing until the pointer travels', () => {
    const g = beginGesture('move', '/a', down, geom)
    expect(g.phase).toBe('maybe')
    const nudge = advanceGesture(g, down.clientX + DRAG_THRESHOLD, down.clientY)
    expect(nudge.gesture.phase).toBe('maybe')
    expect(nudge.geometry).toBeNull()
  })

  it('promotes to a drag past the threshold, and never falls back', () => {
    const g = beginGesture('move', '/a', down, geom)
    const moved = advanceGesture(g, down.clientX + 30, down.clientY + 10)
    expect(moved.gesture.phase).toBe('active')
    expect(moved.geometry).toEqual({ x: 130, y: 210, w: 268, h: 212 })
    // Coming back to the origin mid-gesture is still a drag in progress.
    const back = advanceGesture(moved.gesture, down.clientX, down.clientY)
    expect(back.gesture.phase).toBe('active')
    expect(back.geometry).toEqual(geom)
  })

  it('releases a travelled gesture as a PLACEMENT', () => {
    const g = advanceGesture(beginGesture('move', '/a', down, geom), 600, 500).gesture
    expect(settleGesture(g)).toEqual({ placed: true, click: false })
  })

  it('releases an untravelled press as a CLICK, placing nothing', () => {
    // This is the duplicate-card bug, stated as a test: a press that never
    // moved must not write geometry, because a card written down leaves the
    // flow and the flow closes up behind it — which looked like a copy.
    const g = beginGesture('move', '/a', down, geom)
    expect(settleGesture(g)).toEqual({ placed: false, click: true })
  })

  it('holds a resize to a legible floor', () => {
    const g = advanceGesture(beginGesture('resize', '/a', down, geom), 0, 0).gesture
    const { geometry } = advanceGesture(g, -9999, -9999)
    expect(geometry).toEqual({ x: 100, y: 200, w: MIN_CARD_W, h: MIN_CARD_H })
  })

  it('resizes from the origin size, so a resize never jumps', () => {
    const g = beginGesture('resize', '/a', down, geom)
    const { geometry } = advanceGesture(g, down.clientX + 40, down.clientY + 25)
    expect(geometry).toEqual({ x: 100, y: 200, w: 308, h: 237 })
  })

  it('settles a pan without placing anything', () => {
    const g = advanceGesture(
      beginGesture('pan', null, down, { x: -50, y: -20, w: 0, h: 0 }),
      down.clientX + 100,
      down.clientY + 60,
    )
    expect(g.geometry).toMatchObject({ x: 50, y: 40 })
    expect(settleGesture(g.gesture)).toEqual({ placed: false, click: false })
  })

  it('measures travel as the taxicab distance from where the press landed', () => {
    const g = beginGesture('move', '/a', down, geom)
    expect(travelled(g, down.clientX + 2, down.clientY + 2)).toBe(false)
    expect(travelled(g, down.clientX + 3, down.clientY + 3)).toBe(true)
  })

  describe('under a zoomed canvas', () => {
    it('converts screen travel into surface travel', () => {
      // At half scale, 100 screen pixels of pointer is 200 surface pixels of
      // card. Without the division every drag lands short by the zoom factor.
      const g = beginGesture('move', '/a', down, geom, 0.5)
      const { geometry } = advanceGesture(g, down.clientX + 100, down.clientY + 50)
      expect(geometry).toEqual({ x: 100 + 200, y: 200 + 100, w: geom.w, h: geom.h })
    })

    it('scales a resize the same way', () => {
      const g = beginGesture('resize', '/a', down, geom, 2)
      const { geometry } = advanceGesture(g, down.clientX + 100, down.clientY + 100)
      expect(geometry).toMatchObject({ w: geom.w + 50, h: geom.h + 50 })
    })

    it('leaves a PAN in screen pixels — the offset is applied outside the scale', () => {
      const g = beginGesture('pan', null, down, { x: 0, y: 0, w: 0, h: 0 }, 0.5)
      const { geometry } = advanceGesture(g, down.clientX + 100, down.clientY + 40)
      expect(geometry).toMatchObject({ x: 100, y: 40 })
    })

    it('keeps the drag threshold in SCREEN pixels — a tremor is a tremor', () => {
      const g = beginGesture('move', '/a', down, geom, 0.4)
      expect(travelled(g, down.clientX + 2, down.clientY + 2)).toBe(false)
      expect(travelled(g, down.clientX + 3, down.clientY + 3)).toBe(true)
    })

    it('shrugs at a nonsense scale rather than dividing by it', () => {
      for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(beginGesture('move', '/a', down, geom, bad).scale).toBe(1)
      }
    })
  })
})

describe('clampZoom', () => {
  it('holds the canvas between recognisable and readable', () => {
    expect(clampZoom(1)).toBe(1)
    expect(clampZoom(9)).toBe(ZOOM_MAX)
    expect(clampZoom(0.01)).toBe(ZOOM_MIN)
    expect(clampZoom(Number.NaN)).toBe(1)
  })
})

describe('the Reader — what survives a dismissal', () => {
  it('round-trips the strip, the active tab and the window', () => {
    const store = memoryStorage()
    const state = {
      open: [
        { path: '/w/a.html', basename: 'a.html', scroll: 300 },
        { path: '/w/b.png', basename: 'b.png', host: 'farhost', zoom: 2 },
      ],
      active: '/w/b.png',
      geom: { left: 40, top: 20, width: 900, height: 700 },
    }
    saveReaderPersist(state, store)
    expect(store.getItem(READER_PERSIST_KEY)).toBeTruthy()
    expect(loadReaderPersist(store)).toEqual(state)
  })

  it('forgets the record entirely when there is nothing left to remember', () => {
    const store = memoryStorage()
    saveReaderPersist({ open: [{ path: '/a' }] }, store)
    saveReaderPersist({ open: [] }, store)
    expect(store.getItem(READER_PERSIST_KEY)).toBeNull()
  })

  it('opens empty on a missing or corrupt store', () => {
    const store = memoryStorage()
    expect(loadReaderPersist(store)).toEqual(emptyReaderPersist())
    store.setItem(READER_PERSIST_KEY, '{not json')
    expect(loadReaderPersist(store)).toEqual(emptyReaderPersist())
  })

  it('refuses an active pointer at a tab that is not open, falling to the last', () => {
    const state = coerceReaderPersist({ open: [{ path: '/a' }, { path: '/b' }], active: '/gone' })
    expect(state.active).toBe('/b')
  })

  it('leaves nothing active when nothing is open', () => {
    expect(coerceReaderPersist({ open: [], active: '/a' }).active).toBeUndefined()
  })

  it('never rehydrates the same file as two tabs', () => {
    const state = coerceReaderPersist({ open: [{ path: '/a' }, { path: '/a', scroll: 9 }] })
    expect(state.open).toEqual([{ path: '/a' }])
  })

  it('drops a geometry too small to be a window, or half-written', () => {
    expect(coerceReaderPersist({ geom: { left: 0, top: 0, width: 10, height: 10 } }).geom)
      .toBeUndefined()
    expect(coerceReaderPersist({ geom: { left: 0, top: 0, width: 900 } }).geom).toBeUndefined()
    expect(coerceReaderPersist({ geom: { left: 4, top: 6, width: 900, height: 700 } }).geom)
      .toEqual({ left: 4, top: 6, width: 900, height: 700 })
  })

  it('refuses a remembered geometry that no longer lands on screen', () => {
    const g = { left: 2400, top: 40, width: 900, height: 700 }
    expect(onScreen(g, 1440, 900)).toBe(false)
    expect(onScreen({ ...g, left: 200 }, 1440, 900)).toBe(true)
    // Dragged mostly off the left edge, but still grabbable.
    expect(onScreen({ ...g, left: -700 }, 1440, 900)).toBe(true)
    expect(onScreen({ ...g, left: -900 }, 1440, 900)).toBe(false)
  })

  it('opens over the canvas, not instead of it — inset, and never below the floors', () => {
    const wide = defaultReaderGeom(1600, 1000)
    expect(wide.width).toBeLessThan(1600)
    expect(wide.left + wide.width).toBeLessThanOrEqual(1600)
    expect(wide.top).toBeGreaterThanOrEqual(12)
    const tiny = defaultReaderGeom(400, 300)
    expect(tiny.width).toBeGreaterThanOrEqual(380)
    expect(tiny.height).toBeGreaterThanOrEqual(320)
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
