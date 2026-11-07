import { documentLabelMetadata, lastSent, type Channel, type DocKey } from './documents.js'
import { foldSentFiles, sentDocuments, sentFileRow } from './SentFiles.js'

/** The open constitution's sent files at the foot of the left column, newest first, each with its new mark. */
export class SidebarFiles {
  readonly el = document.createElement('section')
  private readonly heading = document.createElement('h3')
  private readonly list = document.createElement('div')
  private signature = ''
  private expanded = false
  private last: { channel: Channel; selected: DocKey; fresh: ReadonlySet<DocKey>; choose: (key: DocKey) => void } | null = null

  constructor() {
    this.el.className = 'ws-sidebar-files'
    this.el.setAttribute('aria-label', 'Sent files')
    this.el.hidden = true
    this.list.className = 'ws-sidebar-file-list'
    this.el.append(this.heading, this.list)
  }
  show(channel: Channel, selected: DocKey, fresh: ReadonlySet<DocKey>, choose: (key: DocKey) => void): void {
    if (this.last && (this.last.channel.uid !== channel.uid || this.last.channel.owner !== channel.owner)) this.expanded = false
    this.last = { channel, selected, fresh, choose }
    const docs = sentDocuments(channel)
    const signature = JSON.stringify([channel.uid, channel.owner, new Date().toDateString(), this.expanded, ...docs.map(doc => [doc.key, documentLabelMetadata(doc, doc.name, channel.owner).title, lastSent(doc), fresh.has(doc.key), doc.key === selected])])
    if (signature === this.signature) return
    this.signature = signature
    this.el.hidden = !docs.length
    const unread = docs.filter(doc => fresh.has(doc.key)).length
    this.heading.textContent = unread ? `Sent files · ${unread} new` : 'Sent files'
    const active = document.activeElement
    const focus = active instanceof HTMLElement && this.list.contains(active) ? active.dataset.key : undefined
    const rows = docs.map(doc => sentFileRow(channel, doc, selected, fresh, choose, 'ws-sidebar-file', true))
    this.list.replaceChildren(...foldSentFiles(rows, this.expanded, expanded => {
      this.expanded = expanded
      this.show(channel, selected, fresh, choose)
      this.list.querySelector<HTMLElement>('[data-part="sent-files-more"]')?.focus({ preventScroll: true })
    }, 'ws-sidebar-files-more'))
    if (focus !== undefined) [...this.list.querySelectorAll<HTMLElement>('.ws-sidebar-file')].find(el => el.dataset.key === focus)?.focus({ preventScroll: true })
  }
  focus(): void {
    (this.list.querySelector<HTMLElement>('[aria-current="page"]') ?? this.list.querySelector<HTMLElement>('.ws-sidebar-file'))?.focus({ preventScroll: true })
  }
}
