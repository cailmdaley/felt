import { openFileList } from '../elements/filePreview.js'
import type { MapFile } from '../family/model.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { slug } from '../threadOutline.js'
import { changeKey, fiberKey, type DocKey } from './documents.js'
import { headerIcon, type HeaderIcon } from './headerIcon.js'
import './doc-buttons.css'

/** What a constitution's page buttons read and open. */
export interface DocFeeds {
  /** Its tapestry or report, when its directory holds one. */
  lead(card: KanbanCard): Promise<MapFile | undefined>
  /** Its sent files, newest first. */
  files(card: KanbanCard): MapFile[]
  /** Opens one of its pages in the reader; the opening is a deliberate look at it. */
  open(card: KanbanCard, doc: DocKey): void
}

/**
 * A constitution's pages as one row of icons, the same wherever it stands (a
 * constitution's view, a channel's head): its constitution, its tapestry once
 * found, its sent files (a count that opens their list, newest first, each
 * row opening its file in the reader) and, for a fiber with a project, its edits.
 */
export function docButtons(card: KanbanCard, feeds: DocFeeds): HTMLElement {
  const row = document.createElement('span')
  row.className = 'ws-doc-buttons'
  const who = slug(card), uid = card.uid ?? card.id
  const button = (part: string, icon: HeaderIcon, label: string, open: (node: HTMLButtonElement) => void, count?: number): HTMLButtonElement => {
    const node = document.createElement('button')
    node.type = 'button'
    node.className = 'ws-doc-button'
    node.dataset.part = part
    node.innerHTML = headerIcon(icon)
    if (count !== undefined) node.append(Object.assign(document.createElement('span'), { className: 'ws-doc-count', textContent: String(count) }))
    node.title = `${label} · ${who}`
    node.setAttribute('aria-label', node.title)
    node.addEventListener('click', event => { event.stopPropagation(); open(node) })
    return node
  }
  // The tapestry and the sends each keep a slot, filled once the tapestry's read lands.
  const tapestry = document.createElement('span'), sent = document.createElement('span')
  tapestry.className = sent.className = 'ws-doc-slot'
  const sends = (lead?: MapFile): void => {
    const files = feeds.files(card).filter(file => file.key !== lead?.key)
    const label = `${files.length} sent ${files.length === 1 ? 'file' : 'files'}`
    sent.replaceChildren(...files.length ? [button('sends', 'sends', label, node => { openFileList(node, files, key => feeds.open(card, key)) }, files.length)] : [])
  }
  const page = (doc: DocKey) => (): void => feeds.open(card, doc)
  row.append(button('constitution', 'constitution', 'Constitution', page(fiberKey(card.originId, uid))), tapestry, sent)
  if (card.shuttleProjectDir) row.append(button('edits', 'edits', 'Edits', page(changeKey(card.originId, uid))))
  sends()
  void feeds.lead(card).then(lead => {
    if (!lead) return
    tapestry.replaceChildren(button('tapestry', 'tapestry', lead.name, page(lead.key)))
    sends(lead)
  })
  return row
}
