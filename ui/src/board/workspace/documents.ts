import { extractEmbeds, fileKind } from '../attachments.js'

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
  kind: 'fiber' | 'html' | 'pdf' | 'image' | 'text' | 'other'
  provenance: Provenance[]
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
  embeds?: { path: string; title?: string }[]
  sent?: { path: string; owner?: string; session?: string; time: number; worker?: string }[]
  links?: { path: string; owner?: string; title?: string }[]
  previous?: Channel
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
  return kind === 'audio' ? 'other' : kind
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

/** Build one owner-aware row, retaining arrival order and receipt history without mutating inputs. */
export function buildChannel(input: ChannelInput): Channel {
  const extracted = extractEmbeds(input.body)
  const documents = new Map<DocKey, WorkspaceDocument>()
  const prose: WorkspaceDocument = {
    key: fiberKey(input.owner, input.uid), owner: input.owner,
    path: normalizeAbsolutePath(input.path, input.fiberDir), name: input.name,
    kind: 'fiber', provenance: [{ kind: 'fiber' }],
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
        kind: documentKind(absolute), provenance: [],
      }
      documents.set(key, document)
    }
    if (!document.provenance.some((item) => provenanceKey(item) === provenanceKey(provenance))) {
      document.provenance.push({ ...provenance })
    }
  }

  for (const embed of input.embeds ?? extracted.attachments) {
    add(embed.path, input.owner, { kind: 'embed', ...(embed.title ? { title: embed.title } : {}) })
  }

  // The receipt feed may arrive newest-first; first delivery determines document order.
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

  const ordered: WorkspaceDocument[] = [prose]
  for (const old of previous?.documents ?? []) {
    if (old.kind === 'fiber') continue
    const arrival = documents.get(old.key)
    if (!arrival) continue
    ordered.push(arrival)
    documents.delete(old.key)
  }
  documents.delete(prose.key)
  ordered.push(...documents.values())

  const channel: Channel = {
    uid: input.uid, owner: input.owner, name: input.name,
    documents: ordered, labels: documentLabels(ordered), body: input.body,
  }
  if (input.outcome !== undefined) channel.outcome = input.outcome
  return channel
}

export function defaultSelection(channel: Channel): DocKey {
  const reports = channel.documents.filter((document) => document.name.toLowerCase() === 'report.html')
  const report = reports.find((document) => document.provenance.some((item) => item.kind === 'embed')) ?? reports[0]
  const prose = channel.documents.find((document) => document.kind === 'fiber')
  const first = report ?? prose ?? channel.documents[0]
  if (!first) throw new Error('Cannot select a document from an empty channel')
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

/** Shortest distinguishing folder suffix; report pages are labelled by their folder. */
export function documentLabels(documents: WorkspaceDocument[]): string[] {
  const parents = documents.map((document) => document.path.split('/').filter(Boolean).slice(0, -1))
  const bases = documents.map((document, index) => document.kind === 'fiber' ? 'Prose'
    : document.name.toLowerCase() === 'report.html' ? parents[index].at(-1) || document.name : document.name)
  const labels = documents.map((document, index) => {
    const peers = documents.map((_, other) => other).filter((other) => other !== index && bases[other] === bases[index])
    if (!peers.length) return bases[index]
    for (let depth = 1; depth <= parents[index].length; depth++) {
      const folder = parents[index].slice(-depth).join('/')
      if (peers.every((other) => parents[other].slice(-depth).join('/') !== folder)) {
        return document.name.toLowerCase() === 'report.html' ? folder : `${folder}/${bases[index]}`
      }
    }
    return `${document.owner}:${bases[index]}`
  })

  // A report folder can coincide with another file's basename; keep every tab label unique.
  const used = new Set<string>()
  return labels.map((label, index) => {
    let unique = label
    if (used.has(unique)) unique = `${documents[index].owner}:${unique}`
    let suffix = 2
    while (used.has(unique)) unique = `${documents[index].owner}:${documents[index].path} (${suffix++})`
    used.add(unique)
    return unique
  })
}
