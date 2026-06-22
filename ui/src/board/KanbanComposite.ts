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
//         runtime?: { tmux_session: string } | null,  // owner-served liveness
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

import { mapFeltJsonToFiber, type Fiber } from './KanbanFiber.js';

export interface CompositeRuntime {
  /** Owner-served tmux session name for a live worker on this fiber. */
  tmuxSession: string;
  /** Owner-served activity category for a tracked LIVE worker — one of:
   *   `"attention"` (last hook event is a Notification — "needs you now",
   *     sorts top), `"waiting"` (last event is stop/subagent_stop — the worker
   *     has paused; "waiting for you" once idle ≥60s), `"working"` (last event
   *     is a tool/prompt/session event — busy, sinks to the bottom, no chip).
   * Worker-LESS lifecycle phases (`retrying`/`due`/`dispatched`/`running` and
   * the column-driving `scheduled`/`awaiting`/`accepted`/`dormant`) also arrive
   * through this field, stamped by the dispatch state machine rather than the
   * activity tracker — they only appear when there's no live `tmuxSession`, so
   * the two vocabularies never collide. Free-form passthrough. */
  phase?: string;
  /** Real ms timestamp of this live session's most-recent hook event of ANY
   * type. Replaces the old bogus `== started_at` value, which never updated on
   * activity — so it's what makes idle-duration ranking possible at all. Present
   * only for a tracked running worker; drives the In-flight idle-descending sort
   * and the 60s waiting-chip gate. */
  lastActivityAt?: number;
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
  /** Owner-served liveness — present iff the owning daemon runs a live worker
   * for this fiber. The single reconciled liveness observation per fiber. */
  runtime?: CompositeRuntime;
  /** Absolute path to the fiber's own directory on the owning host
   * (`dirname(felt.path)`), owner-resolved. The base a relative `:::{embed}` /
   * image in the body resolves against before the `/file` route reads it.
   * Present for every fiber a current-build daemon serves. */
  dir?: string;
  /** Absolute path to a sibling `report.html`, when the owning daemon resolved
   * one. (Always `<dir>/report.html`; presence is the report-exists signal.) */
  reportPath?: string;
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
    const dir = typeof item.dir === 'string' ? item.dir : undefined;
    const reportPath = typeof item.report_path === 'string' ? item.report_path : undefined;

    entries.push({ origin, feltStore, path, fiber, runtime, dir, reportPath });
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
  if (typeof session !== 'string' || session.length === 0) return undefined;
  const phase = typeof value.phase === 'string' && value.phase.length > 0 ? value.phase : undefined;
  const lastActivityAt = typeof value.last_activity_at === 'number' ? value.last_activity_at : undefined;
  return { tmuxSession: session, phase, lastActivityAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}
