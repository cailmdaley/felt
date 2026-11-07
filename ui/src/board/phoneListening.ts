import { Mic, ScreenLock, audioContextForGesture } from '../phone/mic'
import { RelayLink } from '../phone/relay'
import { AudioSession } from '../phone/session'
import { relayUrl } from '../phone/phoneState'
import type { VoiceStatus } from './voice'

export interface PhoneListeningAttempt {
  ready: Promise<number>
  bind(generation: number, voice: VoiceStatus): void
  cancel(): void
}

/** The board owns the phone mic across card and console changes. */
export class PhoneListening {
  readonly session: AudioSession
  private launch: string | null = null
  private recorder: string | null = null
  private attempt = 0
  private checkTimer: number | null = null
  private mounted = false
  private listeners = new Set<() => void>()
  private readonly changed = (): void => { this.listeners.forEach(fn => fn()) }
  private readonly visibilityChanged = (): void => {
    if (document.visibilityState === 'visible') this.session.returned()
    else this.session.backgrounded()
  }
  private readonly pagehide = (event: PageTransitionEvent): void => {
    this.session.backgrounded()
    if (!event.persisted) this.cancel()
  }

  constructor(shuttleBase: string) {
    this.session = new AudioSession({
      openMic: handlers => {
        const context = audioContextForGesture()
        return Mic.open(context, handlers).catch((error: unknown) => {
          void context.close().catch(() => {})
          throw error
        })
      },
      createRelay: (launch, events) => new RelayLink({
        url: relayUrl(shuttleBase, window.location, launch, this.recorder), ...events,
      }),
      lock: new ScreenLock(),
      onChange: this.changed,
      onLevel: () => {},
    })
  }

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn) }

  /** Reaches getUserMedia before returning, inside the Listen click. */
  begin(): PhoneListeningAttempt {
    if (this.session.busy) throw new Error('The microphone is already opening or in use.')
    const attempt = ++this.attempt
    const opening = this.session.begin()
    this.watch()
    return {
      ready: opening.then(generation => {
        if (generation === null) throw new Error(this.session.error ?? 'The microphone opening was cancelled.')
        return generation
      }),
      bind: (generation, voice) => {
        if (attempt !== this.attempt) throw new Error('The microphone opening was cancelled.')
        if (!voice.enabled || voice.source !== 'phone' || !voice.launch || !voice.recorder || voice.state === 'failed') {
          this.cancel()
          throw new Error('The recorder did not return a phone listening launch. The mic is off.')
        }
        this.launch = voice.launch
        this.recorder = voice.recorder
        this.session.stream(generation, voice.launch)
      },
      cancel: () => { if (attempt === this.attempt) this.cancel() },
    }
  }

  cancel(): void {
    this.attempt++
    this.launch = this.recorder = null
    this.session.stop()
  }

  observe(voice: VoiceStatus | null): void {
    // An unavailable status is not evidence that the launch ended.
    if (this.launch && voice && (!voice.enabled || voice.source !== 'phone' || voice.launch !== this.launch || voice.recorder !== this.recorder || voice.state === 'failed')) this.cancel()
  }

  mount(): void {
    document.addEventListener('visibilitychange', this.visibilityChanged)
    window.addEventListener('pagehide', this.pagehide)
    window.addEventListener('pageshow', this.visibilityChanged)
    this.mounted = true
    this.watch()
  }

  private watch(): void {
    if (!this.mounted || this.checkTimer !== null || !this.session.busy) return
    this.checkTimer = window.setTimeout(() => {
      this.checkTimer = null
      this.session.check()
      this.watch()
    }, 1_000)
  }

  unmount(): void {
    document.removeEventListener('visibilitychange', this.visibilityChanged)
    window.removeEventListener('pagehide', this.pagehide)
    window.removeEventListener('pageshow', this.visibilityChanged)
    this.mounted = false
    if (this.checkTimer !== null) window.clearTimeout(this.checkTimer)
    this.checkTimer = null
    this.cancel()
  }
}
