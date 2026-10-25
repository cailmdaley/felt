import { buildFileViewer, disposeFileViewer } from '../FileViewerPanel.js'
import { declaredTitle, watchDocumentTitles } from './DocumentTitles.js'
import type { WorkspaceDocument } from './documents.js'
import './report-inset.css'

/** A live page's top, scaled to half the conversation's measure. */
export class ReportInset {
  readonly el = document.createElement('figure')
  private readonly viewer: HTMLElement
  private readonly observer: MutationObserver
  private readonly resize: ResizeObserver | null
  private readonly stopTitle: () => void
  constructor(base: string, doc: WorkspaceDocument, chat: HTMLElement, open: () => void) {
    this.el.className = 'ws-report-inset'
    const button = document.createElement('button'); button.type = 'button'; button.className = 'ws-report-open'
    button.setAttribute('aria-label', 'Read report'); button.addEventListener('click', open)
    const viewport = document.createElement('span'); viewport.className = 'ws-report-viewport'; viewport.inert = true
    this.viewer = buildFileViewer(base, doc.path, doc.owner, undefined, undefined, { kind: 'html', active: true, quietLoading: true })
    viewport.append(this.viewer)
    const caption = document.createElement('figcaption')
    const title = (): void => { caption.textContent = declaredTitle(doc.key)?.title || doc.provenance.find((p): p is Extract<typeof p, { kind: 'embed' }> => p.kind === 'embed')?.title || 'Report' }
    title(); this.stopTitle = watchDocumentTitles(key => { if (key === doc.key) title() })
    button.append(viewport); this.el.append(button, caption)
    const seat = (): void => {
      const target = chat.querySelector<HTMLElement>('.ws-transcript-turn') ?? chat.querySelector<HTMLElement>('.ws-transcript-scroll') ?? chat.querySelector<HTMLElement>('.ws-chat-log')
      if (target && this.el.parentElement !== target) target.prepend(this.el)
    }
    this.observer = new MutationObserver(seat); this.observer.observe(chat, { childList: true, subtree: true }); seat()
    const scale = (): void => { this.viewer.style.transform = `scale(${viewport.clientWidth / 800})` }
    this.resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scale)
    this.resize?.observe(viewport); scale()
  }
  dispose(): void {
    this.observer.disconnect(); this.resize?.disconnect(); this.stopTitle(); disposeFileViewer(this.viewer); this.el.remove()
  }
}
