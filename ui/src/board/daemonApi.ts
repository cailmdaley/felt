/** Shared fetch boundary for the daemon API. A boot 503 is a distinct state,
 * not a JSON payload for a caller to render or a generic request failure. */
export class DaemonBootingError extends Error {
  readonly status = 503

  constructor() {
    super('Daemon is starting…')
    this.name = 'DaemonBootingError'
  }
}

export async function daemonFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init)

  if (response.status === 503 && typeof response.clone === 'function') {
    try {
      const body: unknown = await response.clone().json()
      if (isRecord(body) && body.error === 'booting') throw new DaemonBootingError()
    } catch (error) {
      if (error instanceof DaemonBootingError) throw error
    }
  }

  return response
}

export function isDaemonBooting(error: unknown): error is DaemonBootingError {
  return error instanceof DaemonBootingError
}

/**
 * A failed daemon request as a sentence.
 *
 * An unreachable daemon is detected by TYPE, not by reading the message. The
 * fetch spec says a transport failure rejects with a `TypeError` and says
 * nothing about the wording: Chrome writes "Failed to fetch", Firefox
 * "NetworkError when attempting to fetch resource", and WebKit — the phone —
 * writes "Load failed". Anything that is not a TypeError came from our own
 * code and is already a sentence, so it is passed through.
 */
export function daemonErrorMessage(error: unknown): string {
  if (error instanceof TypeError) return 'Couldn’t reach the Shuttle daemon (:4000).'
  return (error as { message?: string })?.message ?? String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
