import { declaredTitle, watchDocumentTitles } from './DocumentTitles.js'
import type { WorkspaceDocument } from './documents.js'
import { headerIcon } from './headerIcon.js'

/** The artifact's header entry point: the word on the desktop, its icon on the phone. */
export class ReportChip {
  readonly el = document.createElement('button')
  private readonly stopTitle: () => void
  constructor(doc: WorkspaceDocument, open: () => void) {
    this.el.type = 'button'
    this.el.className = 'ws-report-chip'
    this.el.addEventListener('click', open)
    this.el.innerHTML = headerIcon('artifact')
    const label = document.createElement('span')
    label.className = 'ws-report-label'
    label.textContent = 'Artifact'
    this.el.append(label)
    const name = (): void => {
      const title = declaredTitle(doc.key)?.title || doc.provenance.find(p => p.kind === 'embed')?.title || 'Artifact'
      this.el.title = title
      this.el.setAttribute('aria-label', `Read artifact: ${title}`)
    }
    name(); this.stopTitle = watchDocumentTitles(key => { if (key === doc.key) name() })
  }
  dispose(): void { this.stopTitle(); this.el.remove() }
}
