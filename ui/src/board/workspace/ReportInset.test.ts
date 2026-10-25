// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { MOBILE_MEDIA } from '../mobile.js'
import { ReportInset } from './ReportInset.js'
import { buildChannel } from './documents.js'
const viewer = vi.hoisted(() => ({ build: vi.fn(() => document.createElement('iframe')), dispose: vi.fn() }))
vi.mock('../FileViewerPanel.js', () => ({ buildFileViewer: viewer.build, disposeFileViewer: viewer.dispose }))
vi.mock('./Thumbnail.js', () => ({ Thumbnail: class { el = document.createElement('div'); dispose() {} } }))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); document.body.replaceChildren() })
it.each([false, true])('keeps one live report with its offscreen chip in the header (phone: %s)', mobile => {
  const changed: Array<() => void> = []
  vi.stubGlobal('matchMedia', (media: string) => ({ matches: mobile && media !== '(max-height: 500px) and (pointer: coarse)', addEventListener: (_: string, fn: () => void) => changed.push(fn), removeEventListener: vi.fn() }))
  let intersect!: (entries: { isIntersecting: boolean }[]) => void
  const disconnect = vi.fn(), observe = vi.fn()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof intersect, options: IntersectionObserverInit) { intersect = callback; expect(options.root).toBe(chat.querySelector('.ws-transcript-scroll')) }
    observe = observe; disconnect = disconnect
  })
  const chat = document.createElement('div')
  chat.innerHTML = '<header class="ws-chat-head"><div class="ws-chat-acts"><button class="ws-header-control" aria-label="Act"></button><button class="ws-header-control" aria-label="Look"></button></div></header><div class="ws-chat-log"><div class="ws-transcript"><div class="ws-transcript-scroll"><div class="ws-transcript-turn"></div></div></div></div>'
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
  if (mobile) expect(chat.querySelector('.ws-chat-head')?.nextElementSibling).toBe(dock)
  else {
    expect(dock.parentElement).toBe(chat.querySelector('.ws-chat-acts'))
    expect(dock.nextElementSibling?.getAttribute('aria-label')).toBe('Act')
  }
  // Resizing moves only the static chip, never the live iframe.
  vi.stubGlobal('matchMedia', (media: string) => ({ matches: media === MOBILE_MEDIA ? !mobile : false }))
  changed[0]()
  if (mobile) expect(dock.parentElement).toBe(chat.querySelector('.ws-chat-acts'))
  else expect(chat.querySelector('.ws-chat-head')?.nextElementSibling).toBe(dock)
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
