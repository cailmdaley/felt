import type { DocKey } from './documents.js'

export type WorkspaceRoute =
  /** `hash` names the view the entry addresses, known before an asynchronous pop lands. */
  | { kind: 'overview'; hash?: string }
  | { kind: 'channel'; uid: string; owner: string; doc?: DocKey }

/** Self-contained: the document bridge serializes it into each document's runtime. */
export function parseRoute(hash: string): WorkspaceRoute | null {
  const BOARD_HASH = '#/board'
  const decode = (value: string): string | null => { try { return decodeURIComponent(value) } catch { return null } }
  if (hash === BOARD_HASH) return { kind: 'overview', hash: '#/channels' }
  const prefix = `${BOARD_HASH}/`
  if (!hash.startsWith(prefix)) return null
  const addressAndDoc = hash.slice(prefix.length)
  const slash = addressAndDoc.indexOf('/')
  const address = slash < 0 ? addressAndDoc : addressAndDoc.slice(0, slash)
  const encodedDoc = slash < 0 ? undefined : addressAndDoc.slice(slash + 1)
  if (slash >= 0 && (!encodedDoc || encodedDoc.includes('/'))) return null
  const at = address.indexOf('@')
  if (at <= 0 || at === address.length - 1) return null
  const uid = decode(address.slice(0, at))
  const owner = decode(address.slice(at + 1))
  if (!uid || !owner) return null
  if (encodedDoc === undefined) return { kind: 'channel', uid, owner }
  const doc = decode(encodedDoc)
  if (!doc) return null
  return { kind: 'channel', uid, owner, doc }
}
