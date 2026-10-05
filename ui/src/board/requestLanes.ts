/**
 * Lanes for daemon reads nobody is waiting on.
 *
 * Over plain HTTP/1.1 a browser opens at most six connections to the daemon,
 * and a read holds its connection until the last byte. Reads relayed to a
 * remote owner or that walk every felt store take seconds, so a handful of
 * them started at load leaves the page someone just opened queued behind them.
 * Background work therefore runs in two bounded lanes:
 *
 * - `slow`: reads that can take many seconds (resolving a fiber on another
 *   host, the whole-fleet fiber index);
 * - `quiet`: short reads that inform rather than show (file metadata, title
 *   peeks, link probes, agent registries).
 *
 * Over HTTP/2 or HTTP/3 one connection multiplexes every request, so the lanes
 * widen and only order the work. A job's slot is held until its promise
 * settles, so a job that reads a body holds it through the body.
 */
export type Lane = 'slow' | 'quiet'

type Job = { rank: number; order: number; run: () => void }
type LaneState = { active: number; queue: Job[] }

const lanes: Record<Lane, LaneState> = {
  slow: { active: 0, queue: [] },
  quiet: { active: 0, queue: [] },
}
let order = 0

/** True when the page reached the daemon over a multiplexed protocol. */
export function multiplexed(): boolean {
  try {
    const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    return /^(h2|h3)/.test(entry?.nextHopProtocol ?? '')
  } catch { return false }
}

export function laneSlots(lane: Lane, wide = multiplexed()): number {
  if (wide) return lane === 'slow' ? 4 : 6
  return lane === 'slow' ? 1 : 2
}

function pump(lane: Lane): void {
  const state = lanes[lane]
  const slots = laneSlots(lane)
  while (state.active < slots && state.queue.length) {
    state.active++
    state.queue.shift()!.run()
  }
}

/**
 * Run `work` when its lane has a free slot; lower `rank` runs first, then
 * arrival order. A job aborted while queued rejects without running.
 */
export function inLane<T>(lane: Lane, work: () => Promise<T>, options: { rank?: number; signal?: AbortSignal } = {}): Promise<T> {
  const { rank = 0, signal } = options
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const state = lanes[lane]
    const job: Job = {
      rank, order: order++,
      run: () => {
        signal?.removeEventListener('abort', cancel)
        let pending: Promise<T>
        try { pending = work() } catch (error) { pending = Promise.reject(error) }
        void pending.then(resolve, reject).finally(() => { state.active--; pump(lane) })
      },
    }
    const cancel = (): void => {
      const index = state.queue.indexOf(job)
      if (index < 0) return
      state.queue.splice(index, 1)
      reject(signal!.reason)
    }
    signal?.addEventListener('abort', cancel, { once: true })
    const at = state.queue.findIndex(other => other.rank > rank)
    if (at < 0) state.queue.push(job)
    else state.queue.splice(at, 0, job)
    pump(lane)
  })
}

/** Test support: forget queued work and in-flight counts. */
export function resetLanes(): void {
  for (const state of Object.values(lanes)) { state.active = 0; state.queue.length = 0 }
}
