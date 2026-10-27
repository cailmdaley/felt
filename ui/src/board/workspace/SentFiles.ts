import { documentLabelMetadata, lastSent, type Channel, type DocKey, type WorkspaceDocument } from './documents.js'

/** Receipt-backed files, newest first. */
export function sentDocuments(channel: Channel): WorkspaceDocument[] {
  return channel.documents.filter(doc => doc.provenance.some(p => p.kind === 'sent'))
    .sort((a, b) => (lastSent(b) ?? 0) - (lastSent(a) ?? 0) || a.key.localeCompare(b.key))
}

/** One sent file: its title, last send time, a `new` mark until read, and the current page marked. */
export function sentFileRow(channel: Channel, doc: WorkspaceDocument, selected: DocKey, fresh: ReadonlySet<DocKey>, choose: (key: DocKey) => void, className: string): HTMLButtonElement {
  const row = document.createElement('button')
  row.type = 'button'; row.className = className; row.dataset.key = doc.key
  const label = document.createElement('span')
  label.textContent = documentLabelMetadata(doc, doc.name, channel.owner).title
  const time = document.createElement('time')
  const at = lastSent(doc)
  if (at !== undefined) {
    time.dateTime = new Date(at).toISOString()
    time.textContent = new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  } else time.textContent = 'Date unknown'
  row.append(label, time)
  if (fresh.has(doc.key)) {
    const mark = document.createElement('span'); mark.className = 'ws-sent-new'; mark.textContent = 'new'; row.append(mark)
  }
  if (doc.key === selected) row.setAttribute('aria-current', 'page')
  row.title = `${doc.owner}:${doc.path}`
  row.addEventListener('click', () => choose(doc.key))
  return row
}

/** The page sheet's list of sent files; reading a file clears its new mark. */
export function sentFiles(channel: Channel, selected: DocKey, fresh: ReadonlySet<DocKey>, choose: (key: DocKey) => void): HTMLElement {
  const section = document.createElement('section')
  section.className = 'ws-sent-files'
  section.setAttribute('aria-label', 'Sent files')
  const heading = document.createElement('h3')
  heading.textContent = 'Sent files'
  section.append(heading)
  const files = sentDocuments(channel)
  if (!files.length) {
    const empty = document.createElement('p'); empty.textContent = 'No files sent yet.'; section.append(empty)
  }
  for (const doc of files) {
    const row = sentFileRow(channel, doc, selected, fresh, choose, 'ws-sent-file')
    row.dataset.part = 'page-sheet-row'
    section.append(row)
  }
  return section
}
