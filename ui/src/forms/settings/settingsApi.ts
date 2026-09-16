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

export const CONFIG_IDS: ConfigId[] = ['stores', 'projects', 'agents', 'remotes']

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
  /** This host can raise its own OS folder dialog. Only ever true locally —
   *  a dialog on a remote opens on a desktop nobody is sitting at. */
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

const reachError = (err: unknown): Error => {
  const message = (err as { message?: string })?.message ?? String(err)
  return new Error(
    message.includes('fetch') ? 'Couldn’t reach the Shuttle daemon (:4000).' : message,
  )
}

async function getJSON<T>(base: string, path: string, host: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${base}${path}`)
  } catch (err) {
    throw reachError(err)
  }
  if (!res.ok) throw new Error(await refusal(res, host))
  return (await res.json()) as T
}

async function postJSON<T>(
  base: string,
  path: string,
  body: Record<string, unknown>,
  host: string,
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
  if (!res.ok) throw new Error(await refusal(res, host))
  return (await res.json()) as T
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
  getJSON(base, `/api/v1/config${originQuery(host.origin)}`, host.label)

export const loadConfigFile = (
  base: string,
  host: SettingsHost,
  id: ConfigId,
): Promise<ConfigFile> =>
  getJSON(base, `/api/v1/config/${id}${originQuery(host.origin)}`, host.label)

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
  )

// ── The two path lists ──────────────────────────────────────────────────────

export const saveStores = (
  base: string,
  host: SettingsHost,
  feltStores: string[],
): Promise<{ felt_stores: string[] }> =>
  postJSON(base, '/api/v1/felt-stores', { felt_stores: feltStores, origin: host.origin }, host.label)

export const saveProjects = (
  base: string,
  host: SettingsHost,
  projects: string[],
): Promise<{ projects: string[] }> =>
  postJSON(base, '/api/v1/projects', { projects, origin: host.origin }, host.label)

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
  postJSON(base, '/api/v1/projects', { path, origin: host.origin }, host.label)

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
  getJSON(base, `/api/v1/fleet${originQuery(host.origin)}`, host.label)

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
  postJSON(base, '/api/v1/fleet/remotes', { ...spec, origin: host.origin }, host.label)

export const removeRemote = (
  base: string,
  host: SettingsHost,
  name: string,
): Promise<{ output: string }> =>
  postJSON(base, '/api/v1/fleet/remotes', { name, remove: true, origin: host.origin }, host.label)

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

/** The daemon serving this page — its build, and the CLI contract it probed. */
export const loadVersion = (base: string): Promise<BuildStamp & { contract?: HostState['contract'] }> =>
  getJSON(base, '/api/v1/version', '')

/** Release a host's boot quarantine — owner-routed, so a hub can arm a remote. */
export const releaseQuarantine = (base: string, host: SettingsHost): Promise<unknown> =>
  postJSON(base, '/api/v1/quarantine/release', { origin: host.origin }, host.label)
