import { declaredTitle, watchDocumentTitles } from './DocumentTitles.js'
import type { WorkspaceDocument } from './documents.js'
import { Thumbnail } from './Thumbnail.js'

/** The report's persistent entry point, sharing the reader's document identity. */
export class ReportChip {
  readonly el = document.createElement('button')
  private readonly thumbnail: Thumbnail
  private readonly stopTitle: () => void
  constructor(base: string, doc: WorkspaceDocument, open: () => void) {
    this.el.type = 'button'
    this.el.className = 'ws-report-chip'
    this.el.addEventListener('click', open)
    const preview = document.createElement('span')
    preview.className = 'ws-report-preview'; preview.inert = true
    this.thumbnail = new Thumbnail({
      key: doc.key, shuttleBase: base, fallback: 'Report', captioned: true,
      file: { fullPath: doc.path, owner: doc.owner, basename: doc.name },
      priority: () => 1, distance: () => 0,
    })
    preview.append(this.thumbnail.el)
    const reportLabel = document.createElement('span')
    reportLabel.className = 'ws-report-label'
    reportLabel.textContent = 'Report'
    this.el.append(preview, reportLabel)
    const label = (): void => {
      const title = declaredTitle(doc.key)?.title || doc.provenance.find(p => p.kind === 'embed')?.title || 'Artifact'
      this.el.title = title
      this.el.setAttribute('aria-label', `Read artifact: ${title}`)
    }
    label(); this.stopTitle = watchDocumentTitles(key => { if (key === doc.key) label() })
  }
  dispose(): void { this.stopTitle(); this.thumbnail.dispose(); this.el.remove() }
}
