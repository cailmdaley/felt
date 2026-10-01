/**
 * The phone's microphone as a stream of 100 ms s16le 16 kHz chunks: an
 * AudioContext at the device's own rate, the mic as its source, and the
 * `pcm-16k` worklet (pcmWorklet.ts) doing the resampling and packing. The
 * context runs at whatever rate the device picks; asking for 16 kHz is
 * something iOS Safari honors inconsistently, so the worklet resamples.
 */

import workletUrl from './pcmWorklet.ts?worker&url'
import { audioHealth, type AudioHealth } from './phoneState'

export const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: true,
  },
}

export interface MicHandlers {
  onChunk: (pcm: ArrayBuffer) => void
  /** Peak level of the last chunk, 0–1. */
  onLevel: (peak: number) => void
  /** The system took the audio away: the track ended or muted, or the
   *  context stopped running. */
  onInterrupted: (why: string) => void
  /** The system gave a muted track back. */
  onRecovered?: () => void
}

/**
 * Create the AudioContext. Call it synchronously inside the tap that starts
 * the mic: iOS lets a context run only when it was made (or resumed) in a
 * user gesture.
 */
export function audioContextForGesture(): AudioContext {
  const context = new AudioContext()
  void context.resume().catch(() => {})
  return context
}

export class Mic {
  private track: MediaStreamTrack | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private closed = false

  private readonly context: AudioContext
  private readonly worklet: AudioWorkletNode
  private readonly sink: GainNode
  private readonly handlers: MicHandlers

  private constructor(context: AudioContext, worklet: AudioWorkletNode, sink: GainNode, handlers: MicHandlers) {
    this.context = context
    this.worklet = worklet
    this.sink = sink
    this.handlers = handlers
  }

  /**
   * Ask for the mic and start the graph. The first await is getUserMedia, so
   * the call stays inside the tap's gesture on iOS.
   */
  static async open(context: AudioContext, handlers: MicHandlers): Promise<Mic> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('this browser offers no microphone here (the page needs HTTPS)')
    }
    const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS)
    try {
      await context.audioWorklet.addModule(workletUrl)
      const worklet = new AudioWorkletNode(context, 'pcm-16k', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      })
      // Silent, but connected: a node that reaches the destination is pulled
      // by the graph on every engine.
      const sink = context.createGain()
      sink.gain.value = 0
      worklet.connect(sink).connect(context.destination)
      const mic = new Mic(context, worklet, sink, handlers)
      worklet.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; peak: number }>) => {
        if (mic.closed) return
        handlers.onChunk(event.data.pcm)
        handlers.onLevel(event.data.peak)
      }
      context.onstatechange = () => {
        if (!mic.closed && context.state !== 'running') handlers.onInterrupted(`audio ${context.state}`)
      }
      mic.attach(stream)
      if (context.state !== 'running') await context.resume()
      return mic
    } catch (error) {
      for (const track of stream.getTracks()) track.stop()
      throw error
    }
  }

  health(): AudioHealth {
    return audioHealth(this.track?.readyState ?? 'missing', this.track?.muted ?? false, this.context.state)
  }

  get sampleRate(): number {
    return this.context.sampleRate
  }

  /**
   * Bring the audio back: resume a suspended context, and ask for the mic again
   * when its track ended or the system muted it. One revival runs at a time;
   * a stream that arrives after `close()` is stopped at once. Throws when the
   * system will not give the mic back without a fresh tap.
   */
  revive(): Promise<AudioHealth> {
    this.reviving ??= this.reviveOnce().finally(() => { this.reviving = null })
    return this.reviving
  }

  private reviving: Promise<AudioHealth> | null = null

  private async reviveOnce(): Promise<AudioHealth> {
    if (this.closed) return this.health()
    if (this.context.state !== 'running') await this.context.resume()
    if (!this.closed && (this.track?.readyState !== 'live' || this.track.muted)) {
      const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS)
      if (this.closed) {
        for (const track of stream.getTracks()) track.stop()
        return this.health()
      }
      this.attach(stream)
    }
    return this.health()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.detach()
    this.worklet.port.onmessage = null
    this.worklet.disconnect()
    this.sink.disconnect()
    this.context.onstatechange = null
    void this.context.close().catch(() => {})
  }

  private attach(stream: MediaStream): void {
    this.detach()
    const track = stream.getAudioTracks()[0]
    if (!track) throw new Error('the microphone stream has no audio track')
    track.onended = () => {
      if (!this.closed) this.handlers.onInterrupted('the mic stopped')
    }
    track.onmute = () => {
      if (!this.closed) this.handlers.onInterrupted('the system muted the mic')
    }
    track.onunmute = () => {
      if (!this.closed) this.handlers.onRecovered?.()
    }
    this.track = track
    this.source = this.context.createMediaStreamSource(stream)
    this.source.connect(this.worklet)
  }

  private detach(): void {
    this.source?.disconnect()
    this.source = null
    if (this.track) {
      this.track.onended = null
      this.track.onmute = null
      this.track.onunmute = null
      this.track.stop()
    }
    this.track = null
  }
}

export interface WakeLockLike {
  readonly released: boolean
  release(): Promise<void>
  addEventListener(type: 'release', listener: () => void): void
}

/**
 * The screen wake lock, held while streaming and taken again on return. A
 * grant that arrives after `release()` (the request was still pending) is
 * released at once.
 */
export class ScreenLock {
  private sentinel: WakeLockLike | null = null
  private wanted = false
  private generation = 0
  private pending = false
  private readonly request: (() => Promise<WakeLockLike>) | null
  private readonly visible: () => boolean

  constructor(
    request: (() => Promise<WakeLockLike>) | null =
      'wakeLock' in navigator ? () => navigator.wakeLock.request('screen') : null,
    visible: () => boolean = () => document.visibilityState === 'visible',
  ) {
    this.request = request
    this.visible = visible
  }

  get supported(): boolean {
    return this.request !== null
  }

  get held(): boolean {
    return this.sentinel !== null && !this.sentinel.released
  }

  async acquire(): Promise<void> {
    this.wanted = true
    if (!this.request || this.held || this.pending || !this.visible()) return
    const generation = this.generation
    this.pending = true
    let sentinel: WakeLockLike
    try {
      sentinel = await this.request()
    } finally {
      this.pending = false
    }
    if (generation !== this.generation || !this.wanted) {
      void sentinel.release().catch(() => {})
      // Wanted again since (released, then acquired while this was pending).
      if (this.wanted) await this.acquire()
      return
    }
    this.sentinel = sentinel
    sentinel.addEventListener('release', () => {
      if (this.sentinel === sentinel) this.sentinel = null
    })
  }

  /** Take the lock again if it is wanted (the browser drops it when hidden). */
  async reacquire(): Promise<void> {
    if (this.wanted) await this.acquire()
  }

  release(): void {
    this.wanted = false
    this.generation += 1
    const sentinel = this.sentinel
    this.sentinel = null
    void sentinel?.release().catch(() => {})
  }
}
