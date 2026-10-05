// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
const renderer = vi.hoisted(() => ({ finishes: [] as Array<() => void> }))
vi.mock('../FileViewerPanel.js', () => ({
  readThumbnailMetadata: vi.fn(async () => {}),
  buildFileViewer: vi.fn((_base, _path, _owner, _frame, _scroll, options) => {
    const body = document.createElement('div'); body.append(document.createElement('iframe'))
    renderer.finishes.push(() => options.onState({ status: 'ready' }))
    return body
  }),
  disposeFileViewer: vi.fn(),
}))
import { cacheDocumentTitle } from './DocumentTitles.js'
import { docKey } from './documents.js'
import { Thumbnail, pumpThumbnails } from './Thumbnail.js'
let thumbs: Thumbnail[] = []
afterEach(() => { for (const thumb of thumbs) thumb.dispose(); thumbs = []; renderer.finishes = []; vi.unstubAllGlobals() })
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
    const thumb = new Thumbnail({ key: String(i), shuttleBase: '', file: { fullPath: `/${i}.html`, owner: 'host', basename: `${i}.html` }, fallback: '',
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
  const tab = new Thumbnail({ key: 'selected-tab', shuttleBase: '', file: { fullPath: '/selected.html', owner: 'host', basename: 'selected.html' }, fallback: '', priority: () => 3, distance: () => 0 })
  thumbs.push(tab); document.body.append(tab.el)
  pumpThumbnails()
  expect(tab.state).toBe('loading')
  expect(thumbs.filter(t => t.body)).toHaveLength(16)
})
