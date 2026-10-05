// @vitest-environment node
// @ts-expect-error Node types are excluded from the browser UI's tsconfig.
import { createRequire } from 'node:module'
import type * as Esbuild from 'esbuild'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as HostModule from './DocumentHost.js'
import type * as ViewerModule from '../FileViewerPanel.js'
import type * as KeymapModule from '../keymap.js'
import type { WorkspaceDocument } from './documents.js'

type Production = typeof HostModule & typeof ViewerModule & typeof KeymapModule
let production: Production
let bundle: string
let host: HostModule.DocumentHost
let track: HTMLElement
let reportHtml: string
let errors: unknown[]
let browser: { window: Window & typeof globalThis; close: () => void }
const messages = vi.fn()
const app = vi.fn()
const select = vi.fn()
const documents: WorkspaceDocument[] = [0, 1].map(n => ({
  key: `host-a:/report-${n}.html`, owner: 'host-a', path: `/report-${n}.html`,
  name: `report-${n}.html`, kind: 'html', provenance: [],
}))

beforeAll(async () => {
  // Compile only this in-memory entry, with the production minifier defaults.
  // No keepNames or externalized keymap: toString must survive real aliasing.
  // Compile in Node's realm, before creating the browser realm.
  const { build } = createRequire(import.meta.url)('esbuild') as typeof Esbuild
  const result = await build({
    stdin: {
      contents: `export { DocumentHost, withWorkspaceKeyBridge } from './src/board/workspace/DocumentHost.js';
        export { buildFileViewer, disposeFileViewer } from './src/board/FileViewerPanel.js';
        export { keyIntent } from './src/board/keymap.js';`,
      resolveDir: new URL('../../../', import.meta.url).pathname,
      sourcefile: 'workspace-bridge-test-entry.ts', loader: 'ts',
    },
    bundle: true, minify: true, write: false, platform: 'browser',
    format: 'iife', globalName: '__workspaceProduction', target: 'es2022',
    loader: { '.css': 'empty' },
  })
  bundle = result.outputFiles[0].text
})

beforeEach(() => {
  vi.clearAllMocks()
  const { JSDOM } = createRequire(import.meta.url)('jsdom')
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'http://workspace.test/', runScripts: 'dangerously', pretendToBeVisual: true,
  })
  browser = { window: dom.window, close: () => dom.window.close() }
  for (const name of ['window', 'document', 'sessionStorage', 'KeyboardEvent', 'MessageEvent', 'Event'] as const) {
    vi.stubGlobal(name, name === 'window' ? browser.window : browser.window[name])
  }
  errors = []
  reportHtml = '<!doctype html><html><head></head><body><p id="report">Report</p></body></html>'
  const fetchFile = vi.fn(async () => new Response(reportHtml, { status: 200 }))
  vi.stubGlobal('fetch', fetchFile)
  browser.window.fetch = fetchFile
  const script = document.createElement('script')
  script.textContent = bundle
  document.head.append(script)
  script.remove()
  production = (window as unknown as { __workspaceProduction: Production }).__workspaceProduction
  track = document.createElement('div')
  document.body.append(track)
  host = new production.DocumentHost(track, {
    shuttleBase: '', buildProse: () => document.createElement('div'), onSelect: select,
  })
  document.addEventListener('keydown', onAppKey)
})

afterEach(() => {
  host.dispose()
  document.removeEventListener('keydown', onAppKey)
  browser.close()
  vi.unstubAllGlobals()
  expect(errors).toEqual([])
})

function onAppKey(event: KeyboardEvent): void {
  const intent = production.keyIntent(event, 'reader')
  if (intent) app(intent, {
    key: event.key, repeat: event.repeat, metaKey: event.metaKey, ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey, altKey: event.altKey, target: event.target,
  })
}

async function report(doc = documents[0]): Promise<HTMLIFrameElement> {
  host.setChannel(documents, doc.key)
  let iframe: HTMLIFrameElement
  await vi.waitFor(() => {
    iframe = host.get(doc.key)!.viewer!.querySelector('iframe')!
    expect(iframe?.srcdoc).not.toBe('')
  })
  const frame = iframe!
  const win = frame.contentWindow!
  win.addEventListener('error', event => { errors.push(event.error ?? event.message); event.preventDefault() })
  win.scrollTo = vi.fn()
  // JSDOM doesn't navigate srcdoc and doesn't populate MessageEvent.source.
  // Execute the renderer's actual srcdoc in its iframe; adapt only transport,
  // preserving the real frame Window identity for DocumentHost's source gate.
  const parent = {
    postMessage(data: unknown, origin: string) {
      messages(data, origin)
      window.dispatchEvent(new MessageEvent('message', { data, source: win }))
    },
  }
  Object.defineProperty(win, 'parent', { configurable: true, value: parent })
  win.postMessage = (data: unknown) => win.dispatchEvent(new browser.window.MessageEvent('message', { data, source: parent as unknown as Window }))
  ;(win as Window & typeof globalThis).HTMLMediaElement.prototype.pause = vi.fn()
  ;(win as Window & typeof globalThis).matchMedia = () => ({ matches: true } as MediaQueryList)
  // JSDOM cannot create trusted input. A test-only listener facade exercises
  // positive bridge semantics; Chrome e2e verifies genuine trusted input.
  const add = win.addEventListener.bind(win)
  win.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions | boolean) => {
    add(type, type === 'keydown' ? (event: Event) => listener(new Proxy(event, {
      get(target, property) {
        if (property === 'isTrusted') return (win as Window & { trustedTestKey?: boolean }).trustedTestKey === true
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })) : listener, options)
  }) as Window['addEventListener']
  frame.contentDocument!.open()
  frame.contentDocument!.write(frame.srcdoc)
  frame.contentDocument!.close()
  win.dispatchEvent(new Event('load'))
  await new Promise(resolve => win.setTimeout(resolve, 0))
  messages.mockClear()
  return frame
}

function press(frame: HTMLIFrameElement, key: string, init: KeyboardEventInit = {}, selector = 'body', trusted = true): KeyboardEvent {
  const win = frame.contentWindow! as Window & typeof globalThis & { trustedTestKey: boolean }
  win.trustedTestKey = trusted
  const event = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  frame.contentDocument!.querySelector(selector)!.dispatchEvent(event)
  return event
}

describe('minified production document keyboard bridge', () => {
  it('rejects direct report keys that write, open controls or transport media, while retaining navigation', async () => {
    const frame = await report()
    const send = (key: string, extra = {}) => window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow, data: { protocol: 'shuttle-document', version: 1, type: 'key', payload: { key, ...extra } },
    }))
    for (const key of ['x', 't', 'z', '.', 'c', 'r', 'p', ',', '>', 'Enter', 'o']) send(key)
    expect(app).not.toHaveBeenCalled()
    send('ArrowDown'); send('ArrowRight', { altKey: true })
    expect(app.mock.calls.map(([intent]) => intent)).toEqual(['scrollDown', 'next'])
  })

  it('does not forward an untrusted library-generated key event', async () => {
    const frame = await report()
    press(frame, 'ArrowRight', { altKey: true }, 'body', false)
    expect(messages).not.toHaveBeenCalled()
    expect(app).not.toHaveBeenCalled()
  })
  it('executes serialized functions and bubbles unhandled reader chords through the selected host to the app', async () => {
    const frame = await report()
    const keys: Array<[string, KeyboardEventInit, string]> = [
      ['h', {}, 'prev'], ['l', {}, 'next'],
      ['s', {}, 'sidebar'], ['/', {}, 'find'],
      ['j', {}, 'nextChannel'], ['k', {}, 'prevChannel'],
      ['ArrowDown', { repeat: true }, 'scrollDown'], ['?', { shiftKey: true }, 'help'],
      ['\\', { metaKey: true }, 'sidebar'], ['\\', { ctrlKey: true }, 'sidebar'],
    ]
    for (const [key, init, intent] of keys) {
      expect(press(frame, key, init).defaultPrevented).toBe(true)
      expect(app).toHaveBeenLastCalledWith(intent, expect.objectContaining({ key, target: track, ...init }))
      expect(messages).toHaveBeenLastCalledWith(expect.objectContaining({ protocol: 'shuttle-document', version: 1, type: 'key', payload: expect.objectContaining({ key, ...init }) }), '*')
    }
    expect(app).toHaveBeenCalledTimes(keys.length)
    expect(messages).toHaveBeenCalledTimes(keys.length)
    press(frame, '?', { repeat: true })
    press(frame, 'Escape', { repeat: true })
    press(frame, 'Delete')
    press(frame, 'J', { shiftKey: true })
    press(frame, 'K', { shiftKey: true })
    press(frame, 'l', { ctrlKey: true })
    expect(app).toHaveBeenCalledTimes(keys.length)
    expect(messages).toHaveBeenCalledTimes(keys.length)
  })

  it('gives report document and load-time window handlers first refusal', async () => {
    reportHtml = `<html><head><script>
      window.documentDialog = true; window.windowDialog = true;
      document.addEventListener('keydown', function(e) {
        if (window.documentDialog && e.key === 'Escape') e.preventDefault();
        if (e.key === 'h') e.stopPropagation();
      });
      window.addEventListener('load', function() {
        window.addEventListener('keydown', function(e) {
          if (window.windowDialog && e.key === 'Escape') e.preventDefault();
        });
      }, {once: true});
    </script></head><body>Dialog report</body></html>`
    const frame = await report()
    const win = frame.contentWindow! as Window & { documentDialog: boolean; windowDialog: boolean }
    press(frame, 'Escape')
    expect(messages).not.toHaveBeenCalled()
    win.documentDialog = false
    press(frame, 'Escape')
    expect(messages).not.toHaveBeenCalled()
    win.windowDialog = false
    press(frame, 'h')
    expect(messages).not.toHaveBeenCalled()
    press(frame, 'Escape')
    expect(app).toHaveBeenCalledExactlyOnceWith('back', expect.objectContaining({ key: 'Escape' }))
  })

  it('leaves editable fields and their descendants alone, including command and alt chords', async () => {
    reportHtml = `<html><head></head><body>
      <input id="input"><textarea id="textarea"></textarea><select id="select"><option>One</option></select>
      <div role="textbox" id="textbox"></div><div contenteditable="true"><span id="editable">Text</span></div>
      <div contenteditable=""><span id="empty-editable">Text</span></div>
      <div contenteditable="false" id="readonly">Report</div>
    </body></html>`
    const frame = await report()
    for (const id of ['input', 'textarea', 'select', 'textbox', 'editable', 'empty-editable']) {
      for (const [key, init] of [['j', {}], ['\\', { metaKey: true }], ['ArrowRight', { altKey: true }]] as const) {
        expect(press(frame, key, init, '#' + id).defaultPrevented).toBe(false)
      }
    }
    expect(messages).not.toHaveBeenCalled()
    press(frame, 'ArrowDown', {}, '#readonly')
    expect(app).toHaveBeenCalledExactlyOnceWith('scrollDown', expect.anything())
  })

  it('preserves native control activation and composite navigation while forwarding unrelated reader keys', async () => {
    reportHtml = `<html><head></head><body>
      <button><span id="button">Open</span></button><a href="#" id="link">Link</a>
      <details><summary id="summary">Details</summary></details><div role="checkbox" id="checkbox"></div>
      <div role="slider"><span id="slider">Value</span></div><div role="tablist" id="tabs"></div>
      <audio id="audio" controls></audio><video id="video" controls></video>
    </body></html>`
    const frame = await report()
    for (const id of ['button', 'link', 'summary', 'checkbox']) {
      for (const key of ['Enter', ' ']) expect(press(frame, key, {}, '#' + id).defaultPrevented).toBe(false)
    }
    for (const id of ['slider', 'tabs']) {
      for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']) {
        expect(press(frame, key, {}, '#' + id).defaultPrevented).toBe(false)
      }
    }
    for (const id of ['audio', 'video']) expect(press(frame, 'j', {}, '#' + id).defaultPrevented).toBe(false)
    expect(messages).not.toHaveBeenCalled()
    press(frame, 'h', {}, '#button')
    press(frame, 'ArrowRight', { altKey: true }, '#slider')
    expect(app.mock.calls.map(([intent]) => intent)).toEqual(['prev', 'next'])
  })

  it('ignores executed bridges from receded or parked frames and messages from foreign sources', async () => {
    const first = await report(documents[0])
    const second = await report(documents[1])
    press(first, 'l')
    expect(messages).toHaveBeenCalledOnce()
    expect(app).not.toHaveBeenCalled()
    const data = { protocol: 'shuttle-document', version: 1, type: 'key', payload: { key: 'l' } }
    for (const source of [window, null]) window.dispatchEvent(new MessageEvent('message', { source, data }))
    expect(app).not.toHaveBeenCalled()
    press(second, 'l')
    expect(app).toHaveBeenCalledOnce()
    host.setChannel([documents[1]], documents[1].key)
    press(first, 'j')
    expect(app).toHaveBeenCalledOnce()
    host.parkAll()
    press(second, 'j')
    expect(app).toHaveBeenCalledOnce()
  })

  it('scrolls, caches nested scrollers and saves/restores positions through parent-only commands', async () => {
    const frame = await report()
    const content = frame.contentDocument!
    const main = content.createElement('main')
    main.style.overflowY = 'auto'
    main.style.lineHeight = '20px'
    Object.defineProperties(main, { clientHeight: { value: 200 }, clientWidth: { value: 600 }, scrollHeight: { value: 3000 } })
    main.scrollTo = vi.fn(({ top, left }: ScrollToOptions) => { main.scrollTop = top ?? 0; main.scrollLeft = left ?? 0 }) as HTMLElement['scrollTo']
    main.scrollBy = vi.fn(({ top }: ScrollToOptions) => { main.scrollTop += top ?? 0; main.dispatchEvent(new Event('scroll')) }) as HTMLElement['scrollBy']
    content.body.append(main)
    const walk = vi.spyOn(content, 'querySelectorAll')
    const command = (type: string, payload: Record<string, unknown>, source = frame.contentWindow!.parent) => {
      frame.contentWindow!.dispatchEvent(new MessageEvent('message', { source, data: { protocol: 'shuttle-document', version: 1, type, payload } }))
    }
    command('restore', { x: 2, y: 160 }, window)
    expect(main.scrollTop).toBe(0)
    command('active', { active: true })
    for (const [intent, amount] of [['scrollDown', 60], ['scrollUp', -60], ['halfDown', 100], ['halfUp', -100], ['pageDown', 200], ['pageUp', -200]] as const) {
      command('scroll', { intent, instant: true })
      expect(main.scrollBy).toHaveBeenLastCalledWith({ top: amount, behavior: 'instant' })
    }
    expect(walk.mock.calls.filter(([selector]) => selector === 'body *')).toHaveLength(1)
    command('restore', { x: 2, y: 160 })
    expect(main.scrollTop).toBe(160)
    const key = documents[0].key
    expect(JSON.parse(sessionStorage.getItem('shuttle:workspace:scroll:' + key)!).y).toBe(160)
    host.setChannel([documents[1]], documents[1].key)
    host.setChannel(documents, key)
    expect(host.get(key)!.viewer!.querySelector('iframe')).toBe(frame)
    expect(main.scrollTop).toBe(160)
    main.remove()
    const replacement = content.createElement('main')
    replacement.style.overflowY = 'auto'
    Object.defineProperties(replacement, { clientHeight: { value: 200 }, clientWidth: { value: 600 }, scrollHeight: { value: 3000 } })
    replacement.scrollBy = vi.fn()
    content.body.append(replacement)
    command('scroll', { intent: 'scrollDown', instant: true })
    expect(replacement.scrollBy).toHaveBeenCalledOnce()
  })

  it('preserves an early restore until an asynchronously created nested scroller can hold it', async () => {
    const frame = await report()
    const win = frame.contentWindow!
    const content = frame.contentDocument!
    const command = (type: string, payload: Record<string, unknown>) => win.dispatchEvent(new MessageEvent('message', {
      source: win.parent, data: { protocol: 'shuttle-document', version: 1, type, payload },
    }))
    command('restore', { x: 0, y: 160 })
    command('active', { active: false })
    const key = documents[0].key
    expect(JSON.parse(sessionStorage.getItem('shuttle:workspace:scroll:' + key)!).y).toBe(160)
    const main = content.createElement('main')
    main.style.overflowY = 'auto'
    Object.defineProperties(main, { clientHeight: { value: 200 }, clientWidth: { value: 600 }, scrollHeight: { value: 3000 } })
    main.scrollTo = vi.fn(({ top }: ScrollToOptions) => { main.scrollTop = top ?? 0 }) as HTMLElement['scrollTo']
    main.scrollBy = vi.fn(({ top }: ScrollToOptions) => { main.scrollTop += top ?? 0; main.dispatchEvent(new Event('scroll')) }) as HTMLElement['scrollBy']
    content.body.append(main)
    await new Promise(resolve => win.setTimeout(resolve, 0))
    expect(main.scrollTop).toBe(160)
    command('active', { active: true })
    command('scroll', { intent: 'halfDown', instant: true })
    expect(main.scrollTop).toBe(260)
    expect(JSON.parse(sessionStorage.getItem('shuttle:workspace:scroll:' + key)!).y).toBe(260)
  })

  it('cannot downgrade the media charge with a second child readiness message', async () => {
    reportHtml = '<html><body><audio></audio></body></html>'
    const frame = await report()
    const weight = () => (host as unknown as { frames: Map<string, { weight: number }> }).frames.get(documents[0].key)!.weight
    expect(weight()).toBe(2)
    window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow, data: { protocol: 'shuttle-document', version: 1, type: 'ready', payload: { media: false } },
    }))
    expect(weight()).toBe(2)
  })

  it('pauses embedded media on recede and park, and prepares dynamically inserted external links', async () => {
    const frame = await report()
    const content = frame.contentDocument!
    const media = content.createElement('audio')
    media.pause = vi.fn()
    media.currentTime = .7
    content.body.append(media)
    host.select(documents[1].key)
    expect(media.pause).toHaveBeenCalled()
    host.select(documents[0].key)
    expect(media.currentTime).toBe(.7)
    media.pause = vi.fn()
    host.parkAll()
    expect(media.pause).toHaveBeenCalled()
    const link = content.createElement('a')
    link.href = 'https://example.com/paper'
    content.body.append(link)
    link.addEventListener('click', event => event.preventDefault())
    link.click()
    expect(link.target).toBe('_blank')
    expect(link.rel).toBe('noopener noreferrer')
    const anchor = content.createElement('a')
    anchor.href = '#section'
    content.body.append(anchor)
    anchor.click()
    expect(anchor.target).toBe('')
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
  })

  it('resolves report candidates as one batch and rejects unresolved, foreign, and inactive selection intents', async () => {
    reportHtml = '<html><body><code>report-1.html</code><code>missing.html</code><a href="./report-1.html">Next report</a><a href="https://example.com/report-1.html">report-1.html</a><div contenteditable><code>report-1.html</code></div></body></html>'
    const frame = await report()
    const content = frame.contentDocument!
    expect(content.querySelectorAll('.ws-channel-reference')).toHaveLength(2)
    expect(content.querySelector('code')?.parentElement?.title).toBe('report-1.html')
    ;(content.querySelector('code') as HTMLElement).click()
    expect(select).toHaveBeenLastCalledWith(documents[1].key)
    select.mockClear()
    const send = (candidate: string, source: MessageEventSource | null = frame.contentWindow) => window.dispatchEvent(new MessageEvent('message', {
      source, data: { protocol: 'shuttle-document', version: 1, type: 'select', payload: { candidate } },
    }))
    send('missing.html'); send(documents[1].key); send('report-1.html', window); send('report-1.html', null)
    expect(select).not.toHaveBeenCalled()
    host.select(documents[1].key)
    send('report-1.html')
    expect(select).not.toHaveBeenCalled()
    host.select(documents[0].key)
    send('report-1.html')
    expect(select).toHaveBeenCalledExactlyOnceWith(documents[1].key)
    const dynamic = content.createElement('code'); dynamic.textContent = './report-1.html'
    content.body.append(dynamic)
    await vi.waitFor(() => expect(dynamic.parentElement?.className).toBe('ws-channel-reference'))
    expect(messages.mock.calls.some(([message]) => message.type === 'references' && message.payload.candidates.includes('./report-1.html'))).toBe(true)
    host.parkAll(); select.mockClear(); send('report-1.html')
    expect(select).not.toHaveBeenCalled()
  })

  it('keeps rescanning references when the report steps its wall clock backward', async () => {
    reportHtml = '<html><body><code>report-1.html</code></body></html>'
    const frame = await report()
    const content = frame.contentDocument!
    const win = frame.contentWindow as Window & typeof globalThis
    const added = (text: string) => messages.mock.calls.some(([message]) => message.type === 'references' && message.payload.candidates.includes(text))
    const first = content.createElement('code'); first.textContent = './report-1.html'; content.body.append(first)
    await vi.waitFor(() => expect(added('./report-1.html')).toBe(true))
    // NTP, a report stubbing Date, or a test clock: ~19 hours into the past.
    const wall = win.Date.now.bind(win.Date)
    win.Date.now = () => wall() - 7e7
    const second = content.createElement('code'); second.textContent = '../report-1.html'; content.body.append(second)
    await vi.waitFor(() => expect(added('../report-1.html')).toBe(true))
  })

  it('gives document and load-time window click handlers first refusal on channel links', async () => {
    reportHtml = `<html><head><script>
      document.addEventListener('click', event => { if (event.target.id === 'owned') event.preventDefault() });
      window.addEventListener('load', () => window.addEventListener('click', event => { if (event.target.id === 'load-owned') event.preventDefault() }));
    </script></head><body><code id="owned">report-1.html</code><code id="load-owned">report-1.html</code>
      <a href="https://example.com" data-file-path="/report-1.html">report-1.html</a></body></html>`
    const frame = await report()
    const content = frame.contentDocument!
    ;(content.querySelector('#owned') as HTMLElement).click()
    ;(content.querySelector('#load-owned') as HTMLElement).click()
    expect(select).not.toHaveBeenCalled()
    expect(content.querySelector('a[href="https://example.com"]')?.classList.contains('ws-channel-reference')).toBe(false)
  })

  it('never applies the HTML transform to native PDF, image, or audio viewers', async () => {
    const transformHtml = vi.fn(production.withWorkspaceKeyBridge)
    for (const [path, kind, tag] of [
      ['/report.pdf', 'pdf', 'iframe'], ['/figure.png', 'image', 'img'], ['/audio.mp3', undefined, 'audio'],
    ] as const) {
      const viewer = production.buildFileViewer('', path, 'host-a', undefined, undefined, { kind, transformHtml })
      document.body.append(viewer)
      expect(viewer.querySelector(tag)).not.toBeNull()
      expect(viewer.querySelector('iframe')?.srcdoc ?? '').toBe('')
      expect(viewer.querySelector('script')).toBeNull()
      production.disposeFileViewer(viewer)
      viewer.remove()
    }
    await Promise.resolve()
    expect(transformHtml).not.toHaveBeenCalled()
  })
})
