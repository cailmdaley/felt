import { openFileList, type OpenFileList } from '../elements/filePreview.js'
import type { MapFile } from '../family/model.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { slug } from '../threadOutline.js'
import { changeKey, fiberKey, type DocKey } from './documents.js'
import { headerIcon, type HeaderIcon } from './headerIcon.js'
import './doc-buttons.css'

/** What a constitution's page buttons read and open. */
export interface DocFeeds {
  /** Its tapestry or report, when its directory holds one: undefined when it holds none, null when its owner could not say. */
  lead(card: KanbanCard): Promise<MapFile | null | undefined>
  /** Its sent files, newest first. */
  files(card: KanbanCard): MapFile[]
  /** Opens one of its pages in the reader; the opening is a deliberate look at it. */
  open(card: KanbanCard, doc: DocKey): void
  /** False where nothing can show its edits: no reader bakes its change. */
  edits?: false
}

/** A constitution's page buttons, and a way to read its files again. */
export interface DocButtons {
  el: HTMLElement
  /** Reads its sent files again: the count, and a list open from it, follow them in place. */
  refresh(): void
  /** Closes the list open from its count, if one is. */
  close(): void
}

/**
 * A constitution's pages as one row of icons, the same wherever it stands (a
 * constitution's view, a channel's head): its constitution, its tapestry once
 * found, its sent files (a count that opens their list, newest first, each
 * row opening its file in the reader) and, for a fiber with a project, its edits.
 * The count is one button for the row's life, so a list open from it keeps its
 * opener whatever arrives.
 */
export function docButtons(card: KanbanCard, feeds: DocFeeds): DocButtons {
  const row = document.createElement('span')
  row.className = 'ws-doc-buttons'
  const who = slug(card), uid = card.uid ?? card.id
  const button = (part: string, icon: HeaderIcon, label: string, open: (node: HTMLButtonElement) => void): HTMLButtonElement => {
    const node = document.createElement('button')
    node.type = 'button'
    node.className = 'ws-doc-button'
    node.dataset.part = part
    node.innerHTML = headerIcon(icon)
    node.title = `${label} · ${who}`
    node.setAttribute('aria-label', node.title)
    node.addEventListener('click', event => { event.stopPropagation(); open(node) })
    return node
  }
  // The tapestry keeps a slot, filled once its read lands; the sends' count stands while there are any.
  const tapestry = document.createElement('span'), sent = document.createElement('span')
  tapestry.className = sent.className = 'ws-doc-slot'
  let lead: MapFile | undefined, list: OpenFileList | undefined
  const files = (): MapFile[] => feeds.files(card).filter(file => file.key !== lead?.key)
  const count = button('sends', 'sends', '', node => { list = openFileList(node, files(), key => feeds.open(card, key)) })
  const number = Object.assign(document.createElement('span'), { className: 'ws-doc-count' })
  count.append(number)
  const refresh = (): void => {
    const now = files(), label = `${now.length} sent ${now.length === 1 ? 'file' : 'files'}`
    number.textContent = String(now.length)
    count.title = `${label} · ${who}`
    count.setAttribute('aria-label', count.title)
    count.toggleAttribute('data-unread', now.some(file => file.unread))
    if (!!now.length !== sent.contains(count)) sent.replaceChildren(...now.length ? [count] : [])
    list?.update(now)
  }
  const page = (doc: DocKey) => (): void => feeds.open(card, doc)
  row.append(button('constitution', 'constitution', 'Constitution', page(fiberKey(card.originId, uid))), tapestry, sent)
  if (card.shuttleProjectDir && feeds.edits !== false) row.append(button('edits', 'edits', 'Edits', page(changeKey(card.originId, uid))))
  refresh()
  void feeds.lead(card).then(found => {
    if (!found) return
    lead = found
    tapestry.replaceChildren(button('tapestry', 'tapestry', found.name, page(found.key)))
    refresh()
  })
  return { el: row, refresh, close: () => list?.close() }
}
