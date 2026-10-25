import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask } from 'pdfjs-dist'
import { EventBus, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'
import 'pdfjs-dist/web/pdf_viewer.css'

GlobalWorkerOptions.workerSrc = new URL('../../node_modules/pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href

export type MountedPdfViewer = { ready: Promise<void>; dispose: () => void }

export function mountPdfViewer(
  host: HTMLElement,
  bytes: ArrayBuffer,
  onReady: () => void,
  onError: (message: string) => void,
): MountedPdfViewer {
  const toolbar = document.createElement('div')
  toolbar.className = 'kbn-pdf-toolbar'
  toolbar.setAttribute('aria-label', 'PDF controls')
  const fit = button('Fit page', 'Fit page to the viewer')
  const zoomOut = button('−', 'Zoom out')
  const zoomIn = button('+', 'Zoom in')
  const pageLabel = document.createElement('span')
  pageLabel.className = 'kbn-pdf-page-label'
  pageLabel.setAttribute('aria-live', 'polite')
  toolbar.append(fit, zoomOut, zoomIn, pageLabel)

  const container = document.createElement('div')
  container.className = 'kbn-pdf-scroll'
  container.setAttribute('aria-label', 'PDF pages')
  container.dataset.wsSwipe = 'off'
  const viewerElement = document.createElement('div')
  viewerElement.className = 'pdfViewer'
  container.append(viewerElement)
  host.append(toolbar, container)

  const eventBus = new EventBus()
  const viewerController = new AbortController()
  const linkService = new PDFLinkService({ eventBus })
  const viewerOptions = {
    container,
    viewer: viewerElement,
    eventBus,
    linkService,
    abortSignal: viewerController.signal,
    textLayerMode: 1,
    maxCanvasPixels: 4 * 1024 * 1024,
    enableDetailCanvas: false,
  } as ConstructorParameters<typeof PDFViewer>[0] & { abortSignal: AbortSignal }
  const viewer = new PDFViewer(viewerOptions)
  linkService.setViewer(viewer)
  let disposed = false
  let loadingTask: PDFDocumentLoadingTask | null = null
  let firstPageReady = false
  let pageCount = 0
  const updatePageLabel = (): void => {
    if (!disposed && pageCount) pageLabel.textContent = `${viewer.currentPageNumber} / ${pageCount}`
  }
  const fitPage = (): void => {
    viewer.currentScaleValue = 'page-fit'
  }
  fit.addEventListener('click', fitPage)
  zoomOut.addEventListener('click', () => { viewer.currentScaleValue = String(Math.max(0.25, viewer.currentScale * 0.8)) })
  zoomIn.addEventListener('click', () => { viewer.currentScaleValue = String(Math.min(5, viewer.currentScale * 1.25)) })
  const onPagesInit = (): void => {
    if (disposed) return
    viewer.currentPageNumber = 1
    fitPage()
  }
  const onPageRendered = (event: { pageNumber: number }): void => {
    if (disposed || event.pageNumber !== 1 || firstPageReady) return
    firstPageReady = true
    onReady()
  }
  eventBus.on('pagesinit', onPagesInit)
  eventBus.on('pagechanging', updatePageLabel)
  eventBus.on('pagerendered', onPageRendered)
  const resizeObserver = new ResizeObserver(() => {
    if (viewer.currentScaleValue !== 'page-fit') return
    viewer.currentScaleValue = 'auto'
    viewer.currentScaleValue = 'page-fit'
  })
  resizeObserver.observe(container)

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    viewerController.abort()
    resizeObserver.disconnect()
    eventBus.off('pagesinit', onPagesInit)
    eventBus.off('pagechanging', updatePageLabel)
    eventBus.off('pagerendered', onPageRendered)
    viewer.setDocument(null)
    linkService.setDocument(null)
    viewer.cleanup()
    void loadingTask?.destroy()
    loadingTask = null
    host.replaceChildren()
  }

  const ready = (async (): Promise<void> => {
    try {
      loadingTask = getDocument({ data: new Uint8Array(bytes) })
      const document = await loadingTask.promise
      if (disposed) {
        void loadingTask.destroy()
        return
      }
      linkService.setDocument(document)
      pageCount = document.numPages
      viewer.setDocument(document)
      updatePageLabel()
    } catch (error) {
      dispose()
      onError(error instanceof Error ? error.message : 'could not render PDF')
    }
  })()
  return { ready, dispose }
}

function button(label: string, title: string): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = 'kbn-pdf-control'
  element.textContent = label
  element.title = title
  element.setAttribute('aria-label', title)
  return element
}
