// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildFileViewer, disposeFileViewer, htmlWithBase, htmlAssetUrl } from './FileViewerPanel.js'
import { envelope } from './workspace/DocumentBridge.js'
import { resetDocumentResources } from './documentResources.js'
const ready = (frame: HTMLIFrameElement) => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: envelope('ready') }))
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
})

describe('workspace file viewer hooks', () => {
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

  it('waits for both native frame load and the owner confirming the file before reporting ready', async () => {
    let settle!: (value: Response) => void
    const fetcher = vi.fn((_src: string) => new Promise<Response>((resolve) => { settle = resolve }))
    vi.stubGlobal('fetch', fetcher)
    const onState = vi.fn()
    const viewer = buildFileViewer('', '/report.pdf', 'host-a', undefined, undefined, { onState })
    viewer.querySelector('iframe')!.dispatchEvent(new Event('load'))
    expect(onState).not.toHaveBeenCalled()
    expect(fetcher.mock.calls[0][0]).toBe('/api/v1/file-info?path=%2Freport.pdf&origin=host-a')
    settle(new Response(JSON.stringify({ exists: true, size: 598, modified_at: 1 })))
    await vi.waitFor(() => expect(onState).toHaveBeenCalledWith({ status: 'ready' }))
  })

  it('reports missing native documents even when an HTTP error page loads', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ exists: false }))))
    const onState = vi.fn()
    const viewer = buildFileViewer('', '/missing.pdf', 'host-a', undefined, undefined, { onState })
    viewer.querySelector('iframe')!.dispatchEvent(new Event('load'))
    await vi.waitFor(() => expect(onState).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', hasContent: false })))
    expect(viewer.textContent).toContain('404 Not Found')
    expect(onState).not.toHaveBeenCalledWith({ status: 'ready' })
  })
})
