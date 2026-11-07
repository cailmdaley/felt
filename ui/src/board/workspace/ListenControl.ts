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

function option(label: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'kbn-ctl-btn ws-select-option'
  button.textContent = label
  return button
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * The band's Hark control. Listen starts a recording joined to this
 * constitution, on the session it already has; its menu manages the current
 * recording, live voice and the listening cadence.
 */
export class ListenControl {
  readonly el = document.createElement('span')
  private readonly button = document.createElement('button')
  private readonly word = document.createElement('span')
  private readonly dropdown = document.createElement('button')
  private readonly audio = document.createElement('select')
  private readonly opts: ListenOptions
  private readonly unsubscribe?: () => void
  private starting = false
  private menu: HTMLElement | null = null
  private menuState = ''
  private release: Release | null = null
  private localError: string | null = null
  private voiceAvailable: boolean
  /** A move to this constitution waits for the recording it stopped to end. */
  private pendingHere: string | null | undefined = undefined

  constructor(opts: ListenOptions) {
    this.opts = opts
    this.el.className = 'kbn-ctl-meet'
    this.button.type = 'button'
    this.button.className = 'kbn-ctl-btn kbn-ctl-meet-arm'
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    icon.setAttribute('viewBox', '0 0 16 16')
    icon.setAttribute('aria-hidden', 'true')
    icon.setAttribute('focusable', 'false')
    const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    glyph.setAttribute('d', 'M8 1.5a2 2 0 0 0-2 2v4.25a2 2 0 0 0 4 0V3.5a2 2 0 0 0-2-2ZM3.5 7.75a4.5 4.5 0 0 0 9 0M8 12.25v2.25M5.5 14.5h5')
    glyph.setAttribute('fill', 'none')
    glyph.setAttribute('stroke', 'currentColor')
    glyph.setAttribute('stroke-width', '1.35')
    glyph.setAttribute('stroke-linecap', 'round')
    icon.append(glyph)
    this.word.className = 'kbn-ctl-meet-label'
    this.word.textContent = 'Listen'
    this.button.append(icon, this.word)
    this.audio.className = 'kbn-ctl-select kbn-ctl-meet-audio'
    this.audio.setAttribute('aria-label', 'Listening audio')
    this.audio.append(new Option('Mic + system', 'system'), new Option('Mic only', 'mic'))
    this.dropdown.type = 'button'
    this.dropdown.className = 'kbn-ctl-btn kbn-ctl-meet-dropdown'
    this.dropdown.textContent = '▾'
    this.dropdown.setAttribute('aria-label', 'Listening controls')
    this.dropdown.setAttribute('aria-haspopup', 'menu')
    this.dropdown.setAttribute('aria-expanded', 'false')
    this.dropdown.addEventListener('click', () => this.showMenu())
    this.button.addEventListener('click', () => {
      const current = opts.meeting.current()
      if ((current && current.state !== 'failed') || opts.voice?.status?.enabled) this.showMenu()
      else this.start()
    })
    this.voiceAvailable = !!opts.voice?.status?.available
    this.unsubscribe = opts.voice?.subscribe(() => this.paint())
    this.el.append(this.button, this.dropdown)
    this.paint()
  }

  private get requiredMode(): MeetingMode { return isMobileViewport() ? 'phone' : 'call' }
  private get canJoin(): boolean { return this.opts.meeting.canJoin() && this.opts.meeting.modes().includes(this.requiredMode) }

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

  /** A recording ended or changed: close a stale menu, and take a move that was waiting for it. */
  meetingChanged(): void {
    const current = this.opts.meeting.current()
    if (this.pendingHere !== undefined && current && current.launch !== this.pendingHere) this.pendingHere = undefined
    if (this.pendingHere !== undefined && !current && this.canJoin) {
      this.pendingHere = undefined
      this.start()
    }
    this.paint()
  }

  private fail(error: unknown): void {
    this.localError = message(error)
    this.paint()
  }

  private start(): void {
    const { card, meeting, voice } = this.opts
    if (this.starting || !this.canJoin) return
    this.starting = true
    this.opts.onError(null)
    this.paint()
    let joined: Promise<string | null>
    try {
      joined = meeting.join(card, this.requiredMode, {
        session: card.sessionUuid ? 'previous' : 'fresh',
        systemAudio: !voice?.status?.enabled && this.audio.value === 'system',
      })
    } catch (error) { joined = Promise.reject(error instanceof Error ? error : new Error(String(error))) }
    void joined.then(error => this.opts.onError(error)).catch((error: unknown) => this.opts.onError(message(error))).finally(() => {
      this.starting = false
      this.paint()
    })
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
    return JSON.stringify([current?.launch, current?.state, current?.paused, current?.recorder, current?.handoff?.status, voice?.available, voice?.enabled, voice?.muted, voice?.state, voice?.target, voice?.recorder, voice?.held?.length, this.localError])
  }

  private paint(): void {
    const { card, meeting } = this.opts
    const current = meeting.current()
    const recording = current !== null && current.state !== 'failed'
    const voice = this.opts.voice?.status
    this.button.disabled = !recording && !voice?.enabled && (this.starting || !this.canJoin)
    this.audio.disabled = this.starting || recording
    if (this.voiceAvailable && !voice?.available) this.closeMenu()
    this.voiceAvailable = !!voice?.available
    if (this.menu && this.signature() !== this.menuState) this.closeMenu()
    let label = 'Listen'
    let elsewhere: string | null = null
    if (this.localError || current?.state === 'failed' || current?.handoff?.status === 'reported-failure' || voice?.state === 'failed' || voice?.last?.status === 'failed') {
      label = 'Failed'
    } else if (recording) {
      const hosted = meetingHostCard(current, [card]) !== null
      const host = this.opts.hostName(current) ?? (hosted ? card.name : current.fiber?.split('/').at(-1)) ?? current.title?.trim() ?? 'card'
      label = current.paused ? 'Paused' : 'Listening'
      if (!hosted) label += ` · ${host}`
      if (!hosted && current.state !== 'stopping') elsewhere = current.paused ? `The mic is paused for ${host}.` : `Your voice is going to ${host}.`
    } else if (voice?.available && voice.enabled) {
      label = voice.muted ? 'Paused' : 'Listening'
      if (voice.target?.fiber_id !== (card.uid ?? card.id)) label += ` · ${voice.target?.name ?? 'Rex'}`
      if (voice.state === 'yielded') elsewhere = 'Your voice is going to a recording.'
    }
    if (this.word.textContent !== label) this.word.textContent = label
    const whole = /^(Listening|Paused)$/.test(label) ? `${label} · ${card.name}` : label
    this.button.title = elsewhere ?? whole
    this.button.setAttribute('aria-label', whole)
    this.button.classList.toggle('kbn-ctl-meet-on', recording || !!voice?.enabled)
  }

  private item(label: string, act: () => void, disabled = false): void {
    const button = option(label)
    button.setAttribute('role', 'menuitem')
    button.disabled = disabled
    button.addEventListener('click', () => { this.closeMenu(); act() })
    this.menu!.append(button)
  }

  private note(text: string): void {
    const el = document.createElement('div')
    el.className = 'voice-error'
    el.textContent = text
    this.menu!.append(el)
  }

  private showMenu(): void {
    if (this.menu) { this.closeMenu(); return }
    const { card, meeting } = this.opts
    const voice = this.opts.voice
    const menu = this.menu = document.createElement('div')
    menu.className = 'ws-select-picker'
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', 'Listening controls')
    const current = meeting.current()
    const recording = !!current && current.state !== 'failed'
    const state = voice?.status
    this.menuState = this.signature()
    const set = (values: { muted?: boolean; enabled?: boolean }): void => {
      void voice?.set(values).then(() => { this.localError = null; this.paint() }).catch((error: unknown) => this.fail(error))
    }
    const stopHeld = !recording || !meeting.stop || meetingActions(current, meeting.stopRequested?.(current) ?? false).stopDisabled
    if (recording) {
      if (state?.available && !isMobileViewport()) this.item('Stop and follow me', () => {
        void Promise.resolve(meeting.stop?.(current)).then(async stopped => {
          if (stopped === false) throw new Error('The recording did not stop')
          await voice?.set(state.muted ? { enabled: true, muted: false } : { enabled: true })
          this.localError = null
        }).catch((error: unknown) => { this.localError = message(error) }).finally(() => this.paint())
      }, stopHeld)
    } else {
      const follow = option('Follow me')
      follow.setAttribute('role', 'menuitemcheckbox')
      follow.setAttribute('aria-checked', String(!!state?.enabled))
      follow.disabled = !state?.enabled && (!state?.available || isMobileViewport())
      follow.addEventListener('click', () => { this.closeMenu(); set({ enabled: !state?.enabled }) })
      menu.append(follow)
    }
    if (!state?.enabled && !recording && this.requiredMode === 'call') {
      const label = document.createElement('label')
      label.className = 'kbn-ctl-meet-audio-label'
      label.append('Audio', this.audio)
      menu.append(label)
    }
    if (recording) {
      const hosted = meetingHostCard(current, [card]) !== null
      this.item('Open transcript', () => { if (hosted) this.opts.showPane(); else this.opts.openHost(current) })
      if (!current.phone) this.item(current.paused ? 'Resume' : 'Pause', () => {
        void meeting.pause?.(current, !current.paused).then(() => { this.localError = null; this.paint() }).catch((error: unknown) => this.fail(error))
      }, !meeting.pause || current.state !== 'live')
      this.item('Stop', () => { void meeting.stop?.(current) }, stopHeld)
      if (!hosted) this.item('Listen here', () => {
        this.pendingHere = current.launch
        void Promise.resolve(meeting.stop?.(current)).then(ok => {
          if (ok === false) this.pendingHere = undefined
          this.meetingChanged()
        }).catch(() => { this.pendingHere = undefined })
      }, stopHeld || !meeting.modes().includes(this.requiredMode))
    } else if (state?.available && state.enabled) {
      this.item('Open transcript', () => {
        void openVoiceTranscript(this.opts.shuttleBase, this.opts.openFile, state.recorder)
          .then(() => { this.localError = null; this.paint() })
          .catch((error: unknown) => this.fail(error))
      })
      this.item(state.muted ? 'Resume' : 'Pause', () => set({ muted: !state.muted }))
      this.item('Stop', () => set({ enabled: false }))
    }
    const cadence = this.cadence(recording ? current.recorder : state?.recorder)
    menu.append(cadence.el)
    const failure = this.localError || (current?.handoff?.status === 'reported-failure' ? 'Delivery failed' : null) || (current?.state === 'failed' ? current.error : null) || (state?.state === 'failed' ? state.error : null) || (state?.last?.status === 'failed' ? `Delivery failed${state.last.detail ? `: ${state.last.detail}` : ''}` : null)
    if (recording && state?.enabled) {
      this.item('Turn off Follow me', () => set({ enabled: false }))
      this.note('Follow me returns when this recording stops.')
    }
    for (const held of state?.held ?? []) this.note(`Held for ${held.fiber_id.split("/").at(-1)} until its worker is up and you speak to it: ${held.text}`)
    if (failure) this.note(failure)
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

  /** The two listening delays, read from and written to the recorder's voice file. */
  private cadence(recorder: string | null | undefined): { el: HTMLElement; fields: HTMLInputElement[] } {
    const el = document.createElement('div')
    el.className = 'kbn-ctl-listen-cadence'
    const input = (label: string): HTMLInputElement => {
      const wrapper = document.createElement('label')
      wrapper.textContent = label
      const field = document.createElement('input')
      field.type = 'number'; field.min = '0.001'; field.step = 'any'; field.disabled = true
      field.setAttribute('aria-label', label)
      wrapper.append(field); el.append(wrapper)
      return field
    }
    const quiet = input('Quiet seconds')
    const origin = recorder ?? ''
    const base = `${this.opts.shuttleBase}/api/v1/config/voice`
    void fetch(`${base}${origin ? `?origin=${encodeURIComponent(origin)}` : ''}`).then(async response => {
      if (!response.ok) throw new Error('Could not read listening settings')
      const file = await response.json() as { text: string; digest: string | null }
      const doc = file.text.trim() ? JSON.parse(file.text) as Record<string, unknown> : {}
      const oldVoice = doc.voice as { quiet_seconds?: number } | undefined
      const oldMeeting = doc.meeting as { quiet_seconds?: number } | undefined
      quiet.value = String(doc.quiet_seconds ?? oldVoice?.quiet_seconds ?? oldMeeting?.quiet_seconds ?? 15)
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
