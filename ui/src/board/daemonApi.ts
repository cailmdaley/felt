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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
