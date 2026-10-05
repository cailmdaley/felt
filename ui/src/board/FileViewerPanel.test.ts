// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildFileViewer, disposeFileViewer } from './FileViewerPanel.js'

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
    expect(onFrame).toHaveBeenCalledWith(initial, false)
    expect(onState).toHaveBeenLastCalledWith({ status: 'ready' })

    watch.content!('<h1>Second</h1>')
    const next = viewer.querySelectorAll('iframe')[1]
    expect(viewer.querySelector('iframe')).toBe(initial)
    expect(initial.srcdoc).toContain('First')
    next.contentWindow!.scrollTo = vi.fn()
    next.dispatchEvent(new Event('load'))
    expect(viewer.querySelector('iframe')).toBe(next)
    expect(onFrame).toHaveBeenLastCalledWith(next, true)
  })

  it('reports a stale HTML copy and ignores late staging events after disposal', () => {
    const onState = vi.fn()
    const viewer = buildFileViewer('', '/report.html', 'host-a', undefined, undefined, { onState })
    watch.content!('First')
    viewer.querySelector('iframe')!.dispatchEvent(new Event('load'))
    const error = new Error('offline')
    watch.error!(error)
    expect(onState).toHaveBeenLastCalledWith({ status: 'error', error, hasContent: true })
    expect(viewer.querySelector('iframe')!.srcdoc).toContain('First')
    watch.content!('Second')
    const staging = viewer.querySelectorAll('iframe')[1]
    disposeFileViewer(viewer)
    onState.mockClear()
    staging.dispatchEvent(new Event('load'))
    expect(onState).not.toHaveBeenCalled()
    expect(watch.stop).toHaveBeenCalledOnce()
  })

  it('waits for changed recovered HTML to load before declaring it ready', () => {
    const onState = vi.fn()
    const viewer = buildFileViewer('', '/report.html', 'host-a', undefined, undefined, { onState })
    document.body.append(viewer)
    watch.content!('First')
    viewer.querySelector('iframe')!.dispatchEvent(new Event('load'))
    watch.error!(new Error('offline'))
    watch.content!('Changed')
    watch.recover!()
    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error' }))
    const staged = viewer.querySelectorAll('iframe')[1]
    staged.contentWindow!.scrollTo = vi.fn()
    staged.dispatchEvent(new Event('load'))
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

  it('waits for both native frame load and a successful HEAD before reporting ready', async () => {
    let settle!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { settle = resolve })))
    const onState = vi.fn()
    const viewer = buildFileViewer('', '/report.pdf', 'host-a', undefined, undefined, { onState })
    viewer.querySelector('iframe')!.dispatchEvent(new Event('load'))
    expect(onState).not.toHaveBeenCalled()
    settle(new Response('', { status: 200 }))
    await Promise.resolve()
    expect(onState).toHaveBeenCalledWith({ status: 'ready' })
  })

  it('reports missing native documents even when an HTTP error page loads', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    const onState = vi.fn()
    const viewer = buildFileViewer('', '/report.pdf', 'host-a', undefined, undefined, { onState })
    await Promise.resolve()
    viewer.querySelector('iframe')!.dispatchEvent(new Event('load'))
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', hasContent: false }))
    expect(onState).not.toHaveBeenCalledWith({ status: 'ready' })
  })
})
