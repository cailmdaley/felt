/**
 * The phone mic's AudioWorklet: the mic at the device's own rate in, 100 ms
 * chunks of s16le 16 kHz mono posted to the tab, each with its peak level.
 * It runs in the AudioWorkletGlobalScope, whose globals TypeScript's DOM lib
 * does not describe, so the few it uses are declared here.
 */

import { Chunker, Resampler, mixToMono } from './pcm'

declare const sampleRate: number
declare function registerProcessor(name: string, processor: new () => unknown): void
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}

class PcmProcessor extends AudioWorkletProcessor {
  private readonly resampler = new Resampler(sampleRate)
  private readonly chunker = new Chunker()

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0]
    if (channels && channels.length > 0) {
      for (const chunk of this.chunker.push(this.resampler.process(mixToMono(channels)))) {
        this.port.postMessage(chunk, [chunk.pcm])
      }
    }
    return true
  }
}

registerProcessor('pcm-16k', PcmProcessor)
