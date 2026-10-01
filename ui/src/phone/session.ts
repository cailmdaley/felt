/**
 * Who owns the phone's audio. One session holds at most one mic and one relay
 * socket, and every operation that awaits (opening the mic, restoring it)
 * carries the generation it started in: `stop()` (or a terminal relay state)
 * moves the generation on, so whatever finishes later is disposed of rather
 * than adopted, and callbacks from a superseded mic or relay change nothing.
 * The mic and relay come in through `SessionDeps`, so the suite can drive the
 * races with fakes.
 */

import type { MicHandlers } from './mic'
import { TERMINAL_LINKS, clockTime, type AudioHealth, type LinkState } from './phoneState'

export interface MicLike {
  health(): AudioHealth
  revive(): Promise<AudioHealth>
  close(): void
}

export interface RelayLike {
  open(): void
  send(chunk: ArrayBuffer): void
  nudge(): void
  close(): void
}

export interface RelayEvents {
  onLink: (link: LinkState, reason: string | null) => void
  onLoss: (since: number, until: number | null) => void
}

export interface LockLike {
  acquire(): Promise<void>
  reacquire(): Promise<void>
  release(): void
}

export interface SessionDeps {
  /** Open the mic; reaches getUserMedia inside the current tap. */
  openMic: (handlers: MicHandlers) => Promise<MicLike>
  createRelay: (launch: string | null, events: RelayEvents) => RelayLike
  lock: LockLike
  onChange: () => void
  onLevel: (peak: number) => void
  now?: () => number
}

/** Silence from the worklet longer than this is an interruption worth saying. */
export const AUDIO_GAP_MS = 3_000

export function micError(err: unknown): string {
  const name = (err as { name?: string })?.name
  if (name === 'NotAllowedError') {
    return 'Microphone permission was denied. Allow it for this site in Safari (aA → Website Settings → Microphone), then tap again.'
  }
  if (name === 'NotFoundError') return 'This device has no microphone the browser can use.'
  return `Couldn’t start the microphone: ${(err as Error)?.message ?? String(err)}`
}

const HEALTH_WORDS: Record<Exclude<AudioHealth, 'ok'>, string> = {
  ended: 'the mic stopped',
  muted: 'the system muted the mic',
  suspended: 'audio was suspended',
}

export class AudioSession {
  private generation = 0
  private readonly deps: SessionDeps
  private readonly now: () => number
  private lastChunkAt = 0
  private silentSince: number | null = null
  mic: MicLike | null = null
  relay: RelayLike | null = null
  acquiring = false
  link: LinkState = 'idle'
  linkReason: string | null = null
  /** Audio has not reached hark since then (after it had been listening). */
  lostSince: number | null = null
  /** The mic needs bringing back; the page offers Restore. */
  needsRestore = false
  warning: string | null = null
  error: string | null = null

  constructor(deps: SessionDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  /** The page holds a mic, or is opening one. */
  get busy(): boolean {
    return this.acquiring || this.mic !== null
  }

  /**
   * Open the mic. Answers the generation to stream it under, or null when a
   * mic is already open or opening, opening failed, or `stop()` came first
   * (a mic that arrives after that is closed at once).
   */
  async begin(): Promise<number | null> {
    if (this.busy) return null
    const generation = ++this.generation
    this.acquiring = true
    this.error = null
    this.warning = null
    this.link = 'idle'
    this.linkReason = null
    this.changed()
    const current = () => this.generation === generation
    let mic: MicLike
    try {
      mic = await this.deps.openMic({
        onChunk: (pcm) => {
          if (!current()) return
          this.heard()
          this.relay?.send(pcm)
        },
        onLevel: (peak) => { if (current()) this.deps.onLevel(peak) },
        onInterrupted: (why) => { if (current()) this.interrupted(why) },
        onRecovered: () => { if (current()) this.check() },
      })
    } catch (err) {
      if (current()) {
        this.acquiring = false
        this.error = micError(err)
        this.changed()
      }
      return null
    }
    if (!current()) {
      mic.close()
      return null
    }
    this.acquiring = false
    this.mic = mic
    this.lastChunkAt = this.now()
    void this.deps.lock.acquire().catch(() => {}).finally(() => this.changed())
    this.changed()
    return generation
  }

  /** Stream the open mic into the meeting `launch`, unless the session moved on. */
  stream(generation: number, launch: string | null): void {
    if (generation !== this.generation || !this.mic || this.relay) return
    const relay: RelayLike = this.deps.createRelay(launch, {
      onLink: (link, reason) => {
        if (this.relay !== relay) return
        this.link = link
        this.linkReason = reason
        if (TERMINAL_LINKS.has(link)) this.release()
        this.changed()
      },
      onLoss: (since, until) => {
        if (this.relay !== relay) return
        this.lostSince = until === null ? since : null
        if (until !== null) this.warning = `Audio lost from ${clockTime(since)} to ${clockTime(until)}.`
        this.changed()
      },
    })
    this.relay = relay
    relay.open()
  }

  /** Turn the mic off; anything still pending is disposed of when it lands. */
  stop(): void {
    this.release()
    this.link = 'idle'
    this.linkReason = null
    this.changed()
  }

  /** Bring the mic back (a tap on Restore, or the tab returning). */
  async restore(): Promise<void> {
    const mic = this.mic
    if (!mic) return
    const generation = this.generation
    try {
      const health = await mic.revive()
      if (generation !== this.generation || this.mic !== mic) return
      this.needsRestore = health !== 'ok'
      if (health === 'ok' && this.warning) this.warning = `${this.warning} The mic is back.`
    } catch (err) {
      if (generation !== this.generation || this.mic !== mic) return
      this.needsRestore = true
      this.error = micError(err)
    }
    this.changed()
  }

  /** Look at the mic now: on return to the tab, and once a second. */
  check(): void {
    const mic = this.mic
    if (!mic) return
    const health = mic.health()
    if (health !== 'ok') {
      if (!this.needsRestore) this.interrupted(HEALTH_WORDS[health])
    } else if (this.needsRestore) {
      this.needsRestore = false
      this.changed()
    }
    if (this.silentSince === null && this.now() - this.lastChunkAt > AUDIO_GAP_MS) {
      this.silentSince = this.lastChunkAt
    }
  }

  /** The tab is visible again: take the lock back, reconnect, check the mic. */
  returned(): void {
    if (!this.mic) return
    void this.deps.lock.reacquire().catch(() => {}).finally(() => this.changed())
    this.relay?.nudge()
    this.check()
    if (this.needsRestore) void this.restore()
  }

  private heard(): void {
    const now = this.now()
    if (this.silentSince !== null) {
      this.warning = `No audio from the mic from ${clockTime(this.silentSince)} to ${clockTime(now)} (the screen locked or Safari went to the background).`
      this.silentSince = null
      this.changed()
    }
    this.lastChunkAt = now
  }

  private interrupted(why: string): void {
    this.needsRestore = true
    this.warning = `Audio was interrupted at ${clockTime(this.now())} (${why}); speech is missing until the mic is back.`
    this.changed()
  }

  private release(): void {
    this.generation += 1
    const relay = this.relay
    this.relay = null
    relay?.close()
    const mic = this.mic
    this.mic = null
    mic?.close()
    this.acquiring = false
    this.needsRestore = false
    this.lostSince = null
    this.silentSince = null
    this.deps.lock.release()
  }

  private changed(): void {
    this.deps.onChange()
  }
}
