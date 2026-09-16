/**
 * The settings page's read and write plane — every daemon call it makes, with
 * the shapes it expects back.
 *
 * Two things every function here has in common, and they are the whole reason
 * this file exists rather than `fetch` scattered through five components:
 *
 * **Origin.** Settings is a fleet surface, not a local one. Every call carries
 * the host being configured, as `?origin=` on a read and `origin:` in the body
 * on a write, and the daemon owner-routes it to the machine that owns the file.
 * `''` means the daemon serving the page. Getting that wrong writes one host's
 * configuration onto another, so it is a required argument everywhere, never a
 * default.
 *
 * **The daemon's own words.** A refused config write comes back carrying felt's
 * diagnostic verbatim — `remote "b": port 4001 already used by "a"`. These
 * functions reject with exactly that sentence and nothing added, because a
 * wrapper line ("Save failed: …") pushes the part that tells you what to fix
 * off the end of a phone's error banner.
 */

/** Which operator file. The wire names are the files' own stems. */
export type ConfigId = 'stores' | 'projects' | 'agents' | 'remotes'

/** What a config file is called on screen, and what it governs. */
export const CONFIG_FILENAME: Record<ConfigId, string> = {
  stores: 'stores.json',
  projects: 'projects.json',
  agents: 'agents.json',
  remotes: 'remotes.json',
}

export interface ConfigFileSummary {
  id: ConfigId
  path: string
  exists: boolean
  size: number
  /** Unix seconds, or null when the file does not exist. */
  updated_at: number | null
  /**
   * Set when an environment variable is overriding this file's CONTENTS
   * outright (`FELT_STORES`, `FELT_PROJECTS`). While it is set, the file on
   * disk is read by nobody — so a section that shows it has to say so, or it
   * invites you to fix a setting that has no effect.
   */
  env_override: { var: string; value: string } | null
  /**
   * A content hash of the file as served, or null when it does not exist. Send
   * it back on a write as `expected_digest` and the daemon refuses the save if
   * the bytes moved underneath — which they can, because this board is
   * reachable from two hubs and a phone at the same time.
   */
  digest: string | null
}

export interface ConfigFile extends ConfigFileSummary {
  text: string
  /**
   * The two path-list files, parsed by the reader that owns them; null for
   * `agents` and `remotes`.
   *
   * This is where a structured list editor gets its rows — NOT the origins
   * feed, which reports an empty list for a remote the hub has not heard from
   * yet, and which a whole-list write would then persist over that host's real
   * registry.
   */
  entries: string[] | null
}

/** One host the settings page can be pointed at. */
export interface SettingsHost {
  /** The owner-routing key: `''` for the daemon serving this page, else the
   *  remote's bare name. Sent as `origin` on every call. */
  origin: string
  /** The host's own id — what it calls itself, and what `shuttle.host:` pins. */
  host: string
  /** How it reads: a remote's `display`, else its host id. */
  label: string
  isLocal: boolean
  /** The hub could not reach it on the last poll. Its settings will still load
   *  if the forward gets through; this is the warning that it may not. */
  stale: boolean
  /**
   * This host reports that it can raise an OS folder dialog of its own. True
   * for a remote with a desktop, and the call IS owner-routed — but it opens
   * on that machine's screen and blocks until someone there answers it, so a
   * caller offering the affordance for a remote should say so.
   */
  nativeFolderPicker: boolean
  /** Its store registry and picker list, as the origins feed already carries
   *  them, so the two list sections render before their own fetch lands. */
  feltStores: string[]
  projects: string[]
  /**
   * The store list AFTER symlinked substores are followed — what the daemon
   * actually enumerates. Local hosts only: a remote's origin block drops it,
   * because the hub has no business claiming to know a remote's symlinks.
   * Usually longer than `feltStores`, and the difference is the thing people
   * are surprised by ("I configured one store; why does it poll fourteen?").
   */
  expandedFeltStores: string[] | null
}

export interface AgentRecord {
  id: string
  cli?: string
  wrapper?: string
  provider?: string
  model?: string
  extra_flags?: string
  requires_model?: boolean
  effort_levels?: string[]
  default_effort?: string
  chrome_capable?: boolean
  cost_class?: string
  alias_of?: string
  aliases?: string[] | null
  default?: boolean
  /** Assigned by the loader: which layer this record came from. */
  source?: 'builtin' | 'user' | string
}

export interface RemoteHealth {
  polled: boolean
  stale: boolean
  last_polled_at: string | null
  last_error: string | null
  recovery: { state: string; attempt: number; last_error: string | null } | null
}

export interface BuildStamp {
  git_sha?: string
  git_short_sha?: string
  built_at?: string
  booted_at?: string
  mix_vsn?: string
}

export interface FleetRemote {
  name: string
  display?: string
  ssh?: string
  port?: number
  remote_port?: number
  url?: string
  enabled?: boolean
  checkout?: string
  auth?: string
  ssh_flags?: string[]
  tunnel?: { manager?: string; multiplex?: boolean; label?: string }
  poll_interval_ms?: number
  request_timeout_ms?: number
  stale_multiplier?: number
  health: RemoteHealth
  build: BuildStamp | null
  tunnel_label: string | null
}

export interface Fleet {
  host: string
  supervisor: string
  file: ConfigFileSummary
  /** The fleet file would not parse. The rows are empty and this says why. */
  error: string | null
  launchd_label_prefix: string | null
  defaults: Record<string, unknown>
  remotes: FleetRemote[]
}

/** What `GET /api/v1/state` and each remote's snapshot both carry. */
export interface HostState {
  host?: string
  build?: BuildStamp
  felt_stores?: string[]
  boot_quarantine?: boolean
  max_concurrent?: number
  claimed_count?: number
  contract?: { ok: boolean | null; expected: number | null; observed: number | null; reason: string | null }
  poll_health?: { state: string; stalls: number; stall_timeout_ms: number; last_stalled_at: string | null }
  document_cache?: Record<string, unknown>
  standing_roles?: unknown[]
  orphans?: unknown[]
  pending_launch?: unknown[]
}

// ── Plumbing ────────────────────────────────────────────────────────────────

const originQuery = (origin: string, extra?: Record<string, string>): string => {
  const params = new URLSearchParams(extra)
  if (origin) params.set('origin', origin)
  const query = params.toString()
  return query ? `?${query}` : ''
}

/**
 * The daemon's refusal, as a sentence.
 *
 * Three shapes reach here and only one of them is ours: our own controllers
 * answer `{ok: false, error}`; Phoenix's own 404 answers
 * `{errors: {detail: "Not Found"}}` when a route does not exist, which on this
 * page means precisely one thing — that host's daemon predates the settings
 * API — and says so, because "Not Found" would send someone looking for a
 * missing file.
 */
const refusal = async (res: Response, host: string): Promise<string> => {
  const body = (await res.json().catch(() => null)) as
    | { error?: string; errors?: { detail?: string } }
    | null
  if (body?.error) return body.error
  if (res.status === 404 && body?.errors?.detail) {
    return `${host || 'this host'} has no settings API — its daemon predates it. Deploy that host to configure it from here.`
  }
  return `the daemon answered ${res.status}`
}

/**
 * A thrown `fetch` — the daemon did not answer at all — as a sentence.
 *
 * Detected by TYPE, not by reading the message. The fetch spec says a
 * transport failure rejects with a `TypeError`, and it says nothing at all
 * about the wording: Chrome writes "Failed to fetch", Firefox "NetworkError
 * when attempting to fetch resource", and **WebKit writes "Load failed"**. A
 * substring test for "fetch" therefore worked everywhere except Safari — which
 * is the phone, which is the entire reason this surface exists. Anything that
 * is not a TypeError came from our own code and is already a sentence, so it
 * is passed through.
 */
/**
 * A refusal that carries the daemon's status alongside its sentence.
 *
 * The status is the machine-readable part and the sentence is the human one,
 * and a caller that needs to branch — was this a conflict? was the validator
 * simply not runnable? — must branch on the first. Reading the second is how
 * a recovery affordance silently disappears the next time someone improves
 * the wording.
 */
export class DaemonRefusal extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'DaemonRefusal'
    this.status = status
  }
}

/** 409 — the file moved since this editor read it. */
export const isConflict = (err: unknown): boolean =>
  err instanceof DaemonRefusal && err.status === 409

/**
 * 503 — the host could not RUN the check, so nothing is known about the bytes
 * that were sent. Distinct from a refusal on purpose: there is nothing for the
 * author to fix and retyping will not help.
 */
export const isUnavailable = (err: unknown): boolean =>
  err instanceof DaemonRefusal && err.status === 503

const reachError = (err: unknown): Error => {
  if (err instanceof TypeError) return new Error('Couldn’t reach the Shuttle daemon (:4000).')
  return new Error((err as { message?: string })?.message ?? String(err))
}

/**
 * Every answer on this plane names the host it came from. Check it.
 *
 * The daemon refuses an origin it cannot place, so this should never fire —
 * which is exactly why it is here. Origin is the safety property of the whole
 * page: a page that can write one machine's configuration and show it under
 * another machine's name is a page that eventually does. Two independent
 * guards, one on each side, and the second one costs a comparison.
 *
 * `expected` is the host id the sheet believes it is talking to, and `''` for
 * a local call skips the check — a local read cannot be about anyone else.
 */
function assertHost<T extends { host?: string }>(body: T, expected: string, label: string): T {
  if (expected && body?.host && body.host !== expected) {
    throw new Error(
      `answer came from ${body.host}, not ${label} — refusing it. ` +
        `Reopen settings; this hub's idea of the fleet has changed underneath.`,
    )
  }
  return body
}

async function getJSON<T>(
  base: string,
  path: string,
  host: string,
  expectHost = '',
): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${base}${path}`)
  } catch (err) {
    throw reachError(err)
  }
  if (!res.ok) throw new DaemonRefusal(await refusal(res, host), res.status)
  return assertHost((await res.json()) as T & { host?: string }, expectHost, host)
}

async function postJSON<T>(
  base: string,
  path: string,
  body: Record<string, unknown>,
  host: string,
  expectHost = '',
): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err) {
    throw reachError(err)
  }
  if (!res.ok) throw new DaemonRefusal(await refusal(res, host), res.status)
  return assertHost((await res.json()) as T & { host?: string }, expectHost, host)
}

// ── Hosts ───────────────────────────────────────────────────────────────────

interface OriginsResponse {
  host: string
  origins: Record<
    string,
    {
      kind?: string
      host?: string
      display?: string
      stale?: boolean
      native_folder_picker?: boolean
      felt_stores?: string[]
      expanded_felt_stores?: string[]
      projects?: string[]
    }
  >
}

/**
 * Every host the page can configure, local first, remotes alphabetical.
 *
 * Read off `GET /api/v1/felt-stores`, which is already the fleet's origins map
 * and carries each host's store registry and picker list with it — so the two
 * list sections have their data before they ask for it, and a stale remote
 * shows its last known lists rather than an empty page.
 */
export async function loadHosts(base: string): Promise<SettingsHost[]> {
  const data = await getJSON<OriginsResponse>(base, '/api/v1/felt-stores', '')
  const rows: SettingsHost[] = Object.entries(data.origins ?? {}).map(([key, origin]) => {
    const isLocal = origin.kind === 'local' || key === data.host
    return {
      origin: isLocal ? '' : key,
      host: origin.host ?? key,
      label: origin.display ?? origin.host ?? key,
      isLocal,
      stale: origin.stale === true,
      nativeFolderPicker: origin.native_folder_picker === true,
      feltStores: origin.felt_stores ?? [],
      projects: origin.projects ?? [],
      expandedFeltStores: origin.expanded_felt_stores ?? null,
    }
  })
  return rows.sort((a, b) =>
    a.isLocal === b.isLocal ? a.label.localeCompare(b.label) : a.isLocal ? -1 : 1,
  )
}

// ── Config files ────────────────────────────────────────────────────────────

export const loadConfigIndex = (
  base: string,
  host: SettingsHost,
): Promise<{ host: string; files: ConfigFileSummary[] }> =>
  getJSON(base, `/api/v1/config${originQuery(host.origin)}`, host.label, host.host)

export const loadConfigFile = (
  base: string,
  host: SettingsHost,
  id: ConfigId,
): Promise<ConfigFile> =>
  getJSON(base, `/api/v1/config/${id}${originQuery(host.origin)}`, host.label, host.host)

/**
 * Replace a file's text.
 *
 * `expectedDigest` is the `digest` the read handed back — pass it always,
 * including as `null` for a file that did not exist, so the daemon can refuse a
 * save that would overwrite bytes this editor never saw. Omitting the argument
 * is last-write-wins, which is right for a script and wrong for a human with
 * two devices.
 */
export const saveConfigFile = (
  base: string,
  host: SettingsHost,
  id: ConfigId,
  text: string,
  expectedDigest?: string | null,
): Promise<ConfigFile> =>
  postJSON(
    base,
    `/api/v1/config/${id}`,
    {
      text,
      origin: host.origin,
      ...(expectedDigest === undefined ? {} : { expected_digest: expectedDigest }),
    },
    host.label,
    host.host,
  )

// ── The two path lists ──────────────────────────────────────────────────────

/**
 * Replace a host's whole store list.
 *
 * `expectedDigest` is the digest that came with the list this caller is
 * editing. It is a whole-list REPLACE, so without it two people editing the
 * same host drop each other's rows in silence; a mismatch comes back 409.
 */
export const saveStores = (
  base: string,
  host: SettingsHost,
  feltStores: string[],
  expectedDigest?: string | null,
): Promise<{ felt_stores: string[] }> =>
  postJSON(
    base,
    '/api/v1/felt-stores',
    {
      felt_stores: feltStores,
      origin: host.origin,
      ...(expectedDigest === undefined ? {} : { expected_digest: expectedDigest }),
    },
    host.label,
    host.host,
  )

/** Replace a host's whole picker list. See `saveStores` on `expectedDigest`. */
export const saveProjects = (
  base: string,
  host: SettingsHost,
  projects: string[],
  expectedDigest?: string | null,
): Promise<{ projects: string[] }> =>
  postJSON(
    base,
    '/api/v1/projects',
    {
      projects,
      origin: host.origin,
      ...(expectedDigest === undefined ? {} : { expected_digest: expectedDigest }),
    },
    host.label,
    host.host,
  )

/**
 * Register one checkout: initializes its `.felt/` if it has none, then appends
 * it. Distinct from `saveProjects` on purpose — this is the only call that
 * creates anything on the host's disk.
 */
export const addProject = (
  base: string,
  host: SettingsHost,
  path: string,
): Promise<{ path: string; registered: boolean; initialized: boolean; projects: string[] }> =>
  postJSON(base, '/api/v1/projects', { path, origin: host.origin }, host.label, host.host)

/**
 * Raise a host's own folder dialog and answer with the chosen path.
 *
 * Owner-routed like everything else here — only the daemon on a machine can
 * raise a dialog on it. Gate every call on `host.nativeFolderPicker`, which
 * that host reports for itself: a headless node says false and the caller asks
 * for a typed path instead. Blocks for as long as the human takes.
 */
export const chooseFolder = (
  base: string,
  host: SettingsHost,
): Promise<{ ok: boolean; path?: string; cancelled?: boolean }> =>
  postJSON(base, '/api/v1/choose-folder', { origin: host.origin }, host.label)

// ── Agents ──────────────────────────────────────────────────────────────────

export const loadAgents = (base: string, host: SettingsHost): Promise<AgentRecord[]> =>
  getJSON(base, `/api/v1/agents${originQuery(host.origin)}`, host.label)

// ── Fleet ───────────────────────────────────────────────────────────────────

export const loadFleet = (base: string, host: SettingsHost): Promise<Fleet> =>
  getJSON(base, `/api/v1/fleet${originQuery(host.origin)}`, host.label, host.host)

export interface RemoteSpec {
  name: string
  url?: string
  ssh?: string
  display?: string
  checkout?: string
  tunnel_manager?: string
  port?: string
  remote_port?: string
  multiplex?: boolean
}

export const saveRemote = (
  base: string,
  host: SettingsHost,
  spec: RemoteSpec,
): Promise<{ output: string }> =>
  postJSON(base, '/api/v1/fleet/remotes', { ...spec, origin: host.origin }, host.label, host.host)

export const removeRemote = (
  base: string,
  host: SettingsHost,
  name: string,
): Promise<{ output: string }> =>
  postJSON(
    base,
    '/api/v1/fleet/remotes',
    { name, remove: true, origin: host.origin },
    host.label,
    host.host,
  )

export const runTunnels = (
  base: string,
  host: SettingsHost,
  action: 'preview' | 'install',
  name?: string,
): Promise<{ output: string }> =>
  postJSON(
    base,
    '/api/v1/tunnels',
    { action, ...(name ? { name } : {}), origin: host.origin },
    host.label,
    host.host,
  )

export const resetRemote = (base: string, name: string): Promise<unknown> =>
  postJSON(base, `/api/v1/remotes/${encodeURIComponent(name)}/reset`, {}, name)

// ── Host state ──────────────────────────────────────────────────────────────

interface CompositeState {
  local: HostState
  remotes: Record<string, { snapshot: HostState | null; stale?: boolean; last_error?: string | null }>
}

/**
 * One host's live state — what it is running, what it is holding, how its
 * poll loop is faring.
 *
 * Deliberately ONE call for every host rather than a per-host route: the hub
 * already fans the fleet's snapshots into `/state/composite` on its own poll,
 * so reading a remote's state here costs a lookup rather than a round trip
 * over the tunnel, and it is the same cached row the board draws from. A
 * remote too old to carry a `build` block reports none, which is a fact about
 * that host worth showing rather than papering over.
 */
export async function loadHostState(base: string, host: SettingsHost): Promise<HostState | null> {
  const data = await getJSON<CompositeState>(base, '/api/v1/state/composite', host.label)
  if (host.isLocal) return data.local ?? null
  return data.remotes?.[host.origin]?.snapshot ?? null
}

/** Release a host's boot quarantine — owner-routed, so a hub can arm a remote. */
export const releaseQuarantine = (base: string, host: SettingsHost): Promise<unknown> =>
  postJSON(base, '/api/v1/quarantine/release', { origin: host.origin }, host.label)
