/**
 * The daemon's core API as TypeScript: the shapes `contract/shuttle-api.json`
 * describes, in the wire's own snake_case. Response objects may carry fields
 * these types do not name; a client ignores them.
 */

/** The owner's Desk column for a fiber (`FiberRow.column`). */
export type ShuttleColumn =
  | 'drafts' | 'in_flight' | 'awaiting_review' | 'orchestrator_review'
  | 'tempered' | 'discarded' | 'resting' | 'roles'

/** Whose move a fiber is, as its owner reads it (`FiberRow.turn`). */
export type ShuttleTurn = 'question' | 'blocked' | 'idle' | 'working' | 'starting' | 'no-signal' | 'none'

/** A worker's question to the human, as the shuttle block carries it. */
export interface ShuttleAsk { text: string; at: string }

/** The `shuttle:` block of a fiber's frontmatter: the fields a UI reads. */
export interface ShuttleBlock {
  host?: string
  kind?: 'oneshot' | 'standing'
  agent?: string
  effort?: string
  role?: string
  person?: string
  seat?: boolean
  channel?: string
  project_dir?: string
  ask?: ShuttleAsk
  review?: { note?: string; at?: string }
  runtime?: { dispatched_at?: string; handed_off_at?: string; session_uuid?: string }
  [key: string]: unknown
}

/** A felt fiber document (`Fiber`). */
export interface ShuttleFiberDoc {
  id: string
  uid?: string
  slug?: string
  name: string
  status?: string | null
  body?: string
  outcome?: string | null
  role?: string | null
  due?: string | null
  horizon?: string | null
  tags?: string[]
  created_at?: string | null
  closed_at?: string | null
  modified_at?: string | null
  tempered?: boolean | null
  unreadable?: string
  shuttle?: ShuttleBlock
}

/** The owner's live worker for a fiber; present only while a worker is tracked. */
export interface ShuttleWorkerRuntime {
  /** `running` for a live worker, `blocked` for one whose launch failed. */
  state?: 'running' | 'blocked'
  tmux_session?: string
  session_uuid?: string
  agent?: string
  terminal?: 'tmux' | 'rex'
  /** `attention`, `waiting`, `working`, or an identity phase. */
  phase?: string
  /** Epoch ms at which the worker entered its phase. */
  phase_since?: number
  quiet_since?: number
  /** Epoch ms the worker launched. */
  started_at?: number
  launch_error?: string
  session_link?: string
  [key: string]: unknown
}

/** One row of the cross-host feed (`CompositeFiberRow`): a fiber, where it lives, and its owner's reading of it. */
export interface ShuttleFiber {
  fiber: ShuttleFiberDoc
  /** Host id of the daemon that owns the fiber; pass it back as `origin` on writes. */
  origin: string
  felt_store: string
  path: string
  dir?: string
  /** The companion page (`tapestry.html`, `artifact.html`, `report.html`) on the owner. */
  report_path?: string
  /** The nearest ancestor constitution's id; null for a root. */
  orchestrator?: string | null
  column?: ShuttleColumn
  turn?: ShuttleTurn
  runtime?: ShuttleWorkerRuntime | null
  held?: boolean
  pending_results?: number
  dispatch_error?: string | null
}

/** How fresh one origin's rows are (`Freshness`). */
export interface ShuttleOriginFreshness {
  kind: 'local' | 'remote'
  stale: boolean
  fiber_count: number
  last_polled_at?: string | null
  last_error?: string | null
  cache?: Record<string, unknown> | null
}

/** `GET /fibers/composite`. */
export interface ShuttleCompositeResponse {
  host: string
  fibers: ShuttleFiber[]
  origins: Record<string, ShuttleOriginFreshness>
}

/** `GET /fibers/{id}`. */
export interface ShuttleFiberEnvelope {
  host: string
  felt_stores: string[]
  generated_at: string
  fibers: ShuttleFiber[]
}

/** `GET /version`. */
export interface ShuttleVersion {
  api_level: number
  contract_level: number
  host: string
  terminal: 'tmux' | 'rex'
  ready: boolean
  boot_hold: Record<string, unknown> | null
  boot: Record<string, unknown> | null
  boot_duration_ms: number
  listen: string
  host_class: string
  contract: Record<string, unknown>
  reconciliation_hold: string | null
  git_sha?: string
  git_short_sha?: string
  built_at?: string
  booted_at?: string
  [key: string]: unknown
}

/** One remote in `GET /fleet`. */
export interface ShuttleFleetRemote {
  name: string
  url?: string
  source?: string
  display?: string
  health: { polled: boolean; stale: boolean; last_polled_at: string | null; last_error: string | null }
  build: Record<string, unknown> | null
  [key: string]: unknown
}

/** `GET /fleet`. */
export interface ShuttleFleetResponse {
  host: string
  supervisor: 'launchd' | 'systemd' | 'none'
  error: string | null
  remotes: ShuttleFleetRemote[]
  [key: string]: unknown
}

/** One addressable session in `GET /peers`. */
export interface ShuttlePeerSession {
  address: string
  host: string
  harness?: string
  id?: string
  title?: string
  state?: string
  fiber?: string
  fiber_uid?: string
}

/** `GET /peers`. */
export interface ShuttlePeerDirectory {
  host: string
  sessions: ShuttlePeerSession[]
  gaps: Array<{ host: string; harness?: string; error: string }>
}

/** One file a fiber's worker sent the human (`SentFile`). */
export interface ShuttleSentFile {
  fullPath: string
  basename: string
  /** Epoch ms of the send. */
  timestamp: number | null
  sessionId: string | null
  caption?: string
}

/** The verbs `POST /lifecycle` takes. */
export type ShuttleLifecycleAction =
  | 'install' | 'pause' | 'rest' | 'resume' | 'repeat' | 'reshape' | 'close' | 'reopen'
  | 'set-model' | 'set-agent' | 'role' | 'seat' | 'set-outcome' | 'uninstall' | 'ask-clear'

/** A `POST /lifecycle` verb and its arguments, without the fiber it acts on. */
export interface ShuttleLifecycleVerb {
  action: ShuttleLifecycleAction
  project_dir?: string
  until?: string
  review?: string
  actor?: string
  tempered?: boolean
  quiet?: boolean
  as_draft?: boolean
  no_kill?: boolean
  outcome?: string
  [key: string]: unknown
}

/** `POST /lifecycle`. */
export interface ShuttleLifecycleRequest extends ShuttleLifecycleVerb {
  /** The fiber's UID or exact namespace path. */
  fiber: string
  /** Its owner, the composite row's `origin`. */
  origin?: string
  fiber_path?: string
}

/** `POST /dispatch`. */
export interface ShuttleDispatchRequest {
  fiber_id: string
  origin?: string
  force?: boolean
  user_message?: string | null
  resume_mode?: 'previous' | 'fresh'
  message_id?: string
  existing_only?: boolean
  project_dir?: string | null
  [key: string]: unknown
}

/** `POST /deliver`. */
export interface ShuttleDeliverRequest {
  fiber_id: string
  text: string
  origin?: string
  from?: string
  message_id?: string
  resume_mode?: 'previous' | 'fresh'
  [key: string]: unknown
}

/** `POST /capture`. */
export interface ShuttleCaptureRequest {
  prompt: string
  project_dir: string
  agent?: string | null
  effort?: string | null
  origin?: string
}

/** `POST /fiber/create`. */
export interface ShuttleCreateFiberRequest {
  id: string
  name: string
  body?: string
  uid?: string
  origin?: string
  frontmatter?: Record<string, unknown>
}

/** `POST /fiber/create`'s answer (`CreatedFiber`). */
export interface ShuttleCreatedFiber { id: string; path: string; uid: string; host: string; status: 'open' | 'active' | 'closed' }

/** `POST /inbox`: list or cancel the entries waiting in front of a fiber's worker. */
export interface ShuttleInboxRequest {
  action: 'list' | 'cancel'
  fiber_id: string
  origin?: string
  /** The entry to cancel. */
  message_id?: string
}

/** `POST /kill`'s answer. */
export interface ShuttleKillResult { fiber_id: string; killed: boolean; session?: string }

/** A constitution's state, the one every surface draws: something waits on the human, a worker is live, or neither. */
export type ShuttleAttention = 'waiting' | 'working' | 'quiet'

/** A verb a fiber offers in its current state. */
export type ShuttleVerb = 'resume' | 'rest' | 'pause' | 'review' | 'temper' | 'discard' | 'reopen' | 'ask-clear' | 'kill'

/** One verb a fiber offers, with its word and the request it makes. */
export interface ShuttleOffer {
  verb: ShuttleVerb
  label: string
  /** The `/lifecycle` request it makes, less the fiber's identity; absent for `kill`, which posts `/kill`. */
  request?: ShuttleLifecycleVerb
  /** Ends the work or stops its worker: a UI may confirm it. */
  destructive?: boolean
}

/** One line a thread addressed to the human: its question, a post, a close, files it sent, or a block. */
export interface ShuttlePostItem {
  id: string
  fiber: ShuttleFiber
  kind: 'ask' | 'post' | 'file' | 'close' | 'blocked'
  text: string
  /** Epoch ms. */
  at: number
  /** It waits on the human. */
  waiting?: boolean
  files?: ShuttleSentFile[]
}

/** A fiber and the threads its orchestration holds beneath it. */
export interface ShuttleFamilyNode {
  fiber: ShuttleFiber
  children: ShuttleFamilyNode[]
}
