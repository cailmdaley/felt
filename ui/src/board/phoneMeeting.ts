import { Mic, ScreenLock, audioContextForGesture } from '../phone/mic'
import { RelayLink } from '../phone/relay'
import { AudioSession } from '../phone/session'
import { relayUrl } from '../phone/phoneState'
import { parseMeetingRecord, type MeetingRecord } from './meeting'

/** Capture opens audio in its submit gesture; the board keeps it after the sheet closes. */
export interface PhoneCaptureAttempt {
  ready: Promise<number>
  bind(generation: number, meeting: unknown): void
  cancel(): void
}

export interface PhoneCaptureHooks {
  begin(): PhoneCaptureAttempt
}

export class PhoneMeeting implements PhoneCaptureHooks {
  readonly session: AudioSession
  readonly lock: ScreenLock
  peak = 0
  private launch: string | null = null
  private attempt = 0
  private checkTimer: number | null = null
  private readonly changed: () => void
  private readonly visibilityChanged = (): void => {
    if (document.visibilityState === 'visible') this.session.returned()
    else this.session.backgrounded()
  }
  private readonly pagehide = (event: PageTransitionEvent): void => {
    this.session.backgrounded()
    if (!event.persisted) this.cancel()
  }

  constructor(shuttleBase: string, changed: () => void, level: () => void) {
    this.changed = changed
    this.lock = new ScreenLock()
    this.session = new AudioSession({
      openMic: (handlers) => {
        const context = audioContextForGesture()
        return Mic.open(context, handlers).catch((error: unknown) => {
          void context.close().catch(() => {})
          throw error
        })
      },
      // The scribe's project origin does not own this meeting's audio.
      createRelay: (launch, events) => new RelayLink({
        url: relayUrl(shuttleBase, window.location, launch), ...events,
      }),
      lock: this.lock,
      onChange: changed,
      onLevel: (peak) => { this.peak = peak; level() },
    })
  }

  begin(): PhoneCaptureAttempt {
    // A sheet must not take ownership of audio another gesture already owns.
    if (this.session.busy) throw new Error('The microphone is already opening or in use.')
    const attempt = ++this.attempt
    const opening = this.session.begin()
    return {
      ready: opening.then((generation) => {
        if (generation === null) throw new Error(this.session.error ?? 'The microphone opening was cancelled.')
        return generation
      }),
      bind: (generation, meeting) => {
        if (attempt !== this.attempt) throw new Error('The microphone opening was cancelled.')
        this.bind(generation, meeting)
      },
      cancel: () => { if (attempt === this.attempt) this.cancel() },
    }
  }

  bind(generation: number, value: unknown): void {
    const meeting = parseMeetingRecord(value)
    if (!meeting?.phone || !meeting.launch?.trim() || meeting.state === 'failed' || meeting.state === 'stopping') {
      this.cancel()
      throw new Error('Recording started, but the daemon did not return a phone meeting launch. The mic is off; reconnect when the meeting is available.')
    }
    this.launch = meeting.launch
    this.session.stream(generation, meeting.launch)
  }

  async connect(meeting: MeetingRecord): Promise<void> {
    // Refuse before asking for audio when there is no identity to bind it to.
    if (!meeting.launch?.trim()) {
      this.session.error = 'The meeting has no launch id. The mic is off.'
      this.changed()
      return
    }
    try {
      const opening = this.begin()
      opening.bind(await opening.ready, meeting)
    } catch (error) {
      this.session.error ??= (error as Error).message
    } finally { this.changed() }
  }

  cancel(): void {
    this.attempt += 1
    this.launch = null
    this.peak = 0
    this.session.stop()
  }

  observe(meeting: MeetingRecord | null): void {
    if (this.launch && (!meeting || meeting.launch !== this.launch || meeting.state === 'failed' || meeting.state === 'stopping')) this.cancel()
  }

  mount(): void {
    document.addEventListener('visibilitychange', this.visibilityChanged)
    window.addEventListener('pagehide', this.pagehide)
    window.addEventListener('pageshow', this.visibilityChanged)
    this.checkTimer = window.setInterval(() => this.session.check(), 1_000)
  }

  unmount(): void {
    document.removeEventListener('visibilitychange', this.visibilityChanged)
    window.removeEventListener('pagehide', this.pagehide)
    window.removeEventListener('pageshow', this.visibilityChanged)
    if (this.checkTimer !== null) window.clearInterval(this.checkTimer)
    this.checkTimer = null
    this.cancel()
  }
}
