// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
const renderer = vi.hoisted(() => ({ finishes: [] as Array<() => void>, fails: [] as Array<() => void> }))
vi.mock('../FileViewerPanel.js', () => ({
  readThumbnailMetadata: vi.fn(async () => {}),
  buildFileViewer: vi.fn((_base, path: string, _owner, _frame, _scroll, options) => {
    // A text body's pre arrives with its ready signal, as FileViewerPanel appends it.
    const text = path.endsWith('.txt')
    const body = document.createElement('div'); if (!text) body.append(document.createElement('iframe'))
    renderer.finishes.push(() => { if (text) body.append(document.createElement('pre')); options.onState({ status: 'ready' }) })
    renderer.fails.push(() => options.onState({ status: 'error', error: new Error('Thumbnail unavailable'), hasContent: false }))
    return body
  }),
  disposeFileViewer: vi.fn(),
}))
import { cacheDocumentTitle } from './DocumentTitles.js'
import { docKey } from './documents.js'
import { Thumbnail, pumpThumbnails } from './Thumbnail.js'
import { RESOURCE_FRESH_MS } from '../documentResources.js'
let thumbs: Thumbnail[] = []
/** A thumbnail whose box the budget's ResizeObserver has measured, as it is by the first frame it is laid out. */
const measured = (opts: ConstructorParameters<typeof Thumbnail>[0]): Thumbnail => { const thumb = new Thumbnail(opts); thumb.resize(176, 116); return thumb }
afterEach(() => { for (const thumb of thumbs) thumb.dispose(); thumbs = []; renderer.finishes = []; renderer.fails = []; vi.unstubAllGlobals(); vi.useRealTimers() })
it.each(['report.html', 'index.html'])('omits the generic %s fallback title from its face', basename => {
  const path = `/reports/${basename}`
  const thumb = new Thumbnail({ key: path, shuttleBase: '', file: { fullPath: path, owner: 'host', basename }, fallback: '', priority: () => 0, distance: () => 0 })
  thumbs.push(thumb)
  expect(thumb.el.querySelector('.ws-thumbnail-title')?.textContent).toBe('')
})
it('retains a declared title when it loads for a generic filename', () => {
  const path = '/reports/report.html'
  const thumb = new Thumbnail({ key: path, shuttleBase: '', file: { fullPath: path, owner: 'host', basename: 'report.html' }, fallback: '', priority: () => 0, distance: () => 0 })
  thumbs.push(thumb)
  expect(thumb.el.querySelector('.ws-thumbnail-title')?.textContent).toBe('')
  cacheDocumentTitle(docKey('host', path, 'host'), path, '<title>Declared report</title><p>Report preview</p>')
  expect(thumb.el.querySelector('.ws-thumbnail-title')?.textContent).toBe('Declared report')
})
it('suppresses setProse titles on captioned fiber faces while retaining their preview', () => {
  const thumb = new Thumbnail({ key: 'captioned-fiber', shuttleBase: '', fallback: 'unused', captioned: true, priority: () => 0, distance: () => 0 })
  thumbs.push(thumb)
  thumb.setProse('Fiber body preview', 'Fiber name')
  expect(thumb.el.querySelector('.ws-thumbnail-title')?.textContent).toBe('')
  expect(thumb.el.querySelector('.ws-thumbnail-preview')?.textContent).toBe('Fiber body preview')
})
it('shares four loading and sixteen live slots across overview and tab previews, without equal-priority churn', () => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn())
  let overviewVisible = true
  for (let i = 0; i < 32; i++) {
    const tab = i >= 20
    const thumb = measured({ key: String(i), shuttleBase: '', file: { fullPath: `/${i}.html`, owner: 'host', basename: `${i}.html` }, fallback: '',
      priority: () => tab ? 0 : overviewVisible ? 2 : 0, distance: () => i,
    })
    thumbs.push(thumb); document.body.append(thumb.el)
  }
  pumpThumbnails()
  expect(thumbs.filter(t => t.state === 'loading')).toHaveLength(4)
  for (let i = 0; i < 5; i++) {
    const finishes = renderer.finishes.splice(0); finishes.forEach(f => f()); pumpThumbnails()
    expect(thumbs.filter(t => t.state === 'loading').length).toBeLessThanOrEqual(4)
    expect(thumbs.filter(t => t.state === 'live' || t.state === 'loading').length).toBeLessThanOrEqual(16)
  }
  const alive = thumbs.filter(t => t.body)
  pumpThumbnails(); expect(thumbs.filter(t => t.body)).toEqual(alive)
  overviewVisible = false
  const tab = measured({ key: 'selected-tab', shuttleBase: '', file: { fullPath: '/selected.html', owner: 'host', basename: 'selected.html' }, fallback: '', priority: () => 3, distance: () => 0 })
  thumbs.push(tab); document.body.append(tab.el)
  pumpThumbnails()
  expect(tab.state).toBe('loading')
  expect(thumbs.filter(t => t.body)).toHaveLength(1)
})

it('unmounts live and loading thumbnails outside the loading ring, including hidden surfaces', () => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn())
  let priority = 2
  for (let i = 0; i < 2; i++) {
    const thumb = measured({ key: `offscreen-${i}`, shuttleBase: '', file: { fullPath: `/${i}.html`, owner: 'host', basename: `${i}.html` }, fallback: '', priority: () => priority, distance: () => 0 })
    thumbs.push(thumb)
  }
  pumpThumbnails(); renderer.finishes[0]()
  expect(thumbs.map(t => t.state)).toEqual(['live', 'loading'])
  priority = 0; pumpThumbnails()
  expect(thumbs.map(t => t.state)).toEqual(['idle', 'idle'])
  expect(thumbs.every(t => !t.body)).toBe(true)
  renderer.finishes[1]()
  expect(thumbs[1].state).toBe('idle')
})

it('scales from observed sizes without layout reads or unchanged style writes', () => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const thumb = measured({ key: 'scale', shuttleBase: '', file: { fullPath: '/scale.html', owner: 'host', basename: 'scale.html' }, fallback: '', priority: () => 2, distance: () => 0 })
  thumbs.push(thumb)
  const width = vi.spyOn(thumb.el, 'clientWidth', 'get'), height = vi.spyOn(thumb.el, 'clientHeight', 'get')
  pumpThumbnails()
  const frame = thumb.body!.querySelector('iframe')!
  expect(frame.style.width).toBe('1040px')
  const writes = vi.spyOn(frame.style, 'transform', 'set')
  pumpThumbnails(); pumpThumbnails()
  expect(writes).not.toHaveBeenCalled()
  thumb.resize(104, 52); pumpThumbnails()
  expect(frame.style.transform).toBe('scale(0.1)')
  expect(frame.style.height).toBe('520px')
  expect(writes).toHaveBeenCalledOnce()
  expect(width).not.toHaveBeenCalled(); expect(height).not.toHaveBeenCalled()
})

// Regression: the band's layout-shift journey failed on CI when it measured a text pre in the frame between its arrival and the next pump.
it('loads no body until its box has been measured, so it is never drawn at a guessed scale', () => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const thumb = new Thumbnail({ key: 'unmeasured', shuttleBase: '', file: { fullPath: '/u.html', owner: 'host', basename: 'u.html' }, fallback: '', priority: () => 2, distance: () => 0 })
  thumbs.push(thumb)
  pumpThumbnails()
  expect(thumb.state).toBe('idle')
  thumb.resize(380, 240); pumpThumbnails()
  expect(thumb.state).toBe('loading')
})

it('draws a text body scaled from the moment it is ready, before any later pump', () => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const thumb = measured({ key: 'notes', shuttleBase: '', file: { fullPath: '/notes.txt', owner: 'host', basename: 'notes.txt' }, fallback: '', priority: () => 2, distance: () => 0 })
  thumbs.push(thumb); thumb.resize(190, 120)
  pumpThumbnails()
  renderer.finishes.splice(0).forEach(f => f())
  const pre = thumb.body!.querySelector('pre')!
  expect([thumb.state, pre.style.width, pre.style.transform]).toEqual(['live', '760px', 'scale(0.25)'])
})

it('tries a failed thumbnail again once the miss it saw has expired, so a report written later appears', () => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const thumb = measured({ key: 'late', shuttleBase: '', file: { fullPath: '/late/report.html', owner: 'host', basename: 'report.html' }, fallback: '', priority: () => 2, distance: () => 0 })
  thumbs.push(thumb); document.body.append(thumb.el)
  pumpThumbnails()
  renderer.fails.splice(0).forEach(fail => fail())
  expect(thumb.state).toBe('failed')
  vi.advanceTimersByTime(RESOURCE_FRESH_MS - 1)
  pumpThumbnails()
  expect(thumb.state).toBe('failed')
  vi.advanceTimersByTime(1)
  pumpThumbnails()
  expect(thumb.state).toBe('loading')
  renderer.finishes.at(-1)!()
  expect(thumb.state).toBe('live')
})

it('loads what is on screen first, keeps a live one through a short scroll away, and releases it once well away', () => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('innerHeight', 800); vi.stubGlobal('innerWidth', 1200)
  // A stream that scrolls, 600px tall at the top of the window, holding previews 300px apart.
  const stream = document.createElement('div'); stream.style.overflowY = 'auto'; document.body.append(stream)
  vi.spyOn(stream, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1200, 600))
  let scrolled = 0
  const at = (i: number): DOMRect => new DOMRect(0, i * 300 - scrolled, 480, 270)
  for (let i = 0; i < 12; i++) {
    const thumb: Thumbnail = measured({ key: `s${i}`, shuttleBase: '', file: { fullPath: `/s${i}.html`, owner: 'host', basename: `s${i}.html` }, fallback: '',
      priority: () => thumb.screenPriority(), distance: () => thumb.gap() })
    vi.spyOn(thumb.el, 'getClientRects').mockReturnValue([at(i)] as unknown as DOMRectList)
    vi.spyOn(thumb.el, 'getBoundingClientRect').mockImplementation(() => at(i))
    thumbs.push(thumb); stream.append(thumb.el)
  }
  const states = (): string => thumbs.map(t => t.state[0]).join('')
  pumpThumbnails()
  // On screen (0, 1) and within the ring (2, whose top is 0px below; 3 at 300px) load; the rest wait.
  expect(states()).toBe('lllliiiiiiii')
  // Still loading and scrolled out of the ring, a load gives its slot to what is near.
  scrolled = 1500; pumpThumbnails()
  expect(thumbs.slice(0, 3).map(t => t.state)).toStrictEqual(['idle', 'idle', 'idle'])
  scrolled = 0; pumpThumbnails()
  renderer.finishes.splice(0).forEach(f => f()); pumpThumbnails()
  expect(states()).toBe('lllliiiiiiii')
  // A short scroll down: 0 and 1 are within the keep ring and stay live; 4 and 5 come near and load.
  scrolled = 900; pumpThumbnails()
  expect(states().slice(0, 6)).toBe('llllll')
  // Well away: the first previews are released and their bodies gone.
  scrolled = 3000; pumpThumbnails()
  expect(thumbs.slice(0, 4).map(t => [t.state, !!t.body])).toEqual(Array(4).fill(['idle', false]))
  stream.remove()
})
