/** The durable execution choice for a shuttle block. Absence is deliberately
 * interpreted as CLI: existing fibers keep their established transport. */
export type ExecutionSurface = 'cli' | 'app'

export interface SurfaceAgent { cli?: string }

export function isCodexAgent(agent: SurfaceAgent | undefined): boolean {
  return agent?.cli === 'codex'
}

/** New Codex work starts in the app; every other harness remains CLI. */
export function defaultSurface(agent: SurfaceAgent | undefined): ExecutionSurface {
  return isCodexAgent(agent) ? 'app' : 'cli'
}

/** A persisted block must never be silently upgraded to the app. */
export function persistedSurface(surface: string | undefined | null): ExecutionSurface {
  return surface === 'app' ? 'app' : 'cli'
}
