/**
 * The native half of "+ Add project…": ask the daemon to raise its own host's
 * OS folder dialog (`POST /api/v1/choose-folder`) instead of walking the
 * filesystem inside the browser.
 *
 * The forms call this first whenever the selected origin is LOCAL and the
 * daemon reported `native_folder_picker` in its `/api/v1/felt-stores` payload;
 * anything other than a chosen path (`'unavailable'`, or a transport failure)
 * drops them into the `DirectoryPicker` overlay over `GET /api/v1/browse`,
 * which stays the fallback for remote origins and headless hosts. A cancel is
 * NOT a fallback and not an error — the human said no, and the form does
 * nothing at all.
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
 *  failure must degrade to `unavailable` (→ browse fallback), never throw. */
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

/** Register a path picked natively: the same `POST /api/v1/projects` the
 *  DirectoryPicker's "Add this folder" sends, minus the overlay. Resolves false
 *  when the daemon refused it. */
export async function registerProject(shuttleBase: string, path: string): Promise<boolean> {
  try {
    const res = await fetch(`${shuttleBase}/api/v1/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    return res.ok
  } catch {
    return false
  }
}
