import type { KanbanCard } from './KanbanTypes.js'

/**
 * Extract the most descriptive error message from a failed daemon response.
 *
 * Shuttle's endpoints don't speak one error format: `/api/v1/lifecycle` and
 * `/api/v1/transition` (on the local→remote forward path) reply `text/plain`
 * with the CLI's stderr ("shuttle exited 1: …", "fiber not found: …", a
 * validation message); the transition controller's local errors reply JSON
 * `{error}`. Parsing every body as JSON would collapse a plain-text one to a
 * bare status code — throwing away the one line that says what went wrong.
 *
 * This reads the body once, prefers a JSON `error` field when present, falls
 * back to the raw text, and only then to `<label> (HTTP <status>)`.
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

/**
 * POST one JSON body to a daemon write route, throwing the daemon's own
 * message on a non-2xx. Every write route is owner-routed by the `origin`
 * field in the body, so the board can drive a fiber whose owning host is not
 * this one.
 */
export async function postDaemonJson(
  shuttleBase: string,
  path: string,
  body: unknown,
  label: string,
): Promise<void> {
  const res = await fetch(`${shuttleBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await errorMessageFromResponse(res, label))
}

/**
 * The one launch request every gesture sends: `POST /api/v1/dispatch` with
 * `force` + `ad_hoc`, owner-routed by `origin`. The daemon reopens a closed
 * lifecycle itself and launches on the owning host regardless of poll
 * eligibility. `resume_mode` is explicit on every launch — `fresh` starts a
 * new session, `previous` resumes the fiber's `shuttle.session_uuid` — and
 * `user_message` rides inline into the worker's prompt. `project_dir` is a
 * directory a human confirmed after a start was refused for want of one
 * ({@link needsProjectDir}); the owning host's CLI validates and saves it.
 */
export function postForceDispatch(
  shuttleBase: string,
  card: Pick<KanbanCard, 'id' | 'originId'>,
  fields: { resume_mode: 'fresh' | 'previous'; user_message?: string; project_dir?: string },
): Promise<Response> {
  return fetch(`${shuttleBase}/api/v1/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fiber_id: card.id,
      origin: card.originId,
      force: true,
      ad_hoc: true,
      ...fields,
    }),
  })
}

/** What a refused dispatch says: the readiness rejection explains that no
 *  launch occurred; otherwise, the structured ineligibility copy when the
 *  daemon sent any (it names the actual host / project_dir), else its
 *  `error`, else `fallback`. A start that could not arm its fiber
 *  (`arm_refused`) reads as the owning host's reason — the Shuttle CLI's own
 *  words when it refused — placed on that host, where any command it names
 *  runs. */
export function dispatchFailureMessage(body: DispatchFailureBody, fallback: string, status?: number): string {
  if (status === 503 && body.error === 'booting' && body.ready === false) {
    return 'The daemon is starting. Nothing was launched; try again shortly.'
  }
  if (body.reason === 'arm_refused' && body.message?.trim()) {
    const reason = body.message.trim()
    return body.host ? `On ${body.host}: ${reason}` : reason
  }
  if (body.reason || body.detail || body.message) return dispatchIneligibleReason(body)
  return body.error || fallback
}

/** True when a refused start can go ahead once a human names the fiber's
 *  project directory: the block has none, or one this host rejected. */
export function needsProjectDir(body: DispatchFailureBody): boolean {
  return body.reason === 'arm_refused' && body.needs === 'project_dir'
}

export function isAgentCard(card: KanbanCard): boolean {
  return card.shuttleKind !== undefined ||
    card.shuttleAgent !== undefined
}

/** A refused dispatch's JSON body: the ineligibility fields, or a bare `error`.
 *  A start refused while arming (`reason: 'arm_refused'`) adds the owning `host` and,
 *  when a human must supply a block field first, `needs`. */
export type DispatchFailureBody = DispatchIneligibleBody & {
  error?: string
  ready?: boolean
  host?: string
  needs?: string
}

/** The structured shape a 422 not_eligible dispatch response can carry. */
export interface DispatchIneligibleBody {
  reason?: string
  /** Specific cause code emitted by the daemon. */
  detail?: string
  /** Pre-composed human message from the daemon. */
  message?: string
}

/**
 * Map a 422 not_eligible dispatch response to a message readable by a human.
 *
 * The daemon returns a `detail` code (e.g. `homed_elsewhere`,
 * `project_dir_missing`, `disabled`, `closed`) and often a pre-composed
 * `message`. The daemon's `message` wins when present (it can name the actual
 * host / project_dir), then per-`detail` copy, then the `reason` string. The
 * flat "disabled, not yet due, or closed" is the last resort for a bare
 * `not_eligible` with no detail.
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
    // macOS: the daemon refuses to be the process that forks the tmux server,
    // because macOS would then charge every worker's file access to the
    // daemon's binary. Fallback copy only — the daemon's own message (which
    // explains the "erlexec" prompts) wins above.
    case 'tmux_server_unavailable':
      return "No tmux server on the daemon's machine — start one from kitty (tmux new-session -d -s shuttle-anchor) and dispatch again."
    case 'not_eligible':
    case undefined:
      return 'Not currently eligible — the fiber may be disabled, not yet due, or already closed.'
    default:
      return `Not eligible: ${code}`
  }
}
