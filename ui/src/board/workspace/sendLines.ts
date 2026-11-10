import type { KanbanCard } from '../KanbanTypes.js'
import type { MapFile } from '../family/model.js'
import type { HeaderIcon } from './headerIcon.js'
import { slug } from '../threadOutline.js'
import { COMPANION_NAMES, documentKind, normalizeAbsolutePath, parseDocKey } from './documents.js'

/** How a sent file is drawn on its send's line: an image as itself, anything else as a glyph and a name. */
export type SentMark = 'image' | 'page' | 'pdf' | 'code' | 'other'
/** Each mark's stroke icon, shared with the view control: a page is drawn as a thread's tapestry is. */
export const SENT_ICON: Readonly<Record<SentMark, HeaderIcon>> = { image: 'artifact', page: 'tapestry', pdf: 'pdf', code: 'code', other: 'file' }
export interface SentFile { file: MapFile; label: string; mark: SentMark }
/** The files one send carried, which share its moment. */
export interface Send { at: number; files: SentFile[] }

const CODE = /\.(py|ipynb|sh|bash|zsh|js|mjs|ts|go|ex|exs|jl|r|c|h|cc|cpp|rs|f90|sql|pl|lua|slurm|sbatch)$/i
/** A page whose file name says nothing of what it holds; its fiber's name does. */
const GENERIC = new Set<string>([...COMPANION_NAMES, 'index.html'])
/** A fiber's name long enough to give way to its slug. */
const LONG_NAME = 32

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export function sentMark(path: string): SentMark {
  const kind = documentKind(path)
  if (kind === 'image') return 'image'
  if (kind === 'html') return 'page'
  if (kind === 'pdf') return 'pdf'
  return CODE.test(path) ? 'code' : 'other'
}

/** The short name of the fiber whose directory holds `path`, the deepest when fibers nest. */
export function fiberHolding(path: string, cards: readonly Pick<KanbanCard, 'id' | 'name' | 'fiberDir'>[]): string | undefined {
  let best: { dir: string; card: Pick<KanbanCard, 'id' | 'name'> } | undefined
  for (const card of cards) {
    if (!card.fiberDir) continue
    const dir = normalizeAbsolutePath(card.fiberDir)
    if (path.startsWith(`${dir}/`) && dir.length > (best?.dir.length ?? -1)) best = { dir, card }
  }
  if (!best) return undefined
  const { name } = best.card
  return name && name.length <= LONG_NAME ? name : slug(best.card)
}

/**
 * A thread's sent files as sends, newest first: the files sharing a moment on
 * one line, named files before images. A file inside a fiber's directory takes
 * that fiber's name, unless the send carries several of that fiber's files and
 * its own name says more than a companion page's; a file outside every fiber
 * is named with its directory.
 */
export function sendLines(files: readonly MapFile[], fiberAt: (path: string) => string | undefined): Send[] {
  const moments = new Map<number, MapFile[]>()
  for (const file of files) moments.set(file.at, [...moments.get(file.at) ?? [], file])
  return [...moments].sort(([a], [b]) => b - a).map(([at, group]) => {
    const placed = group.map(file => { const path = parseDocKey(file.key)?.path; return { file, path, fiber: path ? fiberAt(path) : undefined } })
    const sent = placed.map(({ file, path, fiber }): SentFile => {
      if (!path) return { file, label: file.name, mark: sentMark(file.name) === 'image' ? 'other' : sentMark(file.name) }
      const name = basename(path), parent = basename(path.slice(0, path.lastIndexOf('/')))
      const alone = placed.filter(other => other.fiber === fiber).length === 1
      const label = fiber ? (GENERIC.has(name.toLowerCase()) || alone ? fiber : name) : parent ? `${parent}/${name}` : name
      return { file, label, mark: sentMark(path) }
    })
    return { at, files: [...sent.filter(file => file.mark !== 'image'), ...sent.filter(file => file.mark === 'image')] }
  })
}
