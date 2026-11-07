import { clockSeconds } from './civilDay.js'
import type { FiberSlug } from './workspace/voiceStrip.js'
import './voiceTranscript.css'

export interface VoiceTranscriptRow {
  t: string
  speaker: string
  text: string
  fiber_id: string | null
  origin: string | null
  name: string | null
  slug?: string | null
  launch: string
}
export interface VoiceTranscript {
  date: string
  rows: VoiceTranscriptRow[]
  recorder: string
}

/** Read the recorder's day, including words that never reached a worker. */
export async function readVoiceTranscript(base: string, recorder?: string, fiber?: string): Promise<VoiceTranscript> {
  const query = new URLSearchParams()
  if (recorder) query.set('recorder', recorder)
  if (fiber) query.set('fiber', fiber)
  const response = await fetch(`${base}/api/v1/voice/transcript${query.size ? `?${query}` : ''}`, { cache: 'no-store' })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error ?? `Could not open today's transcript (${response.status})`)
  return body as VoiceTranscript
}

export function transcriptLine(row: VoiceTranscriptRow, slugOf: FiberSlug): string {
  const time = clockSeconds(Date.parse(row.t))
  const slug = row.fiber_id ? (row.slug ?? slugOf(row.fiber_id, row.origin) ?? row.fiber_id).split('/').at(-1) : '—'
  return `${time} ${row.speaker} → ${slug}: ${row.text}`
}

/** A small reader over the day transcript; filtering never changes Listen's target. */
export class TranscriptPanel {
  readonly el = document.createElement('dialog')
  private readonly lines = document.createElement('div')
  private readonly heading = document.createElement('h2')
  private revision = 0

  constructor(base: string, recorder: string | undefined, fiber: string, slugOf: FiberSlug, opener: HTMLElement) {
    this.el.className = 'voice-transcript'
    this.el.setAttribute('aria-label', "Today's transcript")
    this.heading.textContent = "Today's transcript"
    const close = document.createElement('button')
    close.type = 'button'; close.className = 'ws-header-icon'
    close.textContent = '×'; close.title = 'Close transcript (Esc)'; close.setAttribute('aria-label', 'Close transcript')
    close.onclick = () => this.dispose()
    const head = document.createElement('header'); head.append(this.heading, close)
    const label = document.createElement('label')
    const filter = document.createElement('input'); filter.type = 'checkbox'
    label.append(filter, 'This card only')
    this.lines.setAttribute('role', 'log')
    const load = async (): Promise<void> => {
      const revision = ++this.revision
      this.lines.textContent = 'Reading…'
      try {
        const transcript = await readVoiceTranscript(base, recorder, filter.checked ? fiber : undefined)
        if (revision !== this.revision) return
        this.heading.textContent = `Today's transcript · ${transcript.date}`
        const rows = transcript.rows.map(row => {
          const line = document.createElement('p'); line.textContent = transcriptLine(row, slugOf); return line
        })
        this.lines.replaceChildren(...rows)
        if (!rows.length) this.lines.textContent = 'No speech recorded.'
      } catch (error) {
        if (revision === this.revision) this.lines.textContent = (error as Error).message
      }
    }
    filter.onchange = () => { void load() }
    this.el.append(head, label, this.lines)
    this.el.addEventListener('cancel', event => { event.preventDefault(); this.dispose() })
    this.el.addEventListener('click', event => { if (event.target === this.el) this.dispose() })
    this.el.addEventListener('keydown', event => event.stopPropagation())
    this.el.addEventListener('close', () => { this.el.remove(); if (opener.isConnected) opener.focus() })
    // Keep the workspace's theme variables without adding a new document kind.
    ;(opener.closest('.ws-reader') ?? document.body).append(this.el)
    this.el.showModal()
    void load()
  }

  dispose(): void { this.revision++; this.el.close(); this.el.remove() }
}
