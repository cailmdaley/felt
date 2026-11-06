import type { KanbanCard } from '../KanbanTypes.js'
import { Voice, VoiceRequestError } from '../voice.js'

interface HeldSpan {
  id: string
  through: number
  after: number
  uncertain?: boolean
  source: string
  start: number
  end: number
  join: string
}
export interface VoiceCompose {
  text: string
  held: Pick<HeldSpan, 'id' | 'after' | 'through'> | null
}

/** The held part of an ordinary composer draft, including edits made inside it. */
export class HeldVoiceComposer {
  private span: HeldSpan | null = null
  private value: string
  private sources = new Set<string>()
  private edits = new Set<{ id: string; after: number; through: number; text: string }>()
  private frozen = false
  private consumed: VoiceCompose['held'] = null
  private unsubscribe: () => void
  private readonly field: HTMLTextAreaElement
  private readonly voice: Voice
  private readonly card: KanbanCard
  private readonly storageKey: string
  private readonly changed: () => void
  private readonly failed: (error: Error) => void

  constructor(field: HTMLTextAreaElement, voice: Voice, card: KanbanCard, draftStore: string, changed: () => void, failed: (error: Error) => void) {
    this.field = field; this.voice = voice; this.card = card
    this.storageKey = `${draftStore}:voice`
    this.changed = changed; this.failed = failed; this.value = field.value
    try {
      const saved = JSON.parse(localStorage.getItem(this.storageKey) ?? 'null') as HeldSpan | null
      if (saved && typeof saved.id === 'string' && typeof saved.source === 'string' && typeof saved.join === 'string'
        && Number.isInteger(saved.through) && Number.isInteger(saved.start) && Number.isInteger(saved.end)
        && saved.start >= 0 && saved.end >= saved.start && saved.end <= field.value.length) this.span = { ...saved, after: saved.after ?? 0 }
    } catch { /* storage unavailable */ }
    if (this.span) this.sources = new Set([this.span.source, field.value.slice(this.span.start, this.span.end)])
    field.addEventListener('input', this.input)
    this.unsubscribe = voice.subscribe(this.paint)
    this.paint()
    try {
      const recovery = localStorage.getItem(`${this.storageKey}:recovery`)
      if (recovery) this.failed(new Error(recovery))
    } catch { /* storage unavailable */ }
  }

  dispose(): void { this.field.removeEventListener('input', this.input); this.unsubscribe() }

  /** Freeze the shown checkpoint while images upload and the claim is made. */
  begin(): VoiceCompose {
    this.frozen = true
    return { text: this.field.value, held: this.span && { id: this.span.id, after: this.span.after, through: this.span.through } }
  }

  async release(compose: VoiceCompose): Promise<void> {
    if (!compose.held) return
    try {
      await this.voice.releaseHeld(compose.held)
      // The words remain an ordinary draft until delivery succeeds. Later
      // speech gets its own span and cannot be cleared by this send.
      this.span = null
      this.sources.clear()
      this.save()
    } catch (error) {
      if (error instanceof VoiceRequestError && error.status === 409) {
        this.consumed = compose.held
        throw error
      }
      // A failed response cannot tell us whether the claim committed. Keep
      // the edited draft even if a later poll says the held range is gone.
      if (this.span) this.span.uncertain = true
      this.save()
      const detail = `${(error as Error).message}. Voice release was not confirmed; nothing was dispatched by this button. Check the worker's conversation before sending again. Retained draft:\n\n${compose.text}`
      try { localStorage.setItem(`${this.storageKey}:recovery`, detail) } catch { /* storage unavailable */ }
      throw new Error(detail)
    }
  }

  finish(): void { this.frozen = false; this.paint() }

  sent(text: string): void {
    try { localStorage.removeItem(`${this.storageKey}:recovery`) } catch { /* storage unavailable */ }
    if (this.field.value === text) this.replace(0, text.length, '')
    else if (this.span && this.field.value.startsWith(text) && this.span.start >= text.length) {
      let end = text.length
      if (this.span.start === end + this.span.join.length) { end = this.span.start; this.span.join = '' }
      this.replace(0, end, '')
    }
  }

  private input = (): void => {
    const before = this.value, after = this.field.value
    if (before === after) return
    let start = 0, tail = 0
    while (start < before.length && start < after.length && before[start] === after[start]) start++
    while (tail < before.length - start && tail < after.length - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++
    const previousHeld = this.span && before.slice(this.span.start, this.span.end)
    const end = before.length - tail, added = after.length - tail - start
    this.moveSpan(start, end, added)
    this.value = after
    this.save()
    if (!this.span || this.frozen) return
    const text = after.slice(this.span.start, this.span.end)
    if (text === previousHeld) return
    this.sources.add(text)
    const edit = { id: this.span.id, after: this.span.after, through: this.span.through, text }
    this.edits.add(edit)
    void this.voice.editHeld(this.span, text, () => {
      this.edits.delete(edit)
      const span = this.span
      if (!span || span.id !== edit.id || span.after !== edit.after || span.through !== edit.through) return
      // Only acknowledged and still-pending prefixes can describe this range.
      span.source = edit.text
      this.sources = new Set([edit.text, this.field.value.slice(span.start, span.end),
        ...[...this.edits].filter(row => row.id === span.id && row.after === span.after).map(row => row.text)])
    }).catch(error => {
      this.edits.delete(edit)
      this.paint()
      if (!(error instanceof VoiceRequestError && error.status === 409)) this.failed(error as Error)
    })
  }

  private paint = (): void => {
    const state = this.voice.status
    // A failed poll is not evidence that the daemon sent these words.
    if (this.frozen || !state || !state.held) return
    const held = state.held.find(row => (row.fiber_id === this.card.id || row.fiber_id === this.card.uid) && row.origin === this.card.originId
      && !(row.id === this.consumed?.id && (row.after ?? 0) <= this.consumed.after && row.through <= this.consumed.through))
    if (this.span && this.span.id !== held?.id) {
      if (this.span.uncertain) {
        this.span = null
        this.sources.clear()
        this.save()
      } else this.remove()
    }
    if (!held) return
    const after = held.after ?? 0
    if (this.span && (after < this.span.after || held.through < this.span.through)) return
    // An edit response tells us which prefix new speech extends. Wait for it
    // before growing the range; a consumed-prefix change still wins at once.
    if (this.span && after === this.span.after && [...this.edits].some(edit => edit.id === held.id && edit.after === after)) return
    if (!this.span) {
      const join = this.field.value ? '\n\n' : ''
      const start = this.field.value.length + join.length
      this.replace(this.field.value.length, this.field.value.length, join + held.text)
      this.span = { id: held.id, after, through: held.through, source: held.text, start, end: start + held.text.length, join }
      this.sources = new Set([held.text])
    } else if (after > this.span.after || held.through > this.span.through) {
      const prefix = after > this.span.after ? undefined : [...this.sources].filter(text => held.text.startsWith(text)).sort((a, b) => b.length - a.length)[0]
      // A remaining suffix has no shown prefix after another path consumes
      // that checkpoint. Replace only the voice span in that case.
      const from = prefix === undefined ? this.span.start : this.span.end
      const suffix = prefix === undefined ? held.text : held.text.slice(prefix.length)
      const end = this.span.end
      this.replace(from, end, suffix)
      this.span.end = from + suffix.length
      this.span.through = held.through
      this.span.after = after
      this.span.source = held.text
      this.sources = new Set([held.text, this.field.value.slice(this.span.start, this.span.end)])
    } else if (held.through === this.span.through) {
      // A poll can confirm an edit whose response was lost. Keep the current
      // local text as a candidate, but retire superseded server prefixes.
      this.span.source = held.text
      this.sources = new Set([held.text, this.field.value.slice(this.span.start, this.span.end)])
    }
    this.save()
  }

  private remove(): void {
    if (!this.span) return
    const { start, end, join } = this.span
    const from = join && this.field.value.slice(start - join.length, start) === join ? start - join.length : start
    this.span = null
    this.sources.clear()
    this.replace(from, end, '')
  }

  private moveSpan(start: number, end: number, added: number): void {
    const span = this.span
    if (!span) return
    const delta = added - (end - start)
    if (end <= span.start && start < span.start) { span.start += delta; span.end += delta }
    else if (start < span.end) {
      span.start = span.start <= start ? span.start : span.start >= end ? span.start + delta : start
      span.end = span.end >= end ? span.end + delta : start + added
    }
  }

  private replace(start: number, end: number, text: string): void {
    const { selectionStart, selectionEnd, selectionDirection, scrollTop } = this.field
    this.field.setRangeText(text, start, end, 'preserve')
    this.moveSpan(start, end, text.length)
    // Voice growth never relocates the caret, including at the old end.
    const position = (at: number): number => at <= start ? at : at >= end ? at + text.length - (end - start) : start
    this.field.setSelectionRange(position(selectionStart), position(selectionEnd), selectionDirection)
    this.field.scrollTop = scrollTop
    this.value = this.field.value
    this.save()
    this.changed()
  }

  private save(): void {
    try {
      if (this.span) localStorage.setItem(this.storageKey, JSON.stringify(this.span))
      else localStorage.removeItem(this.storageKey)
    } catch { /* storage unavailable */ }
  }
}
