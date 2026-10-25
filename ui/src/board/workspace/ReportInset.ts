import { buildFileViewer, disposeFileViewer } from '../FileViewerPanel.js'
import { declaredTitle, watchDocumentTitles } from './DocumentTitles.js'
import type { WorkspaceDocument } from './documents.js'
import { Thumbnail } from './Thumbnail.js'
import { isMobileViewport, onMobileChange } from '../mobile.js'
import './report-inset.css'

/** One mounted live figure, with a static thumbnail in its offscreen dock. */
export class ReportInset {
  readonly el = document.createElement('figure')
  private readonly dock = document.createElement('div')
  private readonly viewer: HTMLElement
  private readonly thumbnail: Thumbnail
  private readonly observer: MutationObserver
  private readonly resize: ResizeObserver | null
  private intersection: IntersectionObserver | null = null
  private readonly stopTitle: () => void
  private readonly stopMobile: () => void
  constructor(base: string, doc: WorkspaceDocument, chat: HTMLElement, open: () => void) {
    this.el.className = 'ws-report-inset'
    const button = document.createElement('button'); button.type = 'button'; button.className = 'ws-report-open'
    button.setAttribute('aria-label', 'Read report'); button.addEventListener('click', open)
    const viewport = document.createElement('span'); viewport.className = 'ws-report-viewport'; viewport.inert = true
    this.viewer = buildFileViewer(base, doc.path, doc.owner, undefined, undefined, { kind: 'html', active: true, quietLoading: true })
    viewport.append(this.viewer)
    const caption = document.createElement('figcaption')
    button.append(viewport); this.el.append(button, caption)
    this.dock.className = 'ws-report-dock'; this.dock.hidden = true
    const compact = document.createElement('button'); compact.type = 'button'; compact.className = 'ws-report-compact'
    compact.setAttribute('aria-label', 'Read report'); compact.addEventListener('click', open)
    const small = document.createElement('span'); small.className = 'ws-report-preview'; small.inert = true
    this.thumbnail = new Thumbnail({
      key: doc.key, shuttleBase: base, fallback: 'Report', captioned: true,
      file: { fullPath: doc.path, owner: doc.owner, basename: 'report.html' },
      priority: () => 1, distance: () => 0,
    })
    small.append(this.thumbnail.el)
    const title = document.createElement('span'); title.className = 'ws-report-dock-title'
    compact.append(small, title); this.dock.append(compact)
    const label = (): void => {
      caption.textContent = declaredTitle(doc.key)?.title || doc.provenance.find((p): p is Extract<typeof p, { kind: 'embed' }> => p.kind === 'embed')?.title || 'Report'
      title.textContent = caption.textContent
    }
    label(); this.stopTitle = watchDocumentTitles(key => { if (key === doc.key) label() })
    const scale = (): void => {
      this.viewer.style.transform = `scale(${viewport.clientWidth / 800})`
    }
    this.resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scale)
    this.resize?.observe(viewport); this.resize?.observe(small)
    let root: HTMLElement | null = null
    const seat = (): void => {
      const scroll = chat.querySelector<HTMLElement>('.ws-transcript-scroll')
      const target = scroll ?? chat.querySelector<HTMLElement>('.ws-chat-log')
      if (target && this.el.parentElement !== target) target.prepend(this.el)
      const header = chat.querySelector('.ws-chat-head')
      const acts = header?.querySelector('.ws-chat-acts')
      if (isMobileViewport()) {
        if (header && header.nextElementSibling !== this.dock) header.after(this.dock)
      } else if (acts && this.dock.parentElement !== acts) {
        acts.insertBefore(this.dock, acts.querySelector('.ws-header-control'))
      }
      if (scroll && scroll !== root) {
        root = scroll
        this.intersection?.disconnect()
        if (typeof IntersectionObserver !== 'undefined') {
          this.intersection = new IntersectionObserver(entries => {
            const visible = entries[0]?.isIntersecting ?? true
            if (this.dock.hidden === visible) return
            const atBottom = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 2
            this.dock.hidden = visible
            this.el.inert = !visible
            scale()
            if (atBottom && !visible) scroll.scrollTop = scroll.scrollHeight
          }, { root: scroll })
          this.intersection.observe(this.el)
        }
      }
      scale()
    }
    this.stopMobile = typeof window.matchMedia === 'function' ? onMobileChange(seat) : () => {}
    this.observer = new MutationObserver(seat); this.observer.observe(chat, { childList: true, subtree: true }); seat()
  }
  dispose(): void {
    this.observer.disconnect(); this.intersection?.disconnect(); this.resize?.disconnect(); this.stopTitle(); this.stopMobile()
    this.thumbnail.dispose(); disposeFileViewer(this.viewer); this.el.remove(); this.dock.remove()
  }
}
