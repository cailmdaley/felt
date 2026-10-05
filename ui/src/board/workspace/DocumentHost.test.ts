// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileViewerOptions } from '../FileViewerPanel.js'
import type { WorkspaceDocument } from './documents.js'
import { DocumentHost, withWorkspaceKeyBridge } from './DocumentHost.js'

const render = vi.hoisted(() => ({
  calls: [] as Array<{ viewer: HTMLElement; path: string; owner: string; options: FileViewerOptions; frame?: (frame: HTMLIFrameElement, refreshed: boolean) => void; text?: (pane: HTMLElement) => void }>,
  suspend: vi.fn(), resume: vi.fn(), once: vi.fn(), dispose: vi.fn(), refresh: vi.fn(async () => {}),
}))
vi.mock('../FileViewerPanel.js', () => ({
  buildFileViewer: vi.fn((_base, path, owner, frame, text, options) => {
    const viewer = document.createElement('div')
    viewer.dataset.path = path
    render.calls.push({ viewer, path, owner, options, frame, text })
    return viewer
  }),
  disposeFileViewer: render.dispose, suspendFileViewer: render.suspend, resumeFileViewer: render.resume, loadFileViewerOnce: render.once,
}))
vi.mock('../LiveFileRefresh.js', () => ({ refreshLiveFile: render.refresh }))

const doc = (n: number, owner = 'host-a'): WorkspaceDocument => ({
  key: `${owner}:/doc/${n}.html`, owner, path: `/doc/${n}.html`, name: `${n}.html`, kind: 'html', provenance: [],
})
const docs = Array.from({ length: 18 }, (_, n) => doc(n))
let track: HTMLElement
let host: DocumentHost
const onSelect = vi.fn(), onFrame = vi.fn(), buildProse = vi.fn(() => document.createElement('div'))
beforeEach(() => {
  vi.clearAllMocks()
  render.calls = []
  sessionStorage.clear()
  document.body.replaceChildren()
  track = document.createElement('div')
  document.body.append(track)
  host = new DocumentHost(track, { shuttleBase: '', buildProse, onSelect, onFrame })
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
})
afterEach(() => { host.dispose(); vi.unstubAllGlobals() })
const ready = async (call = render.calls.at(-1)!) => {
  call.options.onState!({ status: 'ready' })
  await Promise.resolve()
}

describe('stable document frames', () => {
  it('creates placeholders, mounts just selection and neighbours, and never reparents on reorder', async () => {
    host.setChannel(docs.slice(0, 5), docs[2].key)
    expect(track.children).toHaveLength(5)
    expect(render.calls.map((call) => call.path)).toEqual([docs[1].path, docs[3].path, docs[2].path])
    expect(render.calls.map((call) => call.options.active)).toEqual([false, false, true])
    expect(onFrame).toHaveBeenCalledTimes(5)
    const original = [...track.children]
    const frame = host.get(docs[2].key)!
    const viewer = frame.viewer
    const content = frame.content
    for (const call of render.calls) await ready(call)
    const observer = new MutationObserver(() => {})
    observer.observe(track, { childList: true })
    const updated = { ...docs[2], name: 'Updated', provenance: [{ kind: 'sent' as const, time: 12 }] }
    host.setChannel([docs[4], updated, docs[3], docs[1], docs[0]], updated.key)
    expect(observer.takeRecords()).toHaveLength(0)
    observer.disconnect()
    expect([...track.children]).toEqual(original)
    expect(frame.viewer).toBe(viewer)
    expect(frame.content).toBe(content)
    expect(frame.doc).toBe(updated)
    host.select(docs[3].key)
    host.select(updated.key)
    expect(render.calls).toHaveLength(4)
    expect(frame.viewer).toBe(viewer)
    expect(frame.el.classList.contains('ws-selected')).toBe(true)
    expect(frame.sheet.inert).toBe(false)
    expect(host.get(docs[3].key)!.sheet.inert).toBe(true)
  })

  it('restores prose scroll after its reading geometry is assigned', async () => {
    const prose = document.createElement('div')
    let laidOut = false, top = 0
    Object.defineProperty(prose, 'scrollTop', { get: () => top, set: (value: number) => { top = laidOut ? value : 0 } })
    buildProse.mockReturnValueOnce(prose)
    const fiber: WorkspaceDocument = { key: 'fiber:host-a:note', owner: 'host-a', path: '/note.md', name: 'Note', kind: 'fiber', provenance: [{ kind: 'fiber' }] }
    sessionStorage.setItem('shuttle:workspace:scroll:' + fiber.key, JSON.stringify({ x: 0, y: 360 }))
    host.setChannel([fiber], fiber.key)
    expect(prose.scrollTop).toBe(0)
    laidOut = true
    await Promise.resolve()
    expect(prose.scrollTop).toBe(360)
    host.parkAll()
    expect(JSON.parse(sessionStorage.getItem('shuttle:workspace:scroll:' + fiber.key)!)).toEqual({ x: 0, y: 360 })
  })

  it('parks a retained document covered and inert without destroying layout or changing its viewer', () => {
    host.setChannel(docs.slice(0, 2), docs[0].key)
    const frame = host.get(docs[0].key)!
    frame.el.style.width = '900px'
    frame.el.style.height = '600px'
    const viewer = frame.viewer
    host.setChannel(docs.slice(2, 4), docs[2].key)
    expect(frame.el.parentElement).toBe(track)
    expect(frame.el.classList.contains('ws-parked')).toBe(true)
    expect(frame.el.inert).toBe(true)
    expect(frame.el.style.display).not.toBe('none')
    expect(frame.el.style.visibility).not.toBe('hidden')
    expect(frame.el.style.width).toBe('900px')
    host.setChannel(docs.slice(0, 2), docs[0].key)
    expect(frame.viewer).toBe(viewer)
    expect(frame.el.classList.contains('ws-parked')).toBe(false)
    host.parkAll()
    expect([...track.children].every((el) => el.classList.contains('ws-parked'))).toBe(true)
  })

  it('loads neighbours once, pauses their subscriptions, and resumes only the selected page', async () => {
    host.setChannel(docs.slice(0, 4), docs[1].key)
    const left = host.get(docs[0].key)!.viewer
    const right = host.get(docs[2].key)!.viewer
    for (const call of render.calls) await ready(call)
    expect(render.suspend).toHaveBeenCalledWith(left)
    expect(render.suspend).toHaveBeenCalledWith(right)
    render.resume.mockClear()
    host.select(docs[2].key)
    expect(render.resume).toHaveBeenCalledWith(right)
    expect(render.resume.mock.calls.filter(([viewer]) => viewer !== null)).toHaveLength(1)
    host.select(docs[2].key)
    expect(render.resume.mock.calls.filter(([viewer]) => viewer !== null)).toHaveLength(1)
    host.parkAll()
    expect(render.suspend).toHaveBeenCalledWith(right)
  })

  it('suspends unfinished off-channel loads and resumes their first load when the channel returns', async () => {
    host.setChannel(docs.slice(0, 2), docs[0].key)
    const selected = host.get(docs[0].key)!.viewer
    const neighbour = host.get(docs[1].key)!.viewer
    render.suspend.mockClear()
    host.setChannel([docs[2]], docs[2].key)
    expect(render.suspend).toHaveBeenCalledWith(selected)
    expect(render.suspend).toHaveBeenCalledWith(neighbour)
    render.resume.mockClear()
    host.setChannel(docs.slice(0, 2), docs[0].key)
    expect(render.resume).toHaveBeenCalledWith(selected)
    expect(render.resume).not.toHaveBeenCalledWith(neighbour)
    expect(render.once).toHaveBeenCalledWith(neighbour)
    const call = render.calls.find((call) => call.viewer === neighbour)!
    await ready(call)
    expect(render.suspend).toHaveBeenCalledWith(neighbour)
    render.suspend.mockClear()
    host.parkAll()
    expect(render.suspend).toHaveBeenCalledWith(selected)
  })

  it('keeps a global LRU of ten across channels and restores evicted text scroll by key', async () => {
    host.setChannel([docs[0]], docs[0].key)
    const first = render.calls[0]
    first.text!(first.viewer)
    first.viewer.scrollTop = 317
    first.viewer.dispatchEvent(new Event('scroll'))
    await ready(first)
    const frame = host.get(docs[0].key)!
    for (let n = 1; n <= 10; n++) {
      host.setChannel([docs[n]], docs[n].key)
      await ready()
    }
    expect([...track.children].filter((el) => el.querySelector('[data-path]'))).toHaveLength(10)
    expect(frame.viewer).toBeNull()
    expect(render.dispose).toHaveBeenCalledWith(first.viewer)
    expect(frame.el.parentElement).toBe(track)
    host.setChannel([docs[0]], docs[0].key)
    const restored = render.calls.at(-1)!
    restored.text!(restored.viewer)
    expect(restored.viewer.scrollTop).toBe(317)
    expect(host.get(docs[0].key)).toBe(frame)
    expect(frame.viewer).not.toBe(first.viewer)
  })

  it('evicts by recency within a long channel without dropping selection or neighbours', async () => {
    host.setChannel(docs, docs[0].key)
    for (let n = 1; n < docs.length; n++) host.select(docs[n].key)
    expect(docs.filter((doc) => host.get(doc.key)!.viewer)).toHaveLength(10)
    expect(host.get(docs[0].key)!.viewer).toBeNull()
    expect(host.get(docs.at(-1)!.key)!.viewer).not.toBeNull()
    expect(host.get(docs.at(-2)!.key)!.viewer).not.toBeNull()
    for (const call of render.calls) await ready(call)
    // Ready notifications from evicted generations cannot resurrect a viewer.
    expect(host.get(docs[0].key)!.viewer).toBeNull()
  })

  it('restores iframe scroll on remount and reconnects the listener on live replacement', async () => {
    sessionStorage.setItem('shuttle:workspace:scroll:' + docs[0].key, JSON.stringify({ x: 4, y: 160 }))
    host.setChannel([docs[0]], docs[0].key)
    const call = render.calls[0]
    const iframe = document.createElement('iframe')
    call.viewer.append(iframe)
    const scrollTo = vi.fn()
    iframe.contentWindow!.scrollTo = scrollTo
    call.frame!(iframe, false)
    expect(scrollTo).toHaveBeenCalledWith(4, 160)
    Object.defineProperty(iframe.contentWindow, 'scrollY', { value: 245, configurable: true })
    iframe.contentWindow!.dispatchEvent(new Event('scroll'))
    expect(JSON.parse(sessionStorage.getItem('shuttle:workspace:scroll:' + docs[0].key)!).y).toBe(245)
    const next = document.createElement('iframe')
    call.viewer.append(next)
    next.contentWindow!.scrollTo = vi.fn()
    call.frame!(next, true)
    expect(next.contentWindow!.scrollTo).not.toHaveBeenCalled()
    await ready(call)
  })

  it('selects receded pages only, uses host-aware identity, and disposes the retained viewers', () => {
    const remote = doc(0, 'host-b')
    host.setChannel([docs[0], remote], docs[0].key)
    host.get(remote.key)!.el.click()
    expect(onSelect).toHaveBeenCalledWith(remote.key)
    onSelect.mockClear()
    host.get(docs[0].key)!.el.click()
    expect(onSelect).not.toHaveBeenCalled()
    expect(render.calls.map((call) => call.owner)).toEqual(['host-b', 'host-a'])
    host.dispose()
    expect(render.dispose).toHaveBeenCalledWith(render.calls[0].viewer)
    expect(render.dispose).toHaveBeenCalledWith(render.calls[1].viewer)
    expect(track.children).toHaveLength(0)
    host.setChannel(docs, docs[0].key)
    expect(track.children).toHaveLength(0)
  })
})

describe('refresh and failure states', () => {
  it('refreshes live HTML without replacing its viewer and keeps a stale copy on owner failure', async () => {
    host.setChannel([docs[0]], docs[0].key)
    const call = render.calls[0]
    await ready(call)
    const viewer = call.viewer
    call.options.onState!({ status: 'error', error: new Error('offline'), hasContent: true })
    await Promise.resolve()
    const frame = host.get(docs[0].key)!
    expect(frame.viewer).toBe(viewer)
    expect(frame.content.textContent).toContain('host-a is unreachable — showing last loaded copy')
    expect(frame.content.querySelector('button')!.textContent).toBe('Retry')
    host.refresh(docs[0].key)
    await Promise.resolve()
    await Promise.resolve()
    expect(render.refresh).toHaveBeenCalledWith('/api/v1/file?path=%2Fdoc%2F0.html&origin=host-a')
    expect(frame.viewer).toBe(viewer)
    expect(frame.el.classList.contains('ws-stale')).toBe(false)
  })

  it('keeps native media visible until replacement readiness and retains it if the replacement fails', async () => {
    const pdf = { ...docs[0], kind: 'pdf' as const, path: '/report.pdf' }
    host.setChannel([pdf], pdf.key)
    const frame = host.get(pdf.key)!
    const original = frame.viewer
    await ready()
    host.refresh(pdf.key)
    expect(frame.viewer).toBe(original)
    const replacement = render.calls.at(-1)!
    expect(replacement.viewer.style.opacity).toBe('0')
    replacement.options.onState!({ status: 'error', error: new Error('offline'), hasContent: false })
    await Promise.resolve()
    expect(frame.viewer).toBe(original)
    expect(original!.parentElement).toBe(frame.content)
    expect(replacement.viewer.parentElement).toBeNull()
    host.refresh(pdf.key)
    const good = render.calls.at(-1)!
    await ready(good)
    expect(frame.viewer).toBe(good.viewer)
    expect(original!.parentElement).toBeNull()
    expect(frame.content.querySelector('.ws-document-status')).toBeNull()
  })

  it('shows missing paths and delegates unsupported files to the shared kind renderer', async () => {
    host.setChannel([docs[0]], docs[0].key)
    render.calls[0].options.onState!({ status: 'error', error: new Error('file request failed: 404'), hasContent: false })
    await Promise.resolve()
    expect(host.get(docs[0].key)!.content.textContent).toContain('Not found on host-a')
    expect(host.get(docs[0].key)!.content.querySelector('code')!.textContent).toBe(docs[0].path)
    const archive = { ...doc(18), path: '/archive.zip', name: 'archive.zip', kind: 'other' as const }
    host.setChannel([archive], archive.key)
    expect(render.calls).toHaveLength(2)
    expect(render.calls[1].options.kind).toBe('other')
    await ready(render.calls[1])
    host.refresh(archive.key)
    expect(render.calls).toHaveLength(3)
    expect(render.calls[2].options.kind).toBe('other')
  })

  it('lets the controller fetch fresh prose without rebuilding cached content on Refresh', async () => {
    host.dispose()
    const onRefreshProse = vi.fn(async () => {})
    host = new DocumentHost(track, { shuttleBase: '', buildProse, onSelect, onRefreshProse })
    const fiber = { ...docs[0], kind: 'fiber' as const }
    host.setChannel([fiber], fiber.key)
    const viewer = host.get(fiber.key)!.viewer
    const builds = buildProse.mock.calls.length
    host.refresh(fiber.key)
    expect(onRefreshProse).toHaveBeenCalledWith(fiber)
    expect(buildProse).toHaveBeenCalledTimes(builds)
    expect(host.get(fiber.key)!.viewer).toBe(viewer)
  })

  it('ignores a staged load after disposal and removes all retained subscriptions', async () => {
    const pdf = { ...docs[0], path: '/report.pdf', kind: 'pdf' as const }
    host.setChannel([pdf], pdf.key)
    await ready()
    host.refresh(pdf.key)
    const staged = render.calls.at(-1)!
    host.dispose()
    staged.options.onState!({ status: 'ready' })
    await Promise.resolve()
    expect(track.children).toHaveLength(0)
    expect(render.dispose).toHaveBeenCalledWith(staged.viewer)
  })

  it('updates only mounted prose while preserving its scroll and every file viewer', () => {
    const fiber = { ...docs[0], kind: 'fiber' as const }
    host.setChannel([fiber, docs[1]], fiber.key)
    const prose = host.get(fiber.key)!.viewer!
    const file = host.get(docs[1].key)!.viewer
    prose.scrollTop = 99
    const replacement = document.createElement('div')
    host.updateProse(fiber.key, replacement)
    expect(host.get(fiber.key)!.viewer).toBe(replacement)
    expect(replacement.scrollTop).toBe(99)
    expect(host.get(docs[1].key)!.viewer).toBe(file)
    host.updateProse(docs[1].key, document.createElement('div'))
    expect(host.get(docs[1].key)!.viewer).toBe(file)
  })
})

describe('document keyboard bridge', () => {
  it('lets document and report load-time window handlers consume Escape before forwarding', async () => {
    const iframe = document.createElement('iframe')
    document.body.append(iframe)
    const win = iframe.contentWindow!
    const report = iframe.contentDocument!
    const postMessage = vi.fn()
    const markup = document.createElement('div')
    markup.innerHTML = withWorkspaceKeyBridge('<html><head></head><body>Report</body></html>')
    const script = markup.querySelector('script')!.textContent!
    new Function('window', 'parent', script)(win, { postMessage })
    let documentDialog = true, windowDialog = true
    report.addEventListener('keydown', e => { if (documentDialog && e.key === 'Escape') e.preventDefault() })
    win.addEventListener('load', () => {
      win.addEventListener('keydown', e => { if (windowDialog && e.key === 'Escape') e.preventDefault() })
    }, { once: true })
    win.dispatchEvent(new Event('load'))
    await new Promise(resolve => setTimeout(resolve, 0))
    const press = (key: string, altKey = false) => report.body.dispatchEvent(new KeyboardEvent('keydown', { key, altKey, bubbles: true, cancelable: true }))
    press('Escape')
    expect(postMessage).not.toHaveBeenCalled()
    documentDialog = false
    press('Escape')
    expect(postMessage).not.toHaveBeenCalled()
    windowDialog = false
    press('Escape')
    expect(postMessage).toHaveBeenCalledOnce()
    expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'Escape' }), '*')
    press('ArrowRight', true)
    expect(postMessage).toHaveBeenCalledTimes(2)
    iframe.remove()
  })

  it('adds the script in head without changing document content', () => {
    const html = withWorkspaceKeyBridge('<html><head><title>Report</title></head><body>Data</body></html>')
    expect(html).toContain('<head><script data-shuttle-workspace-bridge>')
    expect(html).toContain("type:'shuttle-workspace-key'")
    expect(html).toContain('function keyIntent(event, surface')
    expect(html).toContain('<body>Data</body>')
  })

  it('forwards only valid chords from the selected viewer source, never parked or foreign frames', () => {
    host.setChannel(docs.slice(0, 2), docs[0].key)
    const selected = document.createElement('iframe')
    const receded = document.createElement('iframe')
    host.get(docs[0].key)!.viewer!.append(selected)
    host.get(docs[1].key)!.viewer!.append(receded)
    const keydown = vi.fn()
    track.addEventListener('keydown', keydown)
    const send = (source: Window | null, data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { source, data }))
    const arrow = { type: 'shuttle-workspace-key', key: 'ArrowRight', altKey: true }
    send(receded.contentWindow, arrow)
    send(window, arrow)
    send(selected.contentWindow, { ...arrow, altKey: false })
    expect(keydown).toHaveBeenCalledOnce()
    expect(keydown.mock.calls[0][0].key).toBe('ArrowRight')
    expect(keydown.mock.calls[0][0].altKey).toBe(false)
    send(selected.contentWindow, { ...arrow, ctrlKey: true })
    send(selected.contentWindow, { ...arrow, key: 'Delete' })
    expect(keydown).toHaveBeenCalledOnce()
    send(selected.contentWindow, arrow)
    expect(keydown).toHaveBeenCalledTimes(2)
    expect(keydown.mock.calls[1][0].key).toBe('ArrowRight')
    expect(keydown.mock.calls[1][0].altKey).toBe(true)
    send(selected.contentWindow, { type: 'shuttle-workspace-key', key: 'Escape' })
    expect(keydown).toHaveBeenCalledTimes(3)
    host.parkAll()
    send(selected.contentWindow, arrow)
    expect(keydown).toHaveBeenCalledTimes(3)
  })
})
