import { ago } from '../civilDay.js'
import { extractEmbeds, fileKind } from '../attachments.js'
import { declaredTitle } from './DocumentTitles.js'

export type DocKey = string

export type Provenance =
  | { kind: 'fiber' }
  | { kind: 'embed'; title?: string }
  | { kind: 'sent'; session?: string; time: number; worker?: string }
  | { kind: 'link'; title?: string }
  /** A page opened by its address before the channel's own reads list it. */
  | { kind: 'routed' }

export interface WorkspaceDocument {
  key: DocKey
  owner: string
  path: string
  name: string
  /** `chat` is the worker's conversation; `fiber` the fiber's own prose. */
  kind: 'chat' | 'fiber' | 'html' | 'pdf' | 'image' | 'audio' | 'video' | 'text' | 'other'
  provenance: Provenance[]
  /** Owner-daemon file modification time; absent when unknown. */
  modifiedAt?: string
}

export interface Channel {
  uid: string
  owner: string
  name: string
  documents: WorkspaceDocument[]
  labels: string[]
  /** The source body, including embed directives. Fiber prose removes directives when rendering. */
  body: string
  outcome?: string
}

export interface ChannelInput {
  uid: string
  owner: string
  name: string
  path: string
  fiberDir: string
  body: string
  outcome?: string
  /** True when the fiber carries a `shuttle:` block. */
  isConstitution?: boolean
  /** True when the fiber has a worker conversation: the run then leads with its chat page. */
  conversation?: boolean
  /** The fiber's genuine owner-daemon modification time, never its creation time. */
  modifiedAt?: string
  embeds?: { path: string; title?: string }[]
  sent?: { path: string; owner?: string; session?: string; time: number; worker?: string }[]
  links?: { path: string; owner?: string; title?: string }[]
  /** Pages opened by address that no read has listed yet. */
  routed?: { path: string; owner?: string }[]
  previous?: Channel
  /** Owner-routed file mtimes indexed by normalized document identity. */
  fileModifiedAt?: ReadonlyMap<DocKey, string>
}

export interface ParsedDocKey {
  owner: string
  path: string
}

/** Lexical POSIX normalization; no filesystem, URL decoding or cwd dependency. */
export function normalizeAbsolutePath(path: string, base = '/'): string {
  const absolute = path.startsWith('/') ? path : `${normalizeAbsolutePath(base)}/${path}`
  const parts: string[] = []
  for (const part of absolute.split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** Choose the fiber's own companion before the newest receipt. Candidates are newest first. */
export function leadReceipt<T>(receipts: readonly T[], fiberDir: string | undefined, path: (receipt: T) => string, own: (receipt: T) => boolean = () => true): T | undefined {
  if (fiberDir !== undefined) {
    for (const name of ['artifact.html', 'report.html']) {
      const target = normalizeAbsolutePath(name, fiberDir)
      const match = receipts.find(receipt => own(receipt) && normalizeAbsolutePath(path(receipt), fiberDir) === target)
      if (match) return match
    }
  }
  return receipts[0]
}

function resolveOwner(owner: string | undefined, fiberOwner: string): string {
  return !owner || owner === 'local' ? fiberOwner : owner
}

/** A file identity is its byte-owning host and its normalized absolute path. */
export function docKey(owner: string, path: string, fiberOwner: string, base?: string): DocKey {
  return `${resolveOwner(owner, fiberOwner)}:${normalizeAbsolutePath(path, base)}`
}

/** Decode a file key, excluding the distinct `fiber:<owner>:<uid>` namespace. */
export function parseDocKey(key: DocKey): ParsedDocKey | null {
  const separator = key.indexOf(':/')
  if (separator <= 0) return null
  const owner = key.slice(0, separator)
  const path = key.slice(separator + 1)
  if (!owner || normalizeAbsolutePath(path) !== path) return null
  return { owner, path }
}

export function fiberKey(owner: string, uid: string): DocKey {
  return `fiber:${owner}:${uid}`
}

export function chatKey(owner: string, uid: string): DocKey {
  return `chat:${owner}:${uid}`
}

/** Each kind of page's mark, shared by thumbnails and the reader's tabs. */
export const KIND_GLYPH: Record<Exclude<WorkspaceDocument['kind'], 'chat'>, string> = { fiber: '§', html: '▣', image: '▨', pdf: '▧', text: '≡', audio: '♪', video: '▹', other: '□' }

/** Reuse the extension vocabulary that drives FileViewerPanel. A path is never a conversation. */
export function documentKind(path: string): Exclude<WorkspaceDocument['kind'], 'chat'> {
  const kind = fileKind(path)
  if (kind === 'markdown' || kind === 'text') return 'text'
  return kind
}

function provenanceKey(p: Provenance): string {
  switch (p.kind) {
    case 'fiber': return 'fiber'
    case 'embed': case 'link': return JSON.stringify([p.kind, p.title ?? ''])
    case 'routed': return 'routed'
    case 'sent': return JSON.stringify([p.kind, p.session ?? '', p.time, p.worker ?? ''])
  }
}

function receiptOrder(a: Provenance, b: Provenance): number {
  if (a.kind !== 'sent' || b.kind !== 'sent') return 0
  const at = Number.isFinite(a.time) ? a.time : Infinity
  const bt = Number.isFinite(b.time) ? b.time : Infinity
  return at - bt || (provenanceKey(a) < provenanceKey(b) ? -1 : provenanceKey(a) > provenanceKey(b) ? 1 : 0)
}

function sentProvenance(document: WorkspaceDocument, previous?: WorkspaceDocument): Provenance[] {
  const receipts = new Map<string, Provenance>()
  for (const source of [document, previous]) {
    for (const item of source?.provenance ?? []) {
      if (item.kind === 'sent') receipts.set(provenanceKey(item), { ...item })
    }
  }
  return [...receipts.values()].sort(receiptOrder)
}

/** Latest known receipt or owner-file activity; unknown dates sort last. */
export function documentActivity(document: WorkspaceDocument): number | undefined {
  const times = document.provenance.flatMap(p => p.kind === 'sent' && Number.isFinite(p.time) ? [p.time] : [])
  const modified = document.modifiedAt ? Date.parse(document.modifiedAt) : NaN
  if (Number.isFinite(modified)) times.push(modified)
  return times.length ? Math.max(...times) : undefined
}

/** The latest receipt's time; undefined when no receipt carries a valid time. */
export function lastSent(document: WorkspaceDocument): number | undefined {
  const times = document.provenance.flatMap(p => p.kind === 'sent' && Number.isFinite(p.time) ? [p.time] : [])
  return times.length ? Math.max(...times) : undefined
}

/** True when the body declares the document, as an embed or a link. */
export function isDeclared(document: WorkspaceDocument): boolean {
  return document.provenance.some(p => p.kind === 'embed' || p.kind === 'link')
}

function isReport(document: WorkspaceDocument): boolean {
  return ['artifact.html', 'report.html'].includes(document.name.toLowerCase())
}

/** True when the document runs left of the fiber page: the body declares it. */
export function runsLeft(document: WorkspaceDocument): boolean {
  return isDeclared(document)
}

/**
 * Each side's order outward from the fiber page. On the left, a declared
 * report comes first, then the other declarations in body order; on the
 * right, documents run by their latest receipt, newest first, then sends
 * whose time is unknown, so a re-send moves its document beside the fiber
 * page. Identity breaks every tie. `declared` maps a document to its position
 * among the body's declarations.
 */
export function compareDocuments(declared: ReadonlyMap<DocKey, number> = new Map()) {
  const rank = (doc: WorkspaceDocument): [number, number] => {
    if (runsLeft(doc)) return [0, isReport(doc) ? -1 : declared.get(doc.key) ?? Infinity]
    const sent = lastSent(doc)
    if (sent !== undefined) return [1, -sent]
    return doc.provenance.some(p => p.kind === 'sent') ? [2, 0] : [3, 0]
  }
  return (a: WorkspaceDocument, b: WorkspaceDocument): number => {
    const [ag, av] = rank(a), [bg, bv] = rank(b)
    return ag - bg || (av === bv ? 0 : av < bv ? -1 : 1) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  }
}

/**
 * A channel's run of pages with the fiber page at its centre: declared
 * documents to its left, sent and routed ones to its right, each
 * side ordered outward from it by `compareDocuments`.
 */
export function arrangeDocuments(prose: WorkspaceDocument, others: Iterable<WorkspaceDocument>, declared: ReadonlyMap<DocKey, number> = new Map()): WorkspaceDocument[] {
  const outward = [...others].sort(compareDocuments(declared))
  return [...outward.filter(runsLeft).reverse(), prose, ...outward.filter(d => !runsLeft(d))]
}

/** The fiber's own page in a channel's run. */
export function proseDocument(channel: Channel): WorkspaceDocument | undefined {
  return channel.documents.find(d => d.kind === 'fiber')
}

/** The worker conversation's page, when the fiber has one. */
export function chatDocument(channel: Channel): WorkspaceDocument | undefined {
  return channel.documents.find(d => d.kind === 'chat')
}

/** The channel's own companion or newest sent document. */
export function channelLead(channel: Channel): WorkspaceDocument | undefined {
  const prose = proseDocument(channel)
  const dir = prose?.path.slice(0, prose.path.lastIndexOf('/')) || '/'
  const files = channel.documents.filter(d => d.kind !== 'fiber' && d.kind !== 'chat')
  const sent = files.filter(d => lastSent(d) !== undefined).sort((a, b) => (lastSent(b) ?? 0) - (lastSent(a) ?? 0))
  const companions = files.filter(d => d.owner === channel.owner && isReport(d) && normalizeAbsolutePath(d.path.slice(0, d.path.lastIndexOf('/')) || '/') === normalizeAbsolutePath(dir))
  return leadReceipt([...sent, ...companions.filter(d => !sent.includes(d))], dir, d => d.path, d => d.owner === channel.owner)
}

/** Build one owner-aware row, retaining receipt history without mutating inputs. */
export function buildChannel(input: ChannelInput): Channel {
  const extracted = extractEmbeds(input.body)
  const documents = new Map<DocKey, WorkspaceDocument>()
  const prose: WorkspaceDocument = {
    key: fiberKey(input.owner, input.uid), owner: input.owner,
    path: normalizeAbsolutePath(input.path, input.fiberDir), name: input.name,
    kind: 'fiber', provenance: [{ kind: 'fiber' }],
    ...(input.modifiedAt !== undefined ? { modifiedAt: input.modifiedAt } : {}),
  }
  documents.set(prose.key, prose)

  const add = (path: string, owner: string | undefined, provenance: Provenance): void => {
    const absolute = normalizeAbsolutePath(path, input.fiberDir)
    const resolvedOwner = resolveOwner(owner, input.owner)
    const key = docKey(resolvedOwner, absolute, input.owner)
    let document = documents.get(key)
    if (!document) {
      const name = absolute.split('/').pop() || absolute
      document = {
        key, owner: resolvedOwner, path: absolute, name,
        kind: documentKind(absolute), provenance: [], modifiedAt: input.fileModifiedAt?.get(key),
      }
      documents.set(key, document)
    }
    if (!document.provenance.some((item) => provenanceKey(item) === provenanceKey(provenance))) {
      document.provenance.push({ ...provenance })
    }
  }

  // Declarations keep their body order: embeds, then links.
  const declared = new Map<DocKey, number>()
  const declare = (path: string, owner: string | undefined): void => {
    const key = docKey(resolveOwner(owner, input.owner), normalizeAbsolutePath(path, input.fiberDir), input.owner)
    if (!declared.has(key)) declared.set(key, declared.size)
  }
  for (const embed of input.embeds ?? extracted.attachments) {
    declare(embed.path, input.owner)
    add(embed.path, input.owner, { kind: 'embed', ...(embed.title ? { title: embed.title } : {}) })
  }

  // Sort receipts chronologically within each document's provenance.
  const sent = [...(input.sent ?? [])].sort((a, b) => {
    const at = Number.isFinite(a.time) ? a.time : Infinity
    const bt = Number.isFinite(b.time) ? b.time : Infinity
    const ak = docKey(a.owner ?? '', a.path, input.owner, input.fiberDir)
    const bk = docKey(b.owner ?? '', b.path, input.owner, input.fiberDir)
    return at - bt || (ak < bk ? -1 : ak > bk ? 1 : 0)
  })
  for (const receipt of sent) {
    add(receipt.path, receipt.owner, {
      kind: 'sent', time: receipt.time,
      ...(receipt.session ? { session: receipt.session } : {}),
      ...(receipt.worker ? { worker: receipt.worker } : {}),
    })
  }
  for (const link of input.links ?? []) {
    declare(link.path, link.owner)
    add(link.path, link.owner, { kind: 'link', ...(link.title ? { title: link.title } : {}) })
  }
  for (const page of input.routed ?? []) add(page.path, page.owner, { kind: 'routed' })

  const previous = input.previous?.uid === input.uid && input.previous.owner === input.owner
    ? input.previous : undefined
  for (const document of documents.values()) {
    if (document.kind === 'fiber') continue
    const old = previous?.documents.find((candidate) => candidate.key === document.key)
    if (!old) continue
    const currentNonReceipts = document.provenance.filter((item) => item.kind !== 'sent')
    document.provenance = [
      ...currentNonReceipts.filter((item) => item.kind === 'embed'),
      ...sentProvenance(document, old),
      ...currentNonReceipts.filter((item) => item.kind === 'link' || item.kind === 'routed'),
    ]
  }

  documents.delete(prose.key)
  const run = arrangeDocuments(prose, documents.values(), declared)
  // A conversation's run ends in its chat, the page a constitution opens on.
  // The files run left of it, outward from its latest word one step away (the
  // report, else the newest sent file), then the declared documents in body
  // order and the sent ones newest first. The constitution page, read rarely,
  // stands at the far end.
  const files = run.filter(d => d !== prose)
  const latest = files.find(isReport) ?? files.filter(d => lastSent(d) !== undefined).sort((x, y) => lastSent(y)! - lastSent(x)!)[0]
  const outward = [...(latest ? [latest] : []), ...files.filter(d => d !== latest).sort(compareDocuments(declared))]
  const ordered = input.conversation ? [prose, ...outward.reverse(), {
    key: chatKey(input.owner, input.uid), owner: input.owner, path: prose.path, name: input.name,
    kind: 'chat' as const, provenance: [{ kind: 'fiber' as const }],
  }] : run

  const channel: Channel = {
    uid: input.uid, owner: input.owner, name: input.name,
    documents: ordered, labels: documentLabels(ordered, input.isConstitution), body: input.body,
  }
  if (input.outcome !== undefined) channel.outcome = input.outcome
  return channel
}

/** The frame owns document naming and arrival metadata; renderers own content only. */
export function documentLabelMetadata(doc: WorkspaceDocument, label: string, channelOwner: string, now = Date.now()): { title: string; summary: string } {
  const age = (time: number): string => ago(time, now)
  if (doc.kind === 'chat') return { title: '', summary: 'Conversation' }
  if (doc.kind === 'fiber') {
    const time = doc.modifiedAt ? Date.parse(doc.modifiedAt) : NaN
    return { title: '', summary: Number.isFinite(time) ? `Last changed ${age(time)}` : 'Last changed unknown' }
  }
  const sent = doc.provenance.filter(p => p.kind === 'sent')
  const latest = sent.filter(p => Number.isFinite(p.time)).sort((a, b) => b.time - a.time)[0]
  const embed = doc.provenance.find(p => p.kind === 'embed')
  const linked = doc.provenance.some(p => p.kind === 'link')
  const segments = [sent.length ? latest ? `sent ${age(latest.time)}` : 'sent · time unknown' : embed ? 'embedded' : linked ? 'linked from body' : 'opened by address']
  if (sent.length > 1) segments.push(`${sent.length} receipts`)
  if (doc.owner !== channelOwner) segments.push(doc.owner)
  return { title: declaredTitle(doc.key)?.title ?? (embed?.kind === 'embed' && embed.title ? embed.title : label), summary: segments.join(' · ') }
}

export function defaultSelection(channel: Channel): DocKey {
  const chat = chatDocument(channel)
  if (chat) return chat.key
  const reports = channel.documents.filter(isReport)
  const report = channelLead(channel)
    ?? reports.find(document => document.provenance.some(item => item.kind === 'embed'))
    ?? reports.find(document => !isDeclared(document)) ?? reports[0]
  const prose = channel.documents.find((document) => document.kind === 'fiber')
  const first = report ?? prose ?? channel.documents[0]
  if (!first) throw new Error('Cannot select a document from an empty constitution')
  return first.key
}

/**
 * Keep selection if it survives; otherwise walk the old run from it toward
 * its anchor (the chat, else the fiber page) and take the first page that
 * survives, else the anchor.
 */
export function fallbackSelection(previousKeys: DocKey[], nextKeys: DocKey[], selected: DocKey): DocKey | undefined {
  if (!nextKeys.length) return undefined
  if (nextKeys.includes(selected)) return selected
  const survives = new Set(nextKeys)
  const isAnchor = (keys: DocKey[]) => keys.some(key => key.startsWith('chat:')) ? (key: DocKey) => key.startsWith('chat:') : (key: DocKey) => key.startsWith('fiber:')
  const from = previousKeys.indexOf(selected)
  const anchor = previousKeys.findIndex(isAnchor(previousKeys))
  if (from >= 0 && anchor >= 0) {
    const step = anchor > from ? 1 : -1
    for (let i = from + step; i !== anchor + step; i += step) if (survives.has(previousKeys[i])) return previousKeys[i]
  }
  return nextKeys.find(isAnchor(nextKeys)) ?? nextKeys[0]
}

/** Use the shortest unique path suffix, with report pages named for their folder. */
export function documentLabels(documents: WorkspaceDocument[], isConstitution = false): string[] {
  const candidates = documents.map((document) => {
    const labels: string[] = []
    const add = (label: string): void => { if (label && !labels.includes(label)) labels.push(label) }
    if (document.kind === 'chat') return ['Chat']
    if (document.kind === 'fiber') {
      add(isConstitution ? 'Constitution' : 'Note')
      return labels
    }

    add(declaredTitle(document.key)?.title ?? '')
    const title = document.provenance.find(p => p.kind === 'embed' && p.title)
    if (title?.kind === 'embed') add(title.title ?? '')
    const parts = document.path.split('/').filter(Boolean)
    const reportPage = /^(?:report|index)\.html$/i.test(document.name)
    if (reportPage) {
      const folders = parts.slice(0, -1)
      for (let depth = 1; depth <= folders.length; depth++) {
        const first = folders.length - depth
        if (first > 0 && folders[first].length <= 2) continue
        add(folders.slice(first).join('/'))
      }
      if (!folders.length) add(document.name)
      for (let depth = 2; depth <= parts.length; depth++) {
        const first = parts.length - depth
        if (first > 0 && parts[first].length <= 2) continue
        add(parts.slice(first).join('/'))
      }
    } else {
      add(document.name)
      for (let depth = 2; depth <= parts.length; depth++) {
        const first = parts.length - depth
        if (first > 0 && parts[first].length <= 2) continue
        add(parts.slice(first).join('/'))
      }
    }
    if (!labels.length) add(document.name)
    return labels
  })

  const positions = documents.map(() => 0)
  const ownerQualified = documents.map(() => false)
  const fallback = documents.map(() => false)
  const labelAt = (index: number): string => {
    const document = documents[index]
    if (fallback[index]) return document.kind === 'fiber'
      ? `${document.owner}:${isConstitution ? 'Constitution' : 'Note'}`
      : `${document.owner}:${document.path}`
    const label = candidates[index][positions[index]]
    return ownerQualified[index] ? `${document.owner}:${label}` : label
  }

  let changed = true
  while (changed) {
    changed = false
    const groups = new Map<string, number[]>()
    for (let index = 0; index < documents.length; index++) {
      const label = labelAt(index)
      const group = groups.get(label) ?? []
      group.push(index)
      groups.set(label, group)
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue
      const byPath = new Map<string, number[]>()
      for (const index of group) {
        const path = documents[index].path
        byPath.set(path, [...(byPath.get(path) ?? []), index])
      }
      const ownerTies = new Set<number>()
      for (const samePath of byPath.values()) {
        const owners = new Set(samePath.map((index) => documents[index].owner))
        const qualifiedLabels = new Set(samePath.map((index) => `${documents[index].owner}:${candidates[index][positions[index]]}`))
        if (samePath.length < 2 || owners.size !== samePath.length || qualifiedLabels.size !== samePath.length) continue
        for (const index of samePath) {
          if (!ownerQualified[index]) {
            ownerQualified[index] = true
            changed = true
          }
          ownerTies.add(index)
        }
      }
      for (const index of group) {
        if (ownerTies.has(index)) continue
        if (positions[index] + 1 < candidates[index].length) {
          positions[index]++
          changed = true
        } else if (!ownerQualified[index]) {
          ownerQualified[index] = true
          changed = true
        } else if (!fallback[index]) {
          fallback[index] = true
          changed = true
        }
      }
    }
  }

  const used = new Set<string>()
  return documents.map((document, index) => {
    let label = labelAt(index)
    let suffix = 2
    while (used.has(label)) label = `${document.owner}:${document.path} (${suffix++})`
    used.add(label)
    return label
  })
}
