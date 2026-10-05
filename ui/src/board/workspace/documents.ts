import { extractEmbeds, fileKind } from '../attachments.js'
import { declaredTitle } from './DocumentTitles.js'

export type DocKey = string

export type Provenance =
  | { kind: 'fiber' }
  | { kind: 'embed'; title?: string }
  | { kind: 'sent'; session?: string; time: number; worker?: string }
  | { kind: 'link'; title?: string }

export interface WorkspaceDocument {
  key: DocKey
  owner: string
  path: string
  name: string
  kind: 'fiber' | 'html' | 'pdf' | 'image' | 'audio' | 'video' | 'text' | 'other'
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
  /** The fiber's genuine owner-daemon modification time, never its creation time. */
  modifiedAt?: string
  embeds?: { path: string; title?: string }[]
  sent?: { path: string; owner?: string; session?: string; time: number; worker?: string }[]
  links?: { path: string; owner?: string; title?: string }[]
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

/** Reuse the extension vocabulary that drives FileViewerPanel. */
export function documentKind(path: string): WorkspaceDocument['kind'] {
  const kind = fileKind(path)
  if (kind === 'markdown' || kind === 'text') return 'text'
  return kind
}

function provenanceKey(p: Provenance): string {
  switch (p.kind) {
    case 'fiber': return 'fiber'
    case 'embed': case 'link': return JSON.stringify([p.kind, p.title ?? ''])
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

/** The first receipt's time; undefined when no receipt carries a valid time. */
export function firstSent(document: WorkspaceDocument): number | undefined {
  const times = document.provenance.flatMap(p => p.kind === 'sent' && Number.isFinite(p.time) ? [p.time] : [])
  return times.length ? Math.min(...times) : undefined
}

/**
 * A channel's order after its fiber page: documents declared in the body and
 * never sent, in body order; then sent documents by their first delivery,
 * oldest first; then sends whose time is unknown. A re-send never moves a
 * document. Identity breaks every tie. `declared` maps a document to its
 * position among the body's declarations.
 */
export function compareDocuments(declared: ReadonlyMap<DocKey, number> = new Map()) {
  const rank = (doc: WorkspaceDocument): [number, number] => {
    const sent = firstSent(doc)
    if (sent !== undefined) return [1, sent]
    const position = declared.get(doc.key)
    return position !== undefined ? [0, position] : [2, 0]
  }
  return (a: WorkspaceDocument, b: WorkspaceDocument): number => {
    const [ag, av] = rank(a), [bg, bv] = rank(b)
    return ag - bg || av - bv || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  }
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
      ...currentNonReceipts.filter((item) => item.kind === 'link'),
    ]
  }

  documents.delete(prose.key)
  const ordered = [prose, ...[...documents.values()].sort(compareDocuments(declared))]

  const channel: Channel = {
    uid: input.uid, owner: input.owner, name: input.name,
    documents: ordered, labels: documentLabels(ordered, input.isConstitution), body: input.body,
  }
  if (input.outcome !== undefined) channel.outcome = input.outcome
  return channel
}

/** The frame owns document naming and arrival metadata; renderers own content only. */
export function documentLabelMetadata(doc: WorkspaceDocument, label: string, channelOwner: string, now = Date.now()): { title: string; summary: string } {
  const age = (time: number): string => {
    const minutes = Math.max(0, Math.round((now - time) / 60000))
    return `${minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`} ago`
  }
  if (doc.kind === 'fiber') {
    const time = doc.modifiedAt ? Date.parse(doc.modifiedAt) : NaN
    return { title: '', summary: Number.isFinite(time) ? `Last changed ${age(time)}` : 'Last changed unknown' }
  }
  const sent = doc.provenance.filter(p => p.kind === 'sent')
  const latest = sent.filter(p => Number.isFinite(p.time)).sort((a, b) => b.time - a.time)[0]
  const embed = doc.provenance.find(p => p.kind === 'embed')
  const segments = [sent.length ? latest ? `sent ${age(latest.time)}` : 'sent · time unknown' : embed ? 'embedded' : 'linked from body']
  if (sent.length > 1) segments.push(`${sent.length} receipts`)
  if (doc.owner !== channelOwner) segments.push(doc.owner)
  return { title: declaredTitle(doc.key)?.title ?? (embed?.kind === 'embed' && embed.title ? embed.title : label), summary: segments.join(' · ') }
}

export function defaultSelection(channel: Channel): DocKey {
  const reports = channel.documents.filter((document) => document.name.toLowerCase() === 'report.html')
  const report = reports.find((document) => document.provenance.some((item) => item.kind === 'embed')) ?? reports[0]
  const prose = channel.documents.find((document) => document.kind === 'fiber')
  const first = report ?? prose ?? channel.documents[0]
  if (!first) throw new Error('Cannot select a document from an empty constitution')
  return first.key
}

/** Keep selection if it survives; otherwise take its old position, then the prior page. */
export function fallbackSelection(previousKeys: DocKey[], nextKeys: DocKey[], selected: DocKey): DocKey | undefined {
  if (!nextKeys.length) return undefined
  if (nextKeys.includes(selected)) return selected
  const oldIndex = previousKeys.indexOf(selected)
  const index = Math.min(Math.max(0, oldIndex), nextKeys.length - 1)
  return nextKeys[index]
}

/** Use the shortest unique path suffix, with report pages named for their folder. */
export function documentLabels(documents: WorkspaceDocument[], isConstitution = false): string[] {
  const candidates = documents.map((document) => {
    const labels: string[] = []
    const add = (label: string): void => { if (label && !labels.includes(label)) labels.push(label) }
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
