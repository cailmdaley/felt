import type { KanbanCard } from '../KanbanTypes.js'
import { threadState, THREAD_LABEL } from '../threads.js'
import { fiberIndex, resolveWikilink, type FiberIndexEntry } from '../wikilinks.js'

export interface ConstitutionMention { id: string; uid?: string; name: string; state: string; outcome: string; origin: string }
export function constitutionMentions(cards: readonly KanbanCard[]): ConstitutionMention[] {
  return cards.filter(card => !!card.shuttleKind && !card.isCycle).map(card => {
    return { id: card.id, uid: card.uid, name: card.name, origin: card.originId, state: THREAD_LABEL[threadState(card)], outcome: card.outcome ?? '' }
  })
}

/** Only requested candidates cross the report boundary; ordinary fibers win the full-index resolution. */
export function resolveConstitutionCandidates(candidates: readonly string[], rows: ConstitutionMention[], index?: FiberIndexEntry[]) {
  const indexed = new Set(index?.map(row => row.id))
  const fullIndex = index ? [...index, ...rows.filter(row => !indexed.has(row.id))] : undefined
  const targets: Record<string, string> = Object.create(null)
  const mentioned = new Set<ConstitutionMention>()
  const byId = new Map<string, ConstitutionMention[]>()
  for (const row of rows) for (const key of new Set([row.id, row.uid].filter((key): key is string => !!key))) byId.set(key, [...(byId.get(key) ?? []), row])
  for (const candidate of candidates) {
    const wiki = candidate.startsWith('[[') && candidate.endsWith(']]')
    const id = wiki ? fullIndex ? resolveWikilink(candidate.slice(2, -2), fullIndex) : null : candidate
    const matches = id ? byId.get(id) ?? [] : []
    if (matches.length !== 1) continue
    targets[candidate] = matches[0].uid ?? matches[0].id
    mentioned.add(matches[0])
  }
  return { rows: [...mentioned], targets }
}

/** Dependency-free: the same scanner runs inside opaque report frames. */
export function mentionRuntime(root: HTMLElement, open: (id: string, origin: string) => void, request?: (candidates: string[]) => void) {
  let byId = new Map<string, ConstitutionMention[]>(), targets: Record<string, string> = Object.create(null)
  let scheduled = false, disposed = false, requested = ''
  const exact = (value: string, origin?: string): ConstitutionMention | undefined => {
    const matches = (byId.get(value) ?? []).filter(row => !origin || row.origin === origin)
    return matches.length === 1 ? matches[0] : undefined
  }
  const resolve = (candidate: string): ConstitutionMention | undefined => {
    if (candidate.startsWith('[[')) return Object.hasOwn(targets, candidate) ? exact(targets[candidate]) : undefined
    return exact(candidate)
  }
  const paint = (link: HTMLAnchorElement, row: ConstitutionMention, source: string): void => {
    link.classList.add('ws-constitution-chip')
    link.classList.remove('ws-constitution-chip-missing')
    link.removeAttribute('aria-disabled')
    link.dataset.mentionSource ??= source
    link.dataset.constitutionIdentity = row.uid ?? row.id
    link.dataset.constitution = row.id
    link.dataset.origin = row.origin
    link.dataset.state = row.state
    if (link.getAttribute('href') !== '#constitution') link.href = '#constitution'
    const label = `${row.name} · ${row.state}`
    if (link.textContent !== label) link.textContent = label
    const title = `${row.id}\n${row.state}${row.outcome ? '\n' + row.outcome : ''}`
    if (link.title !== title) link.title = title
    link.setAttribute('aria-label', label)
  }
  const scan = (): void => {
    if (disposed) return
    const candidates = new Set<string>()
    for (const link of root.querySelectorAll<HTMLAnchorElement>('a[data-constitution-identity],a.kbn-wikilink')) {
      const identity = link.dataset.constitutionIdentity
      const candidate = identity ?? `[[${link.dataset.fiber ?? ''}]]`
      candidates.add(candidate)
      const row = identity ? exact(identity, link.dataset.origin) : resolve(candidate)
      if (row) paint(link, row, link.dataset.wikilinkRaw ?? candidate)
      else if (identity) {
        delete link.dataset.constitution
        delete link.dataset.state
        link.classList.add('ws-constitution-chip-missing')
        link.removeAttribute('href'); link.removeAttribute('aria-label'); link.removeAttribute('role'); link.removeAttribute('tabindex')
        link.setAttribute('aria-disabled', 'true')
        if (link.textContent !== link.dataset.mentionSource) link.textContent = link.dataset.mentionSource ?? identity
        link.title = 'Constitution unavailable in the current read model'
      }
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const texts: Text[] = []
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      if (!node.parentElement?.closest('a,button,script,style,textarea,input,select,[contenteditable="true"],[data-mention-ignore]')) texts.push(node)
    }
    for (const node of texts) {
      const text = node.data
      // Complete tokens only: filesystem paths and URL components aren't fiber mentions.
      const pattern = /\[\[([^\]\n]+)\]\]|(?<![\w/:.\-])([\w-]+(?:\/[\w.-]+)*)(?![\w/\-]|\.[\w-])/g
      const urls = [...text.matchAll(/\b(?:[a-z][a-z\d+.-]*:\/\/|mailto:|www\.)[^\s<>\[\]"']+/gi)].map(match => [match.index!, match.index! + match[0].length])
      const fragment = document.createDocumentFragment()
      let end = 0, changed = false
      for (const match of text.matchAll(pattern)) {
        if (!match[1] && urls.some(([start, end]) => match.index! >= start && match.index! < end)) continue
        const raw = match[1] ? `[[${match[1]}]]` : match[2].replace(/[.,;:]+$/, '')
        if (!raw) continue
        candidates.add(raw)
        const row = resolve(raw)
        if (!row) continue
        fragment.append(text.slice(end, match.index))
        const link = document.createElement('a'); paint(link, row, raw); fragment.append(link)
        end = match.index! + (match[1] ? match[0].length : raw.length)
        changed = true
      }
      if (changed) { fragment.append(text.slice(end)); node.replaceWith(fragment) }
    }
    const list = [...candidates], key = JSON.stringify(list)
    if (request && key !== requested) {
      requested = key
      queueMicrotask(() => { if (!disposed) request(list) })
    }
  }
  const click = (event: Event): void => {
    const target = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[data-constitution-identity]')
    if (!target || !root.contains(target)) return
    if (event instanceof KeyboardEvent && !['Enter', ' '].includes(event.key)) return
    event.preventDefault(); event.stopPropagation()
    if (target.dataset.constitution) open(target.dataset.constitution, target.dataset.origin!)
  }
  root.addEventListener('click', click, true)
  root.addEventListener('keydown', click, true)
  const observer = new MutationObserver(() => {
    if (scheduled || disposed) return
    scheduled = true
    queueMicrotask(() => { scheduled = false; scan() })
  })
  observer.observe(root, { childList: true, characterData: true, subtree: true })
  return {
    update(next: ConstitutionMention[], resolved: Record<string, string> = Object.create(null)) {
      byId = new Map()
      for (const row of next) for (const key of new Set([row.id, row.uid].filter((key): key is string => !!key))) byId.set(key, [...(byId.get(key) ?? []), row])
      targets = resolved; scan()
    },
    dispose() { disposed = true; observer.disconnect(); root.removeEventListener('click', click, true); root.removeEventListener('keydown', click, true) },
  }
}

export interface MentionBindingOptions {
  shuttleBase: string
  /** null refuses unregistered frames; false permits resolution but not navigation. */
  frameActive(frame: HTMLIFrameElement): boolean | null
}

/** One workspace lifetime; feed updates repaint the same DOM and only referenced report metadata. */
export function bindConstitutionMentions(root: HTMLElement, cards: () => readonly KanbanCard[], open: (id: string, origin: string) => void,
  opts: MentionBindingOptions = { shuttleBase: '', frameActive: () => null }) {
  const surfaces = new Map<HTMLElement, { surface: ReturnType<typeof mentionRuntime>; candidates: string[] }>()
  const reports = new Map<HTMLIFrameElement, Set<string>>()
  const protocol = 'shuttle-constitution-mentions'
  let disposed = false, scheduled = false, index: FiberIndexEntry[] | undefined
  const rows = () => constitutionMentions(cards())
  const send = (frame: HTMLIFrameElement): void => {
    if (!root.contains(frame) || opts.frameActive(frame) === null) { reports.delete(frame); return }
    const candidates = reports.get(frame)
    if (!candidates) return
    const resolved = resolveConstitutionCandidates([...candidates], rows(), index)
    const colors = Object.fromEntries(['ink', 'ink-muted', 'sheet', 'hairline', 'agent', 'owed', 'tempered'].map(name => [name, getComputedStyle(root).getPropertyValue(`--kbn-${name}`)]))
    frame.contentWindow?.postMessage({ protocol, type: 'resolved', ...resolved, colors }, '*')
  }
  const paint = (entry: { surface: ReturnType<typeof mentionRuntime>; candidates: string[] }, next = rows()): void => {
    const resolved = resolveConstitutionCandidates(entry.candidates, next, index)
    // Local chips keep all identities so a moved or missing fiber updates in place.
    entry.surface.update(next, resolved.targets)
  }
  const refresh = (): void => {
    if (disposed) return
    for (const [element, entry] of surfaces) if (!root.contains(element)) { entry.surface.dispose(); surfaces.delete(element) }
    for (const element of root.querySelectorAll<HTMLElement>('.ws-prose-body,.kbn-detail-lede,.ws-transcript,.ws-transcript-pane')) {
      if (!surfaces.has(element)) {
        const entry = { surface: mentionRuntime(element, open, candidates => { entry.candidates = candidates; paint(entry) }), candidates: [] as string[] }
        surfaces.set(element, entry)
      }
    }
    const next = rows()
    for (const entry of surfaces.values()) paint(entry, next)
    for (const frame of reports.keys()) send(frame)
  }
  const receive = (event: MessageEvent): void => {
    const data = event.data
    if (!event.source || ![protocol, 'shuttle-document'].includes(data?.protocol)) return
    const frame = [...root.querySelectorAll<HTMLIFrameElement>('iframe')].find(frame => frame.contentWindow === event.source)
    if (!frame || opts.frameActive(frame) === null) return
    if (data.protocol === 'shuttle-document') {
      if (data.version === 1 && data.type === 'ready') frame.contentWindow?.postMessage({ protocol, type: 'scan' }, '*')
      return
    }
    if (data.type === 'candidates' && Array.isArray(data.candidates) && data.candidates.length <= 500
      && typeof data.reset === 'boolean' && typeof data.done === 'boolean'
      && Array.from(data.candidates).every((candidate: unknown) => typeof candidate === 'string' && candidate.length <= 256)) {
      const candidates = data.reset === true ? new Set<string>() : reports.get(frame) ?? new Set<string>()
      for (const candidate of data.candidates) candidates.add(candidate)
      reports.set(frame, candidates)
      if (data.done === true) send(frame)
    } else if (data.type === 'open' && opts.frameActive(frame) === true && typeof data.id === 'string' && typeof data.origin === 'string') {
      const permitted = resolveConstitutionCandidates([...(reports.get(frame) ?? [])], rows(), index).rows
      if (permitted.some(row => row.id === data.id && row.origin === data.origin)) open(data.id, data.origin)
    }
  }
  const observer = new MutationObserver(() => {
    if (scheduled || disposed) return
    scheduled = true; queueMicrotask(() => { scheduled = false; refresh() })
  })
  observer.observe(root, { childList: true, subtree: true })
  window.addEventListener('message', receive)
  void fiberIndex(opts.shuttleBase).then(value => { if (!disposed) { index = value; refresh() } }, () => {})
  refresh()
  return { refresh, dispose() { disposed = true; observer.disconnect(); window.removeEventListener('message', receive); for (const entry of surfaces.values()) entry.surface.dispose(); surfaces.clear(); reports.clear() } }
}
