// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildFileViewer, disposeFileViewer, htmlWithBase, htmlAssetUrl } from './FileViewerPanel.js'
import { envelope } from './workspace/DocumentBridge.js'
import { resetDocumentResources } from './documentResources.js'
const ready = (frame: HTMLIFrameElement) => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: envelope('ready') }))
const responseWithBlob = (content: string): Response => new Response(content)
const pdfRenderer = vi.hoisted(() => ({ mount: vi.fn() }))
vi.mock('./pdfViewer.js', () => ({ mountPdfViewer: pdfRenderer.mount }))
afterEach(() => { for (const viewer of document.querySelectorAll<HTMLElement>('.kbn-fileview-frame-wrap')) disposeFileViewer(viewer); vi.unstubAllGlobals(); resetDocumentResources() })

const watch = vi.hoisted(() => ({ content: null as null | ((value: string) => void), error: null as null | ((error: unknown) => void), recover: null as null | (() => void), stop: vi.fn() }))
vi.mock('./LiveFileRefresh.js', () => ({ watchLiveFile: vi.fn((_url, content, error, options) => {
  watch.content = content
  watch.error = error
  watch.recover = options?.onRecover
  return Object.assign(watch.stop, { suspend: vi.fn(), resume: vi.fn(async () => {}) })
}) }))
beforeEach(() => {
  document.body.replaceChildren()
  watch.stop.mockClear()
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
  pdfRenderer.mount.mockReset().mockImplementation((host: HTMLElement, _bytes: ArrayBuffer, ready: () => void) => {
    const rendered = document.createElement('div')
    rendered.className = 'pdfViewer'
    rendered.textContent = 'Rendered PDF pages'
    host.replaceChildren(rendered)
    ready()
    return { ready: Promise.resolve(), dispose: () => host.replaceChildren() }
  })
})

describe('workspace file viewer hooks', () => {
  it('releases a thumbnail image source when its body is unmounted', () => {
    const viewer = buildFileViewer('', '/plot.svg', 'host-a', undefined, undefined, { thumbnail: true })
    const image = viewer.querySelector('img')!
    expect(image.hasAttribute('src')).toBe(true)
    disposeFileViewer(viewer)
    expect(image.hasAttribute('src')).toBe(false)
  })
  it('draws a PDF thumbnail as a glyph without creating a native viewer, while reading its title', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('%PDF-1.4 /Title (A paper)', { headers: { ETag: 'pdf-preview' } })))
    const onThumbnailSource = vi.fn(), onState = vi.fn()
    const viewer = buildFileViewer('', '/paper.pdf', 'host-a', undefined, undefined, { thumbnail: true, onThumbnailSource, onState })
    expect(viewer.querySelector('iframe')).toBeNull()
    expect(viewer.querySelector('.kbn-thumbnail-kind')?.textContent).toBe('▧')
    expect(viewer.querySelector('.kbn-thumbnail-name')?.textContent).toBe('paper.pdf')
    await vi.waitFor(() => expect(onThumbnailSource).toHaveBeenCalled())
    expect(onState).toHaveBeenCalledWith({ status: 'ready' })
    disposeFileViewer(viewer)
  })
  it('sends full thumbnail source to title metadata but only lightweight markup to the frame', async () => {
    const source = `<title>Full report</title><body><img src="data:image/png;base64,${'a'.repeat(100000)}"><script>run()</script><h1>Report</h1>${'body '.repeat(20000)}`
    vi.stubGlobal('fetch', vi.fn(async () => new Response(source, { headers: { ETag: 'preview-test' } })))
    const onThumbnailSource = vi.fn()
    const viewer = buildFileViewer('', '/preview.html', 'host-a', undefined, undefined, { thumbnail: true, onThumbnailSource })
    await vi.waitFor(() => expect(onThumbnailSource).toHaveBeenCalledWith(source, 'preview-test'))
    const frame = viewer.querySelector('iframe')!
    expect(frame.srcdoc.length).toBeLessThan(50000)
    expect(frame.srcdoc).not.toContain('run()')
    expect(frame.srcdoc).not.toContain('a'.repeat(1000))
    disposeFileViewer(viewer)
  })
  it.each([
    '<!doctype html><html><head><style>img { max-width: 42%; }</style></head><body><img width="3000" height="600"></body></html>',
    '<html><body><svg width="3000"></svg></body></html>',
    '<!doctype html><img width="3000">',
    '<base href="assets/"><video width="3000"></video>',
  ])('installs overridable, idempotent media defaults in HTML: %s', html => {
    const source = htmlWithBase(html, 'https://board.test/report.html')
    const doc = new DOMParser().parseFromString(source, 'text/html')
    expect(doc.querySelector('[data-shuttle-media-fit]')?.textContent).toBe('@layer shuttle-media-fit { :where(img, svg, video, canvas) { max-width: 100%; height: auto; } }')
    expect(doc.querySelector('img,svg,video')?.getAttribute('width')).toBe('3000')
    expect(new DOMParser().parseFromString(htmlWithBase(source, 'https://board.test/report.html'), 'text/html').querySelectorAll('[data-shuttle-media-fit]')).toHaveLength(1)
    if (html.includes('<style>')) expect([...doc.querySelectorAll('style')].at(-1)?.textContent).toBe('img { max-width: 42%; }')
  })
  it('resolves sibling and nested report assets under the byte-owning host', () => {
    const asset = htmlAssetUrl('https://board.test/api/v1/file?path=%2Fproject%2Freport%20dir%2Findex.html&origin=host-b')
    expect(asset).toBe('https://board.test/api/v1/file-assets/host-b/project/report%20dir/index.html')
    expect(new URL('images/figure.svg', asset).href).toBe('https://board.test/api/v1/file-assets/host-b/project/report%20dir/images/figure.svg')
    const source = htmlWithBase('<!doctype html><body><img src="figure.png"></body>', asset)
    expect(new DOMParser().parseFromString(source, 'text/html').querySelector('base')!.href).toBe(asset)
    const relativeBase = htmlWithBase('<head><base href="assets/"></head>', asset)
    expect(new DOMParser().parseFromString(relativeBase, 'text/html').querySelector('base')!.href).toBe('https://board.test/api/v1/file-assets/host-b/project/report%20dir/assets/')
    expect(htmlWithBase('<base href="https://cdn.test/">', asset)).toContain('https://cdn.test/')
  })
  it('transforms srcdoc before assignment and leaves old HTML visible until replacement load', () => {
    const onState = vi.fn(), onFrame = vi.fn()
    const viewer = buildFileViewer('', '/report.html', 'host-a', onFrame, undefined, {
      transformHtml: (html) => html + '<script>bridge()</script>', onState, quietLoading: true,
    })
    document.body.append(viewer)
    expect(viewer.querySelector('.kbn-fileview-loading')?.textContent).toBe('')
    watch.content!('<h1>First</h1>')
    const initial = viewer.querySelector('iframe')!
    expect(initial.srcdoc).toContain('<base href=')
    expect(initial.srcdoc).toContain('<script>bridge()</script>')
    expect(onState).not.toHaveBeenCalled()
    initial.dispatchEvent(new Event('load'))
    expect(onState).not.toHaveBeenCalled()
    ready(initial)
    expect(onFrame).toHaveBeenCalledWith(initial, false)
    expect(onState).toHaveBeenLastCalledWith({ status: 'ready' })

    watch.content!('<h1>Second</h1>')
    const next = viewer.querySelectorAll('iframe')[1]
    expect(viewer.querySelector('iframe')).toBe(initial)
    expect(initial.srcdoc).toContain('First')
    ready(next)
    expect(viewer.querySelector('iframe')).toBe(next)
    expect(onFrame).toHaveBeenLastCalledWith(next, true)
  })

  it('reports a stale HTML copy and ignores late staging events after disposal', () => {
    const onState = vi.fn()
    const viewer = buildFileViewer('', '/report.html', 'host-a', undefined, undefined, { onState })
    document.body.append(viewer)
    watch.content!('First')
    ready(viewer.querySelector('iframe')!)
    const error = new Error('offline')
    watch.error!(error)
    expect(onState).toHaveBeenLastCalledWith({ status: 'error', error, hasContent: true })
    expect(viewer.querySelector('iframe')!.srcdoc).toContain('First')
    watch.content!('Second')
    const staging = viewer.querySelectorAll('iframe')[1]
    disposeFileViewer(viewer)
    onState.mockClear()
    ready(staging)
    expect(onState).not.toHaveBeenCalled()
    expect(watch.stop).toHaveBeenCalledOnce()
  })

  it('disposes an unready initial bridge when refreshed content becomes ready first', async () => {
    const { frameBridge } = await import('./workspace/DocumentBridge')
    const onWeight = vi.fn()
    const removed = vi.spyOn(window, 'removeEventListener')
    const viewer = buildFileViewer('', '/report.html', 'host-a', undefined, undefined, { onWeight })
    document.body.append(viewer)
    watch.content!('First')
    const first = viewer.querySelector('iframe')!
    expect(frameBridge(first)).toBeDefined()
    watch.content!('Changed before initial readiness')
    const next = viewer.querySelectorAll('iframe')[1]
    ready(next)
    expect(frameBridge(first)).toBeUndefined()
    expect(removed.mock.calls.filter(([event]) => event === 'message')).toHaveLength(1)
    expect(viewer.querySelector('iframe')).toBe(next)
    document.body.append(first)
    ready(first)
    expect(onWeight).toHaveBeenCalledTimes(1)
    disposeFileViewer(viewer)
    expect(removed.mock.calls.filter(([event]) => event === 'message')).toHaveLength(2)
    removed.mockRestore()
  })

  it('keeps media weight monotonic despite forged readiness and resets it for new bytes', () => {
    const onWeight = vi.fn()
    const viewer = buildFileViewer('', '/report.html', 'host-a', undefined, undefined, { onWeight })
    document.body.append(viewer)
    watch.content!('<audio src="song.mp3"></audio>')
    const first = viewer.querySelector('iframe')!
    const message = (frame: HTMLIFrameElement, type: string, payload: Record<string, unknown>): void => {
      window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: envelope(type, payload) }))
    }
    message(first, 'ready', { media: false })
    message(first, 'media', {})
    message(first, 'ready', { media: false })
    expect(onWeight.mock.calls).toEqual([[2]])
    watch.content!('A light replacement')
    ready(viewer.querySelectorAll('iframe')[1])
    expect(onWeight.mock.calls).toEqual([[2], [1]])
  })

  it('waits for changed recovered HTML to load before declaring it ready', () => {
    const onState = vi.fn()
    const viewer = buildFileViewer('', '/report.html', 'host-a', undefined, undefined, { onState })
    document.body.append(viewer)
    watch.content!('First')
    ready(viewer.querySelector('iframe')!)
    watch.error!(new Error('offline'))
    watch.content!('Changed')
    watch.recover!()
    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error' }))
    const staged = viewer.querySelectorAll('iframe')[1]
    ready(staged)
    expect(onState).toHaveBeenLastCalledWith({ status: 'ready' })
  })

  it('honours the workspace kind for text and HTML suffixes outside the shared suffix sets', () => {
    const text = buildFileViewer('', '/events.jsonl', 'host-a', undefined, undefined, { kind: 'text' })
    watch.content!('{"event":"sent"}')
    expect(text.querySelector('iframe')).toBeNull()
    expect(text.textContent).toContain('"event":"sent"')
    const html = buildFileViewer('', '/report.xhtml', 'host-a', undefined, undefined, {
      kind: 'html', transformHtml: (source) => source + '<script>bridge()</script>',
    })
    watch.content!('<h1>Report</h1>')
    expect(html.querySelector('iframe')!.srcdoc).toContain('<script>bridge()</script>')
  })

  it('reports text readiness and preserves its scroll on changed content or failure', () => {
    const onState = vi.fn(), onText = vi.fn()
    const viewer = buildFileViewer('', '/notes.txt', 'host-a', undefined, onText, { onState })
    watch.content!('one')
    viewer.scrollTop = 123
    watch.content!('two')
    expect(viewer.scrollTop).toBe(123)
    expect(onText).toHaveBeenCalledOnce()
    const error = new Error('file request failed: 404')
    watch.error!(error)
    expect(onState).toHaveBeenLastCalledWith({ status: 'error', error, hasContent: true })
    expect(viewer.textContent).toContain('two')
  })

  it('gives validated PDF bytes to the lazy viewer and reports readiness after its first page', async () => {
    const fetcher = vi.fn(async (_src: string, _init?: RequestInit) => responseWithBlob(`%PDF-1.7 ${'x'.repeat(2 * 1024 * 1024)}`))
    vi.stubGlobal('fetch', fetcher)
    const onState = vi.fn(), onWeight = vi.fn()
    const viewer = buildFileViewer('', '/report.pdf', 'host-a', undefined, undefined, { onState, onWeight })
    await vi.waitFor(() => expect(viewer.querySelector('.pdfViewer')?.textContent).toBe('Rendered PDF pages'))
    expect(fetcher.mock.calls[0][0]).toBe('/api/v1/file?path=%2Freport.pdf&origin=host-a')
    expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: 'no-cache' })
    expect(pdfRenderer.mount).toHaveBeenCalledOnce()
    expect(pdfRenderer.mount.mock.calls[0][0]).toBe(viewer.querySelector('.kbn-fileview-pdf-stage'))
    expect(pdfRenderer.mount.mock.calls[0][1]).toBeInstanceOf(ArrayBuffer)
    expect(onWeight).toHaveBeenCalledWith(2)
    expect(onState).toHaveBeenCalledWith({ status: 'ready' })
    disposeFileViewer(viewer)
    expect(viewer.querySelector('.pdfViewer')).toBeNull()
  })

  it('does not create a PDF viewer when its request settles after disposal', async () => {
    let settle!: (response: Response) => void
    const fetcher = vi.fn((_src: string) => new Promise<Response>(resolve => { settle = resolve }))
    vi.stubGlobal('fetch', fetcher)
    const viewer = buildFileViewer('', '/report.pdf', 'host-a')
    disposeFileViewer(viewer)
    settle(responseWithBlob('%PDF-1.7 body'))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(viewer.querySelector('.pdfViewer')).toBeNull()
    expect(pdfRenderer.mount).not.toHaveBeenCalled()
  })

  it('tells an image that exists but cannot be decoded from a missing one', async () => {
    vi.stubGlobal('fetch', vi.fn(async (src: string) => new Response(JSON.stringify(src.includes('gone') ? { exists: false } : { exists: true, size: 9, modified_at: 1 }))))
    const errors: string[] = []
    for (const path of ['/broken.png', '/gone.png']) {
      const viewer = buildFileViewer('', path, 'host-a', undefined, undefined, { onState: state => { if (state.status === 'error') errors.push((state.error as Error).message) } })
      viewer.querySelector('img')!.dispatchEvent(new Event('error'))
    }
    await vi.waitFor(() => expect(errors).toHaveLength(2))
    expect(errors.sort()).toEqual(['file request failed: 404', 'image format is not supported by this browser'])
  })

  it('reports missing PDFs and rejects non-PDF responses before opening the viewer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"missing"}', { status: 404 })))
    const onState = vi.fn()
    const viewer = buildFileViewer('', '/missing.pdf', 'host-a', undefined, undefined, { onState })
    await vi.waitFor(() => expect(onState).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', hasContent: false })))
    expect(viewer.textContent).toContain('404 Not Found')
    expect(onState).not.toHaveBeenCalledWith({ status: 'ready' })

    vi.stubGlobal('fetch', vi.fn(async () => responseWithBlob('<html>error</html>')))
    const invalidState = vi.fn()
    const htmlViewer = buildFileViewer('', '/bad.pdf', 'host-a', undefined, undefined, { onState: invalidState })
    await vi.waitFor(() => expect(invalidState).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', error: expect.objectContaining({ message: 'file request failed: response is not a PDF' }) })))
    expect(htmlViewer.querySelector('.pdfViewer')).toBeNull()
    expect(pdfRenderer.mount).not.toHaveBeenCalled()
  })
})
