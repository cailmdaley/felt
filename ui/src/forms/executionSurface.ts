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

/** User-facing destination, shared by creation and existing task controls. */
export function sessionHelp(agent: SurfaceAgent | undefined, surface: ExecutionSurface): string {
  if (!agent) return 'Session availability depends on the selected agent and host.'
  if (!isCodexAgent(agent)) return 'Terminal session. Choose a Codex agent to use the ChatGPT app.'
  return surface === 'app'
    ? 'Continue in the ChatGPT app. Requires an app connection on the selected host.'
    : 'Runs in a terminal on the selected host. Open it through Shuttle.'
}
