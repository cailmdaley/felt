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
  it('fits page one to the pane width before readiness, keeps the chosen fit across resizes and the current page across refits, tears down its worker signals, and destroys the document once page one has settled', async () => {
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
    let pageOne = (): void => {}
    const firstPage = new Promise<void>(resolve => { pageOne = resolve })
    pdfMocks.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 3, getPage: () => firstPage }), destroy })
    const host = document.createElement('div')
    const onReady = vi.fn()
    const mounted = mountPdfViewer(host, new ArrayBuffer(8), onReady, vi.fn())
    await mounted.ready

    expect(pdfMocks.viewer?.currentPageNumber).toBe(1)
    expect(pdfMocks.readyScale).toBe('page-width')
    expect(onReady).toHaveBeenCalledOnce()
    const viewer = pdfMocks.viewer!
    viewer.currentPageNumber = 2
    expect(viewer.options).toMatchObject({ removePageBorders: true, enableDetailCanvas: true })
    const resizedScales = (): string[] => {
      const before = viewer.scaleChanges.length
      pdfMocks.resizeObserver!.notify()
      return viewer.scaleChanges.slice(before)
    }
    expect(resizedScales()).toEqual(['auto', 'page-width'])
    host.querySelector<HTMLButtonElement>('[aria-label="Fit whole page in the viewer"]')!.click()
    expect(viewer.currentPageNumber).toBe(2)
    expect(viewer.currentScaleValue).toBe('page-fit')
    expect(resizedScales()).toEqual(['auto', 'page-fit'])
    host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click()
    expect(resizedScales()).toEqual([])
    host.querySelector<HTMLButtonElement>('[aria-label="Fit page width to the viewer"]')!.click()
    expect(viewer.currentScaleValue).toBe('page-width')
    expect(viewer.currentPageNumber).toBe(2)

    const signal = (viewer.options.abortSignal as AbortSignal)
    mounted.dispose()
    expect(signal.aborted).toBe(true)
    expect(pdfMocks.resizeObserver?.disconnected).toBe(true)
    expect(host.childElementCount).toBe(0)
    // The document outlives the viewer's request for page one.
    await Promise.resolve()
    expect(destroy).not.toHaveBeenCalled()
    pageOne()
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce())
  })

  it('destroys the document when page one fails after the viewer is closed', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    const destroy = vi.fn(async () => {})
    let failPageOne = (_: Error): void => {}
    const firstPage = new Promise<void>((_, reject) => { failPageOne = reject })
    pdfMocks.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 1, getPage: () => firstPage }), destroy })
    const mounted = mountPdfViewer(document.createElement('div'), new ArrayBuffer(8), vi.fn(), vi.fn())
    await mounted.ready
    mounted.dispose()
    failPageOne(new Error('Transport destroyed'))
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce())
  })
})
