// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { ReportInset } from './ReportInset.js'
import { buildChannel } from './documents.js'
const viewer = vi.hoisted(() => ({ build: vi.fn(() => document.createElement('iframe')), dispose: vi.fn() }))
vi.mock('../FileViewerPanel.js', () => ({ buildFileViewer: viewer.build, disposeFileViewer: viewer.dispose }))
vi.mock('./Thumbnail.js', () => ({ Thumbnail: class { el = document.createElement('div'); dispose() {} } }))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); document.body.replaceChildren() })
it('keeps a single live report reachable outside the scroller when its full figure is offscreen', () => {
  let intersect!: (entries: { isIntersecting: boolean }[]) => void
  const disconnect = vi.fn(), observe = vi.fn()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof intersect, options: IntersectionObserverInit) { intersect = callback; expect(options.root).toBe(chat.querySelector('.ws-transcript-scroll')) }
    observe = observe; disconnect = disconnect
  })
  const chat = document.createElement('div')
  chat.innerHTML = '<div class="ws-chat-log"><div class="ws-transcript"><div class="ws-transcript-find-bar"></div><div class="ws-transcript-scroll"><div class="ws-transcript-turn"></div></div></div></div>'
  document.body.append(chat)
  const doc = buildChannel({ uid: 'task', owner: 'host', name: 'Task', path: '/task.md', fiberDir: '/', body: '', embeds: [{ path: '/report.html' }] }).documents[1]
  const open = vi.fn(), inset = new ReportInset('', doc, chat, open)
  const dock = chat.querySelector<HTMLElement>('.ws-report-dock')!
  expect(observe).toHaveBeenCalledWith(inset.el)
  expect(dock.hidden).toBe(true)
  const live = inset.el.querySelector('iframe')!, parent = live.parentElement
  intersect([{ isIntersecting: false }])
  expect(dock.hidden).toBe(false)
  expect(dock.closest('.ws-transcript-scroll')).toBeNull()
  expect(dock.parentElement).toBe(chat.querySelector('.ws-transcript-find-bar'))
  expect(dock.querySelector('iframe')).toBeNull()
  expect(live.parentElement).toBe(parent)
  expect(live.isConnected).toBe(true)
  dock.querySelector('button')!.click()
  intersect([{ isIntersecting: true }])
  expect(dock.hidden).toBe(true)
  expect(inset.el.querySelector('iframe')).not.toBeNull()
  inset.el.querySelector('button')!.click()
  expect(open).toHaveBeenCalledTimes(2)
  expect(viewer.build).toHaveBeenCalledTimes(1)
  inset.dispose()
  expect(disconnect).toHaveBeenCalledOnce()
  expect(chat.querySelector('.ws-report-dock,.ws-report-inset')).toBeNull()
  expect(viewer.dispose).toHaveBeenCalledOnce()
})
