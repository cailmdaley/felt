/**
 * The native half of "+ Add project…": ask the daemon to raise its own host's
 * OS folder dialog (`POST /api/v1/choose-folder`).
 *
 * The forms call this whenever the selected HOST is local and the daemon
 * reported `native_folder_picker` in its `/api/v1/felt-stores` payload;
 * anything other than a chosen path (`'unavailable'`, or a transport failure)
 * falls through to typing the path, which is also what a remote host gets —
 * a dialog raised on a remote would open on a desktop nobody is sitting at. A
 * cancel is NOT a fallback and not an error — the human said no, and the form
 * does nothing at all.
 *
 * The fetch blocks for as long as the dialog is up (the daemon bounds it at
 * five minutes), so callers show a busy state around the call.
 */

export type ChooseFolderResult =
  | { status: 'chosen'; path: string }
  | { status: 'cancelled' }
  | { status: 'unavailable' }

/** Parse a `/api/v1/choose-folder` body into the three outcomes. Exported for
 *  the unit test: an old daemon, a proxy error page or a forwarded remote
 *  failure must degrade to `unavailable` (→ type the path), never throw. */
export function parseChooseFolder(status: number, body: unknown): ChooseFolderResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 'unavailable' }
  const rec = body as Record<string, unknown>
  if (status === 200 && rec.ok === true && typeof rec.path === 'string' && rec.path)
    return { status: 'chosen', path: rec.path }
  if (status === 200 && rec.cancelled === true) return { status: 'cancelled' }
  return { status: 'unavailable' }
}

export async function chooseFolder(shuttleBase: string): Promise<ChooseFolderResult> {
  try {
    const res = await fetch(`${shuttleBase}/api/v1/choose-folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const body: unknown = await res.json().catch(() => undefined)
    return parseChooseFolder(res.status, body)
  } catch {
    return { status: 'unavailable' }
  }
}

export type RegisterResult = { ok: true } | { ok: false; error: string }

/** Read `POST /api/v1/projects`'s answer. The endpoint is owner-routed, so a
 *  400 here may well be the REMOTE daemon saying "not a directory: …" — that
 *  message is the only thing telling the human their path was wrong on the
 *  other host, so it is carried through verbatim rather than flattened to a
 *  boolean. Exported for the unit test. */
export function parseRegisterProject(
  status: number,
  ok: boolean,
  body: unknown,
): RegisterResult {
  if (ok && status < 400) return { ok: true }
  const rec =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {}
  const error = typeof rec.error === 'string' && rec.error ? rec.error : `register failed (${status})`
  return { ok: false, error }
}

/** Register a project directory on `origin`'s host: `POST /api/v1/projects`,
 *  which felt-inits the directory and appends it to that host's curated picker
 *  list. `origin` is the picker's host id — `'local'`, or a bare remote name
 *  the daemon forwards to. */
export async function registerProject(
  shuttleBase: string,
  path: string,
  origin: string,
): Promise<RegisterResult> {
  try {
    const res = await fetch(`${shuttleBase}/api/v1/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, origin }),
    })
    const body: unknown = await res.json().catch(() => undefined)
    return parseRegisterProject(res.status, res.ok, body)
  } catch {
    return { ok: false, error: 'Couldn’t reach the Shuttle daemon (:4000).' }
  }
}
