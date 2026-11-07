import type { KanbanCard } from '../KanbanTypes.js'
import type { MeetingMode } from '../../forms/meetingApi.js'
import { meetingActions, meetingHostCard, type MeetingRecord } from '../meeting.js'
import { isMobileViewport } from '../mobile.js'
import { openVoiceTranscript } from '../voiceTranscript.js'
import { anchorPopover, type Release } from './anchoredPopover.js'

/** Which session takes a joined meeting, and whether it records system audio. */
export interface MeetingJoinOptions {
  session: 'fresh' | 'previous'
  systemAudio?: boolean
}

/** The board's meeting control, lent to the band. */
export interface MeetingJoinControl {
  /** The selected recorder is available and nothing is recording. */
  canJoin(): boolean
  modes(): MeetingMode[]
  recorder?(): string | null
  /** Record a meeting and join it to the card's constitution. Called inside the
   *  press's gesture, so Phone can open audio. Resolves to the error to show,
   *  null once recording began. */
  join(card: KanbanCard, mode: MeetingMode, options: MeetingJoinOptions): Promise<string | null>
  /** The meeting the board last observed, if any. */
  current(): MeetingRecord | null
  /** Stop (or dismiss, once failed) the recording: the board's one stop path. */
  stop?(meeting: MeetingRecord): void | boolean | Promise<void | boolean>
  pause?(meeting: MeetingRecord, paused: boolean): Promise<void>
  /** Whether a stop for `meeting` has been asked and not yet observed. */
  stopRequested?(meeting: MeetingRecord): boolean
}

export interface ListenOptions {
  card: KanbanCard
  meeting: MeetingJoinControl
  voice?: import('../voice.js').Voice
  shuttleBase: string
  openFile(path: string, title?: string, owner?: string): void
  hostName(meeting: MeetingRecord): string | undefined
  openHost(meeting: MeetingRecord): void
  /** Show the hosted meeting's transcript pane under the band. */
  showPane(): void
  onError(message: string | null): void
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

const ICONS = {
  mic: 'M8 1.5a2 2 0 0 0-2 2v4.25a2 2 0 0 0 4 0V3.5a2 2 0 0 0-2-2ZM3.5 7.75a4.5 4.5 0 0 0 9 0M8 12.25v2.25M5.5 14.5h5',
  meeting: 'M8 3.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9ZM8 6.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3Z',
  pause: 'M5.5 3.5v9M10.5 3.5v9',
  resume: 'M5 3.25v9.5L12.5 8Z',
  stop: 'M4 4h8v8H4Z',
}

function svg(d: string): SVGSVGElement {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  icon.setAttribute('viewBox', '0 0 16 16')
  icon.setAttribute('aria-hidden', 'true')
  icon.setAttribute('focusable', 'false')
  const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  glyph.setAttribute('d', d)
  glyph.setAttribute('fill', 'none')
  glyph.setAttribute('stroke', 'currentColor')
  glyph.setAttribute('stroke-width', '1.35')
  glyph.setAttribute('stroke-linecap', 'round')
  glyph.setAttribute('stroke-linejoin', 'round')
  icon.append(glyph)
  return icon
}

function plainButton(className: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `kbn-ctl-btn ${className}`
  return button
}

/** What the mic is doing, as the control draws it. */
type Mode =
  | { kind: 'off' }
  | { kind: 'following'; paused: boolean; name: string }
  | { kind: 'meeting'; paused: boolean; name: string; meeting: MeetingRecord }

/**
 * The band's Listening control. The mic does one thing at a time: off,
 * following the card in view, or recording a meeting joined to one card.
 * Listen turns following on; once anything is on, the control draws the
 * mode's icon (a mic, or a red dot for a meeting) and offers Pause and Stop,
 * and the band's voice strip beside it names where words go. Stop always turns the mic off. The ▾
 * menu holds what is rarer: recording a meeting here, the transcript, and the
 * quiet before a batch is sent.
 */
export class ListenControl {
  readonly el = document.createElement('span')
  private readonly button = plainButton('kbn-ctl-meet-arm')
  private readonly word = document.createElement('span')
  private readonly pauseButton = plainButton('kbn-ctl-meet-pause')
  private readonly stopButton = plainButton('kbn-ctl-meet-stop')
  private readonly dropdown = plainButton('kbn-ctl-meet-dropdown')
  private readonly audio = document.createElement('select')
  private readonly opts: ListenOptions
  private readonly unsubscribe?: () => void
  private starting = false
  private menu: HTMLElement | null = null
  private menuState = ''
  private release: Release | null = null
  private localError: string | null = null
  private paintedIcon = ICONS.mic

  constructor(opts: ListenOptions) {
    this.opts = opts
    this.el.className = 'kbn-ctl-meet'
    this.word.className = 'kbn-ctl-meet-label'
    this.button.append(svg(ICONS.mic), this.word)
    this.stopButton.append(svg(ICONS.stop))
    this.stopButton.setAttribute('aria-label', 'Stop listening')
    this.stopButton.title = 'Stop: the mic goes off'
    this.audio.className = 'kbn-ctl-select kbn-ctl-meet-audio'
    this.audio.setAttribute('aria-label', 'Meeting audio')
    this.audio.append(new Option('Mic + system', 'system'), new Option('Mic only', 'mic'))
    this.dropdown.textContent = '▾'
    this.dropdown.setAttribute('aria-label', 'Listening options')
    this.dropdown.setAttribute('aria-haspopup', 'menu')
    this.dropdown.setAttribute('aria-expanded', 'false')
    this.dropdown.addEventListener('click', () => this.showMenu())
    this.button.addEventListener('click', () => {
      if (this.mode().kind === 'off') this.listen()
      else this.showMenu()
    })
    this.pauseButton.addEventListener('click', () => this.pause())
    this.stopButton.addEventListener('click', () => this.stop())
    this.unsubscribe = opts.voice?.subscribe(() => this.paint())
    this.el.append(this.button, this.pauseButton, this.stopButton, this.dropdown)
    this.paint()
  }

  /** A phone is its own mic, so listening there records on the phone. */
  private get phone(): boolean { return isMobileViewport() }

  dispose(): void {
    this.closeMenu()
    this.unsubscribe?.()
  }

  dismiss(): boolean {
    if (!this.menu) return false
    this.closeMenu()
    this.dropdown.focus()
    return true
  }

  /** A recording started, ended or changed. */
  meetingChanged(): void { this.paint() }

  private fail(error: unknown): void {
    this.localError = message(error)
    this.paint()
  }

  /** A definite failure to show beside the mode; it never hides what holds the mic. */
  private failure(): string | null {
    const current = this.opts.meeting.current()
    const voice = this.opts.voice?.status
    return this.localError
      ?? (current?.state === 'failed' ? current.error ?? 'The recording failed' : null)
      ?? (current?.handoff?.status === 'reported-failure' ? 'Delivery failed' : null)
      ?? (!current && voice?.enabled && voice.state === 'failed' ? voice.error ?? 'Listening failed' : null)
      ?? (!current && voice?.enabled && voice.last?.status === 'failed' ? `Delivery failed${voice.last.detail ? `: ${voice.last.detail}` : ''}` : null)
  }

  private mode(): Mode {
    const { card, meeting } = this.opts
    const current = meeting.current()
    const voice = this.opts.voice?.status
    if (current && current.state !== 'failed') {
      const hosted = meetingHostCard(current, [card]) !== null
      const name = hosted ? card.name : this.opts.hostName(current) ?? current.fiber?.split('/').at(-1) ?? current.title?.trim() ?? 'a card'
      return { kind: 'meeting', paused: !!current.paused, name, meeting: current }
    }
    if (voice?.enabled) return { kind: 'following', paused: voice.muted, name: voice.target?.name ?? 'nothing yet' }
    return { kind: 'off' }
  }

  /** Listen: follow what is in view, or on a phone, record on the phone joined to this card. */
  private listen(): void {
    this.localError = null
    if (this.phone) { this.record('phone'); return }
    void this.opts.voice?.set({ enabled: true, muted: false })
      .then(() => this.paint())
      .catch((error: unknown) => this.fail(error))
  }

  /** Record a meeting joined to this card. Following turns off: one mode at a time. */
  private record(mode: MeetingMode): void {
    const { card, meeting, voice } = this.opts
    if (this.starting || !meeting.canJoin() || !meeting.modes().includes(mode)) return
    this.starting = true
    this.localError = null
    this.opts.onError(null)
    this.paint()
    const following = !!voice?.status?.enabled
    let joined: Promise<string | null>
    try {
      joined = meeting.join(card, mode, {
        session: card.sessionUuid ? 'previous' : 'fresh',
        systemAudio: mode === 'call' && this.audio.value === 'system',
      })
    } catch (error) { joined = Promise.reject(error instanceof Error ? error : new Error(String(error))) }
    void joined
      .then(async error => {
        this.opts.onError(error)
        if (!error && following) await voice?.set({ enabled: false })
      })
      .catch((error: unknown) => this.opts.onError(message(error)))
      .finally(() => { this.starting = false; this.paint() })
  }

  private pause(): void {
    const mode = this.mode()
    const done = (task: Promise<void> | undefined): void => {
      void task?.then(() => { this.localError = null; this.paint() }).catch((error: unknown) => this.fail(error))
    }
    if (mode.kind === 'meeting') done(this.opts.meeting.pause?.(mode.meeting, !mode.paused))
    else if (mode.kind === 'following') done(this.opts.voice?.set({ muted: !mode.paused }))
  }

  /** Stop: whatever holds the mic stops, and nothing takes over. Following turns off first, whatever the meeting's stop says. */
  private stop(): void {
    const { meeting, voice } = this.opts
    const current = meeting.current()
    this.localError = null
    const following = voice?.status?.enabled ? voice.set({ enabled: false }) : Promise.resolve()
    const recording = current && meeting.stop
      ? Promise.resolve(meeting.stop(current)).then(stopped => { if (stopped === false) throw new Error('The recording did not stop') })
      : Promise.resolve()
    void Promise.all([following, recording]).catch((error: unknown) => { this.localError = message(error) }).finally(() => this.paint())
  }

  private closeMenu(): void {
    this.release?.(); this.release = null
    this.menu?.remove(); this.menu = null
    this.dropdown.setAttribute('aria-expanded', 'false')
    window.removeEventListener('pointerdown', this.outside, true)
  }

  private readonly outside = (event: PointerEvent): void => {
    if (!this.menu?.contains(event.target as Node) && !this.el.contains(event.target as Node)) this.closeMenu()
  }

  private signature(): string {
    const current = this.opts.meeting.current()
    const voice = this.opts.voice?.status
    return JSON.stringify([current?.launch, current?.state, current?.paused, current?.recorder, voice?.available, voice?.enabled, voice?.muted, voice?.recorder, this.localError])
  }

  private paint(): void {
    const mode = this.mode()
    const failure = this.failure()
    const voice = this.opts.voice?.status
    const on = mode.kind === 'following' || mode.kind === 'meeting'
    if (this.menu && this.signature() !== this.menuState) this.closeMenu()

    const icon = mode.kind === 'meeting' ? ICONS.meeting : ICONS.mic
    if (icon !== this.paintedIcon) { this.button.firstElementChild?.replaceWith(svg(icon)); this.paintedIcon = icon }
    let label: string
    let title: string
    switch (mode.kind) {
      case 'off':
        label = failure ? 'Failed' : 'Listen'
        title = failure ?? (this.phone ? 'Listen: record on this phone, joined to this card' : 'Listen: your words go to whatever card you are looking at')
        break
      case 'following':
        label = `${mode.paused ? 'Paused' : 'Following'} · ${mode.name}`
        title = `${mode.paused ? 'Paused. ' : ''}Following you: words go to ${mode.name}, the card you are looking at`
        break
      case 'meeting':
        label = `${mode.paused ? 'Paused' : 'Meeting'} · ${mode.name}`
        title = `${mode.paused ? 'Paused. ' : ''}Recording a meeting: every word goes to ${mode.name}, wherever you look`
        break
    }
    if (on && failure) title = `${failure}. ${title}`
    this.button.disabled = mode.kind === 'off' && (this.starting || (this.phone
      ? !this.opts.meeting.canJoin() || !this.opts.meeting.modes().includes('phone')
      : !voice?.available))
    if (this.button.disabled && !this.phone && !this.starting && !failure) title = voice?.error ? `Listening is unavailable: ${voice.error}` : 'Listening is unavailable on this host'
    // While on, the band's voice strip names where words go; the control keeps only its icon.
    const shown = on ? '' : label
    if (this.word.textContent !== shown) this.word.textContent = shown
    this.word.hidden = on
    this.button.title = title
    this.button.setAttribute('aria-label', label)
    this.el.dataset.mode = mode.kind
    this.el.classList.toggle('kbn-ctl-meet-failed', !!failure)
    this.el.classList.toggle('kbn-ctl-meet-paused', on && mode.paused)
    this.button.classList.toggle('kbn-ctl-meet-on', on)

    const pausable = mode.kind === 'following' || (mode.kind === 'meeting' && !mode.meeting.phone && !!this.opts.meeting.pause)
    this.pauseButton.hidden = !pausable
    if (pausable) {
      const want = mode.paused ? ICONS.resume : ICONS.pause
      if (this.pauseButton.dataset.icon !== want) { this.pauseButton.replaceChildren(svg(want)); this.pauseButton.dataset.icon = want }
      this.pauseButton.setAttribute('aria-label', mode.paused ? 'Resume listening' : 'Pause listening')
      this.pauseButton.title = mode.paused ? 'Resume' : 'Pause: words go nowhere until you resume'
      this.pauseButton.disabled = mode.kind === 'meeting' && mode.meeting.state !== 'live'
    }
    this.stopButton.hidden = !on && !this.opts.meeting.current()
    this.stopButton.disabled = mode.kind === 'meeting'
      && (!this.opts.meeting.stop || meetingActions(mode.meeting, this.opts.meeting.stopRequested?.(mode.meeting) ?? false).stopDisabled)
  }

  private item(label: string, act: () => void, disabled = false): void {
    const button = plainButton('ws-select-option')
    button.textContent = label
    button.setAttribute('role', 'menuitem')
    button.disabled = disabled
    button.addEventListener('click', () => { this.closeMenu(); act() })
    this.menu!.append(button)
  }

  private showMenu(): void {
    if (this.menu) { this.closeMenu(); return }
    const { card, meeting } = this.opts
    const state = this.opts.voice?.status
    const menu = this.menu = document.createElement('div')
    menu.className = 'ws-select-picker'
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', 'Listening options')
    this.menuState = this.signature()

    const current = meeting.current()
    if (current) {
      const hosted = meetingHostCard(current, [card]) !== null
      this.item('Open transcript', () => { if (hosted) this.opts.showPane(); else this.opts.openHost(current) })
    } else if (state?.enabled) {
      this.item('Open transcript', () => {
        void openVoiceTranscript(this.opts.shuttleBase, this.opts.openFile, state.recorder)
          .then(() => { this.localError = null; this.paint() })
          .catch((error: unknown) => this.fail(error))
      })
    }
    if (!current && !this.phone && meeting.modes().includes('call')) {
      this.item(`Record a meeting on ${card.name}`, () => this.record('call'), this.starting || !meeting.canJoin())
      const label = document.createElement('label')
      label.className = 'kbn-ctl-meet-audio-label'
      label.append('Audio', this.audio)
      menu.append(label)
    }
    const cadence = this.cadence(current ? current.recorder : state?.recorder)
    menu.append(cadence.el)
    const failure = this.failure()
    if (failure) {
      const note = document.createElement('div')
      note.className = 'voice-error'
      note.textContent = failure
      menu.append(note)
    }

    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.dismiss() }
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && event.target !== this.audio && !cadence.fields.includes(event.target as HTMLInputElement)) {
        event.preventDefault()
        const items = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        const at = items.indexOf(document.activeElement as HTMLButtonElement)
        items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
      }
    })
    menu.addEventListener('focusout', event => {
      if (event.relatedTarget && !this.el.contains(event.relatedTarget as Node)) this.closeMenu()
    })
    this.el.append(menu)
    this.release = anchorPopover(menu, this.el, { placement: 'below-start' })
    this.dropdown.setAttribute('aria-expanded', 'true')
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    window.addEventListener('pointerdown', this.outside, true)
  }

  /** The quiet before a batch is sent, read from and written to the recorder's voice file. */
  private cadence(recorder: string | null | undefined): { el: HTMLElement; fields: HTMLInputElement[] } {
    const el = document.createElement('div')
    el.className = 'kbn-ctl-listen-cadence'
    const wrapper = document.createElement('label')
    wrapper.textContent = 'Quiet seconds'
    const quiet = document.createElement('input')
    quiet.type = 'number'; quiet.min = '0.001'; quiet.step = 'any'; quiet.disabled = true
    quiet.setAttribute('aria-label', 'Quiet seconds')
    wrapper.append(quiet); el.append(wrapper)
    const origin = recorder ?? ''
    const base = `${this.opts.shuttleBase}/api/v1/config/voice`
    void fetch(`${base}${origin ? `?origin=${encodeURIComponent(origin)}` : ''}`).then(async response => {
      if (!response.ok) throw new Error('Could not read listening settings')
      const file = await response.json() as { text: string; digest: string | null }
      const doc = file.text.trim() ? JSON.parse(file.text) as Record<string, unknown> : {}
      const nested = (key: string) => (doc[key] as { quiet_seconds?: number } | undefined)?.quiet_seconds
      quiet.value = String(doc.quiet_seconds ?? nested('voice') ?? nested('meeting') ?? 15)
      quiet.disabled = false
      quiet.addEventListener('change', () => {
        const value = Number(quiet.value)
        if (!quiet.validity.valid || !Number.isFinite(value) || value <= 0) return
        quiet.disabled = true
        const { run_quiet_seconds: _, ...kept } = doc
        void fetch(base, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: JSON.stringify({ ...kept, quiet_seconds: value }, null, 2) + '\n', origin, expected_digest: file.digest }),
        }).then(async saved => {
          if (!saved.ok) throw new Error('Could not save listening settings')
          file.digest = (await saved.json() as { digest: string | null }).digest
          delete doc.run_quiet_seconds
          doc.quiet_seconds = value
          this.localError = null
        }).catch((error: unknown) => this.fail(error))
          .finally(() => { quiet.disabled = false })
      })
    }).catch((error: unknown) => this.fail(error))
    return { el, fields: [quiet] }
  }
}
