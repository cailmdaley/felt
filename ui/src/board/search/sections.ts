import type { KanbanCard } from '../KanbanTypes.js'
import type { BoardRecord } from '../boardFeed.js'
import type { Channel } from '../channels.js'
import type { DocKey } from '../workspace/documents.js'
import type { Receipt } from '../workspace/Library.js'
import { declaredTitle } from '../workspace/DocumentTitles.js'
import { fileRow } from '../elements/filePreview.js'
import { timeEl } from '../elements/time.js'
import { slug } from '../threadOutline.js'
import { hitLocation, projectName, searchTranscripts, snippetPieces, type TranscriptHit } from '../workspace/transcriptSearch.js'
import { channelHits, documentHits, fetchRecordHits, localHits, mergeHits, needleOf, pieces, saidHits, type SearchHit } from './match.js'
import type { FindRow, FindSection } from './scope.js'

/** The word a closed card's row wears: tempered and discarded work is archived, review work awaits the human or a thread's orchestrator. */
const CLOSED_STATE: Partial<Record<KanbanCard['column'], string>> = { tempered: 'tempered', composted: 'discarded', awaitingReview: 'awaiting review', orchestratorReview: 'with orchestrator' }
/** A said line's kind, as the stream names it. */
const SAID_WORD: Record<string, string> = { asked: 'asks', closed: 'closed' }

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  node.className = className
  return node
}

/** `text` with every place the needle stands in a `<mark>`. */
export function marked(className: string, text: string, needle: string): HTMLElement {
  const span = el('span', className)
  for (const piece of pieces(text, needle)) {
    if (!piece.hit) { span.append(piece.text); continue }
    const mark = document.createElement('mark')
    mark.textContent = piece.text
    span.append(mark)
  }
  return span
}

/** A row's face: its name, a line of what it is, and the words that matched when they are not in its name. */
function face(name: HTMLElement, meta: Array<string | Node>, quote?: HTMLElement): HTMLElement {
  const content = el('span', 'ws-find-face')
  const small = document.createElement('small')
  small.append(...meta.flatMap((part, n) => n ? [' · ', part] : [part]))
  content.append(name, small)
  if (quote) content.append(quote)
  return content
}

export interface ConstitutionSources {
  shuttleBase: string
  /** The cards the board holds, matched by name and id. */
  cards(): KanbanCard[]
  /** What an empty field lists, the most recently touched first. */
  recent?(): KanbanCard[]
  pick(hit: SearchHit<KanbanCard>): void
  /** The card being read, marked in the list. */
  current?(card: KanbanCard): boolean
}

/** Constitutions by name and id at once, and by outcome and body once the daemon answers; closed work is in the list and says so. */
export function constitutionsSection(src: ConstitutionSources): FindSection {
  const rowOf = (hit: SearchHit<KanbanCard>, needle: string): FindRow => {
    const card = hit.card
    const state = card ? CLOSED_STATE[card.column] : hit.status ?? undefined
    const content = face(marked('ws-channel-name', hit.name, needle), [card ? card.originId : 'in the record', ...state ? [state] : []], hit.excerpt ? marked('ws-find-quote', hit.excerpt, needle) : undefined)
    if (state || !hit.onBoard) content.dataset.state = state ?? 'record'
    if (card && src.current?.(card)) content.dataset.current = ''
    return {
      key: card ? `${card.originId}:${card.uid ?? card.id}` : hit.id,
      label: state ? `${hit.name}, ${state}` : hit.name,
      content,
      className: 'ws-channel-row',
      ...hit.onBoard ? { pick: () => src.pick(hit) } : {},
    }
  }
  const asHit = (card: KanbanCard): SearchHit<KanbanCard> => ({ id: card.id, name: card.name, where: [], excerpt: null, rank: 0, onBoard: true, card, status: null })
  return {
    id: 'constitutions',
    title: 'Constitutions',
    // One letter matches most of the record and costs a full walk to say so.
    min: 2,
    rows: query => {
      const needle = needleOf(query)
      if (!needle) return (src.recent?.() ?? []).map(card => rowOf(asHit(card), ''))
      return localHits(src.cards(), query).map(hit => rowOf(hit, needle))
    },
    read: async (query, signal) => {
      const remote = await fetchRecordHits(src.shuttleBase, query, 25, signal)
      const cards = src.cards()
      return mergeHits(localHits(cards, query), remote, new Map(cards.map(card => [card.id, card]))).map(hit => rowOf(hit, needleOf(query)))
    },
  }
}

/** Channels by name, chair and members; a pick opens the channel, a hidden one brought back. */
export function channelsSection(src: { channels(): Channel[]; open(channel: Channel): void }): FindSection {
  return {
    id: 'channels',
    title: 'Channels',
    rows: query => {
      const needle = needleOf(query)
      return channelHits(src.channels(), query).map(channel => ({
        key: channel.key,
        label: `#${channel.name}`,
        content: face(marked('ws-channel-name', `#${channel.name}`, needle), [channel.misc ? 'everything without a channel' : channel.title]),
        pick: () => src.open(channel),
      }))
    },
  }
}

export interface SaidSources {
  /** The records to search, already read. */
  records(): BoardRecord[]
  cardOf(uid: string): KanbanCard | undefined
  /** The channel a line is drawn in, named in its row. */
  channelOf?(card: KanbanCard): Channel | undefined
  open(card: KanbanCard, record: BoardRecord): void
}

/** What was said to the human: posts, questions and closing notes, newest first; a pick opens the channel at that line. */
export function saidSection(src: SaidSources): FindSection {
  return {
    id: 'said',
    title: 'Said',
    rows: query => {
      const needle = needleOf(query), now = Date.now()
      return saidHits(src.records(), src.cardOf, query).map(({ record, card, excerpt }) => {
        const channel = src.channelOf?.(card)
        const name = el('span', 'ws-channel-name'), word = SAID_WORD[record.kind]
        name.append(slug(card))
        if (word) name.append(' ', Object.assign(el('span', 'ws-find-kind'), { textContent: word }))
        return {
          key: record.id,
          label: `${slug(card)}: ${excerpt}`,
          content: face(name, [...channel ? [`#${channel.name}`] : [], timeEl(record.timestamp, now)], marked('ws-find-quote', excerpt, needle)),
          pick: () => src.open(card, record),
        }
      })
    },
  }
}

/** Sent documents by name, path, declared title or their fiber's name, newest first; a pick opens the file in the reader. */
export function filesSection(src: { documents(): Array<{ card: KanbanCard; receipt: Receipt }>; open(card: KanbanCard, key: DocKey): void }): FindSection {
  return {
    id: 'files',
    title: 'Files',
    rows: query => {
      const now = Date.now()
      return documentHits(src.documents(), key => declaredTitle(key)?.title, query).map(({ card, receipt }) => {
        const name = declaredTitle(receipt.key)?.title ?? receipt.basename
        const content = el('span', 'ws-find-face ws-find-file')
        content.append(fileRow({ key: receipt.key, name, at: receipt.timestamp, caption: receipt.caption }, now), Object.assign(document.createElement('small'), { textContent: slug(card) }))
        return { key: receipt.key, label: `${name}, from ${slug(card)}`, content, pick: () => src.open(card, receipt.key) }
      })
    },
  }
}

export interface TranscriptSources {
  shuttleBase: string
  /** Only the sessions that worked on this fiber. */
  fiber?: string
  /** The board's card for a fiber id a session worked on. */
  cardOf(id: string): KanbanCard | undefined
  open(card: KanbanCard): void
  /** Read only when asked, from one row (the board's scope); otherwise on every pause. */
  ask?: boolean
  title?: string
}

/** Sessions whose transcripts hold the words: a hit opens the constitution its session worked on, and its path can be copied. */
export function transcriptsSection(src: TranscriptSources): FindSection {
  const rowOf = (hit: TranscriptHit): FindRow => {
    const snippet = el('span', 'ws-search-snippet')
    for (const piece of snippetPieces(hit.snippet)) {
      if (!piece.hit) { snippet.append(piece.text); continue }
      const mark = document.createElement('mark')
      mark.textContent = piece.text
      snippet.append(mark)
    }
    const when = Date.parse(hit.timestamp)
    const meta = el('small', 'ws-search-meta')
    const parts: Array<string | HTMLElement> = [hit.harness || 'session', hit.session.slice(0, 8), projectName(hit.project), ...Number.isFinite(when) ? [timeEl(when, Date.now())] : [], `${hit.matches} ${hit.matches === 1 ? 'match' : 'matches'}`, ...hit.fibers.map(fiber => fiber.name || fiber.id)].filter(Boolean)
    meta.append(...parts.flatMap((part, n) => n ? [' · ', part] : [part]))
    const content = el('span', 'ws-search-result')
    content.title = hitLocation(hit)
    content.append(snippet, meta)
    const copy = el('button', 'ws-find-extra')
    copy.type = 'button'
    copy.textContent = 'copy path'
    copy.setAttribute('aria-label', 'Copy the transcript path and line')
    copy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(hitLocation(hit)).then(() => { copy.textContent = 'copied' }, () => { copy.textContent = 'not copied' })
    })
    const card = hit.fibers.map(fiber => src.cardOf(fiber.id)).find(Boolean)
    return { key: `${hit.session}:${hit.line}`, label: hit.snippet.replace(/[«»]/g, ''), content, extra: copy, ...card ? { pick: () => src.open(card) } : {} }
  }
  return {
    id: 'transcripts',
    title: src.title ?? 'Transcripts',
    min: 3,
    failed: 'Transcript search unavailable.',
    rows: () => [],
    read: async (query, signal) => (await searchTranscripts(src.shuttleBase, query, { limit: 8, ...src.fiber ? { fiber: src.fiber } : {} }, { signal })).hits.map(rowOf),
    ...src.ask ? { ask: (query: string) => `Search transcripts for “${query.trim()}”` } : {},
  }
}
