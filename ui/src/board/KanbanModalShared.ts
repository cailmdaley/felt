import type { KanbanCard } from './KanbanTypes.js'

/**
 * Extract the most descriptive error message from a failed daemon response.
 *
 * Shuttle's endpoints don't speak one error format: `/api/v1/lifecycle` and
 * `/api/v1/transition` (on the local→remote forward path) reply `text/plain`
 * with the full shuttle-ctl stderr ("shuttle exited 1: …", "fiber not found:
 * …", a validation message); the transition controller's local errors reply
 * JSON `{error}`. The old call sites did `res.json().catch(() => ({error:
 * status}))`, so a plain-text body failed to parse and collapsed to a bare
 * status code — throwing away the one line that says what actually went wrong.
 *
 * This reads the body once, prefers a JSON `error` field when present, falls
 * back to the raw text, and only then to `<label> (HTTP <status>)`. Always use
 * it instead of re-deriving error text inline, so every kanban op surfaces the
 * daemon's real message in the banner.
 */
export async function errorMessageFromResponse(res: Response, label: string): Promise<string> {
  let body = ''
  try { body = (await res.text()).trim() } catch { /* body unreadable (network/stream error) */ }
  if (body) {
    if (body.startsWith('{') || body.startsWith('[')) {
      try {
        const parsed = JSON.parse(body) as { error?: unknown; message?: unknown }
        const field = parsed.error ?? parsed.message
        if (typeof field === 'string' && field.trim()) return field.trim()
      } catch { /* not JSON after all — use the raw text below */ }
    }
    return body
  }
  return `${label} (HTTP ${res.status})`
}

export function isAgentCard(card: KanbanCard): boolean {
  return card.shuttleKind !== undefined ||
    card.shuttleAgent !== undefined
}

/** The structured shape a 422 not_eligible dispatch response can carry. */
export interface DispatchIneligibleBody {
  reason?: string
  /** Specific cause code emitted by the daemon (newer builds). */
  detail?: string
  /** Pre-composed human message from the daemon (newer builds). */
  message?: string
}

/**
 * Map a 422 not_eligible dispatch response to a message readable by a human.
 *
 * Newer daemons return a `detail` code (e.g. `homed_elsewhere`,
 * `project_dir_missing`, `disabled`, `closed`) and often a pre-composed
 * `message`. We prefer the daemon's `message` when present (it can name the
 * actual host / project_dir), fall back to per-`detail` copy, and finally to
 * the legacy `reason` string. The old flat "disabled, not yet due, or closed"
 * is now only the last resort for a bare `not_eligible` with no detail — the
 * common confusing case (a fiber that simply needs to run on another host)
 * now says exactly that.
 */
export function dispatchIneligibleReason(body: DispatchIneligibleBody): string {
  if (body.message && body.message.trim()) return body.message.trim()

  const code = body.detail ?? body.reason
  switch (code) {
    case 'homed_elsewhere':
      return 'This fiber is homed on another host and can only run there.'
    case 'project_dir_missing':
      return 'The fiber\'s project_dir does not exist on the owning host.'
    case 'no_shuttle_block':
      return 'Fiber has no shuttle: block to dispatch.'
    case 'not_due_or_blocked':
      return 'Not yet due, or blocked by an unmet dependency.'
    case 'disabled':
      return 'Draft — set status: active to allow dispatch.'
    case 'closed':
      return 'Fiber is closed — reopen it before dispatching.'
    case 'not_eligible':
    case undefined:
      return 'Not currently eligible — the fiber may be disabled, not yet due, or already closed.'
    default:
      return `Not eligible: ${code}`
  }
}
