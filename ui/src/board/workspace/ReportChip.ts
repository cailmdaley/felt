import { declaredTitle, watchDocumentTitles } from './DocumentTitles.js'
import type { WorkspaceDocument } from './documents.js'
import { headerIcon } from './headerIcon.js'

/** The artifact's header entry point: its icon, named by the page's title. */
export class ReportChip {
  readonly el = document.createElement('button')
  private readonly stopTitle: () => void
  constructor(doc: WorkspaceDocument, open: () => void) {
    this.el.type = 'button'
    this.el.className = 'ws-report-chip'
    this.el.dataset.documentKey = doc.key
    this.el.addEventListener('click', open)
    this.el.innerHTML = headerIcon('artifact')
    if (doc.kind === 'change') this.el.textContent = '±'
    const name = (): void => {
      const title = declaredTitle(doc.key)?.title || doc.provenance.find(p => p.kind === 'embed')?.title || (doc.kind === 'change' ? doc.name.replace(/\.change\.json$/i, '') : 'Artifact')
      this.el.title = title
      this.el.setAttribute('aria-label', `Read ${doc.kind === 'change' ? 'change' : 'artifact'}: ${title}`)
    }
    name(); this.stopTitle = watchDocumentTitles(key => { if (key === doc.key) name() })
  }
  dispose(): void { this.stopTitle(); this.el.remove() }
}
