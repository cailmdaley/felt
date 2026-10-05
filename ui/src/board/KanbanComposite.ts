// Parser for Shuttle's unified cross-host board feed,
// `GET /api/v1/fibers/composite`.
//
// The daemon concatenates its own owner feed with each remote daemon's cached
// owner feed into one flat per-fiber list. Every row's liveness was resolved by
// its OWNING host (one observer per fiber, no cross-observer disagreement — the
// property that dissolves the drag-to-drafts bounce), and every row carries an
// `origin` naming the owning host/remote so the view routes worker focus and
// transitions without re-deriving owner from the `shuttle.host` block.
//
// This is the generalization of the backend's `extractRemoteFiberDocuments`:
// where that parsed only remote owner feeds, the composite feed makes local and
// remote rows the same wire shape, so one parser handles both.
//
// Wire shape (post JSON encoding, string-keyed):
//   {
//     host: string,                 // the local composer's own host id
//     generated_at?: string,        // ISO timestamp
//     fibers: [
//       {
//         felt_store: string,       // owning store path
//         path: string,             // fiber path relative to .felt/
//         fiber: {...felt JSON...}, // → mapFeltJsonToFiber
//         runtime?: { state, tmux_session?, session_uuid?, phase?, ... } | null,  // owner-served liveness
//         dir?: string,             // fiber's own dir (embed/image base), owner-resolved
//         report_path?: string,     // sibling report.html, owner-resolved
//         origin: string,           // owning host/remote name
//       }, ...
//     ],
//     origins: {
//       "<name>": {
//         kind: "local" | "remote",
//         stale: boolean,
//         last_polled_at?: string,
//         last_error?: string,
//         fiber_count: number,
//       }, ...
//     },
//   }

import { validDesktopThreadLink } from './appConversation.js';
import { mapFeltJsonToFiber, type Fiber } from './KanbanFiber.js';

/**
 * The owning daemon's worker for one fiber. The daemon emits a `runtime` only
 * for a fiber in its running map, so the record's presence IS the liveness
 * observation; `state` says whether that worker is running or stuck.
 */
interface CompositeRuntime {
  /** `running` for a live worker; `blocked` for an app worker whose launch or
   * conversation failed and now waits on a human (with `launchError`). */
  state: 'running' | 'blocked';
  /** Owner-served tmux session name for a CLI worker — the terminal handle.
   * App workers have none. */
  tmuxSession?: string;
  surface?: 'cli' | 'app';
  agent?: string;
  sessionUuid?: string;
  /** Owner-served activity category — one of `"attention"` (raised its hand —
   * "needs you", sorts top), `"waiting"` (paused at a stop — "waiting for you"
   * once idle ≥60s), `"working"` (mid-tool — busy, sinks to the bottom, no
   * chip). Absent until the worker's first hook event (or, for an app worker,
   * while its launch is not running). */
  phase?: string;
  /** Real ms timestamp of this live session's most-recent hook event of ANY
   * type. Present only for a tracked running worker; drives activity-age labels
   * and the 60s waiting-chip gate, never card ordering. */
  lastActivityAt?: number;
  /** Owner-observed launch instant of the current worker, epoch milliseconds. */
  startedAt?: number;
  /** Owner-served: where a phone opens this worker — the claude.ai bridge URL
   * the session wrote into its own transcript. Absent when never bridged. */
  sessionLink?: string;
  desktopLink?: string;
  /** A durable app-launch failure reported by the owning daemon. */
  launchError?: string;
}

export interface CompositeEntry {
  /** Owning host/remote name (the feed row's `origin`). Routes worker focus and
   * transition writes; this is the value to pass back as the `/transition`
   * `origin`. */
  origin: string;
  /** Owning felt store path on the owning host. */
  feltStore: string;
  /** Fiber path relative to the owning `.felt/` root. */
  path: string;
  fiber: Fiber;
  /** Owner-served liveness — present iff the owning daemon holds a worker for
   * this fiber. The single reconciled liveness observation per fiber. */
  runtime?: CompositeRuntime;
  /** Owner-served boot-quarantine hold — true iff the owning daemon is
   * withholding this fiber as a genuinely-fresh launch in `pending_launch`
   * (awaiting `shuttle daemon release`). Distinct from `runtime` (a live worker)
   * and from an idle-active card. Served through the per-fiber feed by the
   * owning host, so it works cross-host with no board-side global-state lookup. */
  held?: boolean;
  /** Ms timestamp the hold began (`parked_at`), for a "held Nm" tooltip. */
  heldSince?: number;
  /** Absolute path to the fiber's own directory on the owning host
   * (`dirname(felt.path)`), owner-resolved. The base a relative `:::{embed}` /
   * image in the body resolves against before the `/file` route reads it.
   * Present for every fiber a current-build daemon serves. */
  dir?: string;
  /** Absolute path to a sibling `report.html`, when the owning daemon resolved
   * one. (Always `<dir>/report.html`; presence is the report-exists signal.) */
  reportPath?: string;
  /**
   * Other origins that served this same fiber, set by `dedupeMirroredRows` on
   * the row it kept. A git-synced store is served by every daemon that has it
   * on disk, so one fiber can arrive several times; the board shows ONE card
   * and names the other hosts on it rather than pretending they don't exist.
   * Absent for the ordinary single-origin row.
   */
  mirroredOrigins?: string[];
}

export interface CompositeOrigin {
  kind: 'local' | 'remote';
  /** True when this origin's feed is stale (an unreachable remote keeps its
   * last-known rows but is flagged, not dropped). */
  stale: boolean;
  lastPolledAt?: string;
  lastError?: string;
  fiberCount: number;
}

export interface CompositeFeed {
  /** The local composer's own host id. */
  host: string;
  generatedAt?: string;
  entries: CompositeEntry[];
  origins: Record<string, CompositeOrigin>;
}

/**
 * Parse the composite feed body. Defensive like the backend parser: a row
 * missing `felt_store`/`path` or whose `fiber` doesn't map is skipped rather
 * than failing the whole board (a single malformed remote row must not blank
 * the kanban).
 */
export function parseCompositeFeed(body: unknown): CompositeFeed {
  const root = isRecord(body) ? body : {};

  const host = typeof root.host === 'string' ? root.host : '';
  const generatedAt = typeof root.generated_at === 'string' ? root.generated_at : undefined;

  const entries: CompositeEntry[] = [];
  for (const item of arrayOfRecords(root.fibers)) {
    const feltStore = typeof item.felt_store === 'string' ? item.felt_store : undefined;
    const path = typeof item.path === 'string' ? item.path : undefined;
    const fiber = mapFeltJsonToFiber(item.fiber);
    if (!feltStore || !path || !fiber) continue;

    const origin = typeof item.origin === 'string' && item.origin ? item.origin : host;
    const runtime = parseRuntime(item.runtime);
    const held = item.held === true;
    const heldSince = typeof item.held_since === 'number' ? item.held_since : undefined;
    const dir = typeof item.dir === 'string' ? item.dir : undefined;
    const reportPath = typeof item.report_path === 'string' ? item.report_path : undefined;

    entries.push({ origin, feltStore, path, fiber, runtime, held, heldSince, dir, reportPath });
  }

  const origins: Record<string, CompositeOrigin> = {};
  if (isRecord(root.origins)) {
    for (const [name, raw] of Object.entries(root.origins)) {
      if (!isRecord(raw)) continue;
      origins[name] = {
        kind: raw.kind === 'local' ? 'local' : 'remote',
        stale: raw.stale === true,
        lastPolledAt: typeof raw.last_polled_at === 'string' ? raw.last_polled_at : undefined,
        lastError: typeof raw.last_error === 'string' ? raw.last_error : undefined,
        fiberCount: typeof raw.fiber_count === 'number' ? raw.fiber_count : 0,
      };
    }
  }

  return { host, generatedAt, entries, origins };
}

function parseRuntime(value: unknown): CompositeRuntime | undefined {
  if (!isRecord(value)) return undefined;
  const session = value.tmux_session;
  const tmuxSession = typeof session === 'string' && session.length > 0 ? session : undefined;
  const sessionUuid = typeof value.session_uuid === 'string' && value.session_uuid.length > 0
    ? value.session_uuid
    : undefined;
  // A record that neither names a worker (terminal or app thread) nor states
  // one observes nothing.
  if (!tmuxSession && !sessionUuid && typeof value.state !== 'string') return undefined;
  const state = value.state === 'blocked' ? 'blocked' : 'running';
  const phase = typeof value.phase === 'string' && value.phase.length > 0 ? value.phase : undefined;
  const lastActivityAt = typeof value.last_activity_at === 'number' ? value.last_activity_at : undefined;
  const launchError = typeof value.launch_error === 'string' && value.launch_error.length > 0
    ? value.launch_error
    : undefined;
  const sessionLink =
    typeof value.session_link === 'string' && value.session_link.startsWith('https://')
      ? value.session_link
      : undefined;
  const desktopLink = validDesktopThreadLink(value.desktop_link);
  const surface = value.surface === 'app' || value.surface === 'cli' ? value.surface : undefined;
  const agent = typeof value.agent === 'string' ? value.agent : undefined;
  const startedAt = typeof value.started_at === 'number' && Number.isFinite(value.started_at) ? value.started_at : undefined;
  return { state, tmuxSession, surface, agent, sessionUuid, phase, lastActivityAt, startedAt, sessionLink, desktopLink, launchError };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}
