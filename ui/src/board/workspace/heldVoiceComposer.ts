import type { KanbanCard } from '../KanbanTypes.js'
import { Voice, VoiceRequestError } from '../voice.js'

interface HeldSpan {
  id: string
  through: number
  after: number
  uncertain?: boolean
  boundaryUncertain?: boolean
  start: number
  end: number
  join: string
}
export interface VoiceCompose {
  text: string
  held: Pick<HeldSpan, 'id' | 'after' | 'through'> | null
}

const boundaryError = (): Error => new Error('The voice draft changed beyond its displayed checkpoint. Your edited copy is retained; check the worker’s conversation before sending it.')

/** The held part of an ordinary composer draft, including edits made inside it. */
export class HeldVoiceComposer {
  private span: HeldSpan | null = null
  private value: string
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
      if (saved && typeof saved.id === 'string' && typeof saved.join === 'string'
        && Number.isInteger(saved.through) && Number.isInteger(saved.after ?? 0) && Number.isInteger(saved.start) && Number.isInteger(saved.end)
        && saved.start >= 0 && saved.end >= saved.start && saved.end <= field.value.length) {
        this.span = { id: saved.id, after: saved.after ?? 0, through: saved.through, start: saved.start, end: saved.end,
          join: saved.join, uncertain: saved.uncertain, boundaryUncertain: saved.boundaryUncertain }
      }
    } catch { /* storage unavailable */ }
    field.addEventListener('input', this.input)
    this.unsubscribe = voice.subscribe(this.paint)
    this.paint()
    if (this.span?.boundaryUncertain) this.failed(boundaryError())
    try {
      const recovery = localStorage.getItem(`${this.storageKey}:recovery`)
      if (recovery) this.failed(new Error(recovery))
    } catch { /* storage unavailable */ }
  }

  dispose(): void { this.field.removeEventListener('input', this.input); this.unsubscribe() }

  /** Freeze the shown checkpoint while images upload and the claim is made. */
  begin(): VoiceCompose {
    if (this.span?.boundaryUncertain) throw boundaryError()
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
    if (!this.span || this.frozen || this.span.boundaryUncertain) return
    const text = after.slice(this.span.start, this.span.end)
    if (text === previousHeld) return
    void this.voice.editHeld(this.span, text).catch(error => {
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
      if (this.span.boundaryUncertain) return
      if (this.span.uncertain) {
        this.span = null
        this.save()
      } else this.remove()
    }
    if (!held) return
    const after = held.after ?? 0
    if (this.span && (after < this.span.after || held.through < this.span.through)) return
    if (!this.span) {
      const join = this.field.value ? '\n\n' : ''
      const start = this.field.value.length + join.length
      this.replace(this.field.value.length, this.field.value.length, join + held.text)
      this.span = { id: held.id, after, through: held.through, start, end: start + held.text.length, join }
    } else if (after > this.span.after) {
      // Consumption restores a speaker label on the surviving prefix.
      // Replace only the owned range, leaving typed text on either side.
      const start = this.span.start
      this.replace(start, this.span.end, held.text)
      this.span.end = start + held.text.length
      this.span.through = held.through
      this.span.after = after
      this.span.boundaryUncertain = false
    } else if (held.through > this.span.through) {
      // Edits coalesce only through their displayed checkpoint. Exact later
      // segments therefore extend local edits even when an edit ACK is lost.
      if (!held.segments.some(segment => segment.through === this.span!.through)) {
        if (!this.span.boundaryUncertain) this.failed(boundaryError())
        this.span.boundaryUncertain = true
      } else {
        const suffix = held.segments.filter(segment => segment.through > this.span!.through).map(segment => segment.text).join('')
        const end = this.span.end
        this.replace(end, end, suffix)
        this.span.end = end + suffix.length
        this.span.through = held.through
        this.span.boundaryUncertain = false
      }
    }
    // An unchanged checkpoint never overwrites a local edit.
    this.save()
  }

  private remove(): void {
    if (!this.span) return
    const { start, end, join } = this.span
    const from = join && this.field.value.slice(start - join.length, start) === join ? start - join.length : start
    this.span = null
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
