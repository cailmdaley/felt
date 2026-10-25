// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

const pdfMocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
  viewer: null as null | { currentPageNumber: number; currentScaleValue: string; currentScale: number; scaleChanges: string[]; options: Record<string, any> },
  readyScale: '' as string,
  resizeObserver: null as null | { notify: () => void; disconnected: boolean },
}))

vi.mock('pdfjs-dist', () => ({ getDocument: pdfMocks.getDocument, GlobalWorkerOptions: {} }))
vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => ({
  EventBus: class {
    listeners = new Map<string, Set<(event: any) => void>>()
    on(name: string, listener: (event: any) => void) { const set = this.listeners.get(name) ?? new Set(); set.add(listener); this.listeners.set(name, set) }
    off(name: string, listener: (event: any) => void) { this.listeners.get(name)?.delete(listener) }
    dispatch(name: string, event: any) { for (const listener of this.listeners.get(name) ?? []) listener(event) }
  },
  PDFLinkService: class { setViewer() {} setDocument() {} },
  PDFViewer: class {
    currentPageNumber = 1
    scale = 'auto'
    currentScale = 1
    scaleChanges: string[] = []
    options: Record<string, any>
    constructor(options: Record<string, any>) { this.options = options; pdfMocks.viewer = this }
    get currentScaleValue() { return this.scale }
    set currentScaleValue(value: string) { this.scale = value; this.scaleChanges.push(value) }
    setDocument(document: unknown) {
      if (!document) return
      this.options.eventBus.dispatch('pagesinit', {})
      pdfMocks.readyScale = this.currentScaleValue
      this.options.eventBus.dispatch('pagerendered', { pageNumber: 1 })
    }
    cleanup() {}
  },
}))
vi.mock('pdfjs-dist/web/pdf_viewer.css', () => ({}))

import { mountPdfViewer } from './pdfViewer.js'

afterEach(() => { pdfMocks.getDocument.mockReset(); pdfMocks.viewer = null; pdfMocks.readyScale = ''; pdfMocks.resizeObserver = null; vi.unstubAllGlobals() })

describe('PDF.js viewer integration', () => {
  it('fits page one before readiness, preserves the current page on refit, and tears down its worker signals', async () => {
    vi.stubGlobal('ResizeObserver', class {
      disconnected = false
      callback: () => void
      constructor(callback: () => void) {
        this.callback = callback
        pdfMocks.resizeObserver = { notify: callback, get disconnected() { return false } }
      }
      observe() {}
      disconnect() {
        this.disconnected = true
        pdfMocks.resizeObserver = { notify: this.callback, get disconnected() { return true } }
      }
    })
    const destroy = vi.fn(async () => {})
    pdfMocks.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 3 }), destroy })
    const host = document.createElement('div')
    const onReady = vi.fn()
    const mounted = mountPdfViewer(host, new ArrayBuffer(8), onReady, vi.fn())
    await mounted.ready

    expect(pdfMocks.viewer?.currentPageNumber).toBe(1)
    expect(pdfMocks.readyScale).toBe('page-fit')
    expect(onReady).toHaveBeenCalledOnce()
    const viewer = pdfMocks.viewer!
    viewer.currentPageNumber = 2
    host.querySelector<HTMLButtonElement>('[aria-label="Fit page to the viewer"]')!.click()
    expect(viewer.currentPageNumber).toBe(2)
    expect(viewer.currentScaleValue).toBe('page-fit')
    const scalesBeforeResize = viewer.scaleChanges.length
    pdfMocks.resizeObserver!.notify()
    expect(viewer.scaleChanges.slice(scalesBeforeResize)).toEqual(['auto', 'page-fit'])

    const signal = (viewer.options.abortSignal as AbortSignal)
    mounted.dispose()
    expect(signal.aborted).toBe(true)
    expect(pdfMocks.resizeObserver?.disconnected).toBe(true)
    expect(destroy).toHaveBeenCalledOnce()
    expect(host.childElementCount).toBe(0)
  })
})
