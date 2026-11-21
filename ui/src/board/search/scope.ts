/**
 * Where a Find stands, as a value: the active view or the reader says what the
 * board's Find searches there, and the field draws it as a chip.
 *
 * A list scope hangs a list of sections under the field, each a kind of thing
 * found (constitutions, channels, what was said, files, transcripts). An
 * in-place scope lists nothing: the view it belongs to answers the field
 * itself (a channel folds its stream to what matches).
 */

/** One thing a section found. */
export interface FindRow {
  /** Stable across redraws of the same answer, so the focused row keeps the focus. */
  key: string
  /** Its accessible name. */
  label: string
  /** What the row shows, built only for a row that is drawn. */
  content(): HTMLElement
  /** Picking it; absent for a row that can be named but not reached. */
  pick?(): void
  /** A second control beside the row (a transcript hit's "copy path"). */
  extra?: HTMLElement
  /** It is where the reader stands (the constitution being read). */
  current?: boolean
  /** Extra classes for the row's button. */
  className?: string
}

export interface FindSection {
  id: string
  /** Its caption. */
  title: string
  /** What the board holds that answers now, on every keystroke; `''` may list what a field offers before anything is typed. */
  rows(query: string): FindRow[]
  /** What the daemon answers, debounced; once it lands for the query it replaces `rows`. */
  read?(query: string, signal: AbortSignal): Promise<FindRow[]>
  /** The shortest query, in non-space characters, `read` waits for. */
  min?: number
  /** Ask before reading: the section draws one row with this label (⌘↵ chooses it) and reads only once it is chosen. */
  ask?(query: string): string
  /** What the section says when its read fails. */
  failed?: string
}

export interface ListScope {
  /** The chip's words (e.g. `in #channel`); none at the board's own scope. */
  chip?: string
  sections: FindSection[]
  /** The field is about to list: read what the sections will search. */
  open?(): void
}

/** A view that answers the field in place. */
export interface InPlace {
  input(query: string): void
  /** ↑ / ↓: the previous or next match. */
  step(by: 1 | -1): void
  /** Enter: keep the match in hand and leave the field. */
  keep(): void
  /** Escape, or the scope widening: lift what the field did. */
  clear(): void
}

export interface InPlaceScope { chip: string; inPlace: InPlace }

export type FindScope = ListScope | InPlaceScope

export const inPlace = (scope: FindScope): scope is InPlaceScope => 'inPlace' in scope
