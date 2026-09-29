/**
 * What the sections showing live readings (Fleet, Host) share: a quiet re-read
 * while the sheet is open, and the relative age every reading is shown with.
 */

import { useEffect, useRef } from 'react'

/**
 * How often an open section re-reads its host.
 *
 * Slower than the board's own 15s, deliberately. The fleet read is not free on
 * the far side: it shells `felt shuttle remotes list` on the host being looked
 * at, and that host can be a shared cluster login node where the Runner's own
 * moduledoc records a felt call taking ~11s under IO pressure. Half a minute
 * is still far inside the window where a staleness clock reads honestly, and
 * it is a third of the subprocesses.
 */
const POLL_MS = 30_000

/**
 * Run `tick` every `POLL_MS` while the section is mounted, skipping a beat
 * while `busy` (a write is in flight) or the page is hidden — a sheet left
 * open behind another window should cost the fleet nothing.
 *
 * `busy` and `tick` are read through refs rather than dependencies: in the
 * deps every button press would restart the timer, so a run of clicks could
 * hold the refresh off indefinitely. `key` restarts it (a new host).
 */
export function useQuietPoll(tick: () => void, busy: boolean, key: string): void {
  const busyRef = useRef(busy)
  busyRef.current = busy
  const tickRef = useRef(tick)
  tickRef.current = tick
  useEffect(() => {
    const id = window.setInterval(() => {
      if (busyRef.current || document.hidden) return
      tickRef.current()
    }, POLL_MS)
    return () => window.clearInterval(id)
  }, [key])
}

/** "4s ago" / "3m ago" / "2h ago" / "5d ago" for a unix-ms instant. */
export function ago(then: number, now = Date.now()): string {
  const secs = Math.max(0, Math.round((now - then) / 1000))
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`
  return `${Math.round(secs / 86400)}d ago`
}
