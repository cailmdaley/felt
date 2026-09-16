/**
 * Opening the session a fresh dispatch just started — on a phone, where "open
 * the worker" means navigating to a claude.ai bridge URL rather than raising a
 * terminal.
 *
 * THE TRAP THIS EXISTS TO AVOID. A fiber's tmux session name is
 * `<leaf>-<uid>-shuttle`, keyed on the FIBER's uid — the same string before and
 * after a fresh dispatch. So "find the feed row whose `runningWorker` is this
 * tmux name and follow its `sessionLink`", run against the feed as it stood
 * when the dispatch returned, resolves to the link of the session that was just
 * REPLACED. Tapping "New session" then opened the previous transcript.
 *
 * Two things have to be true before a link is the right one to navigate to:
 * the feed has caught up to the new dispatch, and the daemon has found the new
 * session's bridge record (written 20–30s after launch, so this is a wait, not
 * a lookup). `newSessionLink` is the predicate for "caught up";
 * `waitForNewSessionLink` is the wait around it.
 */

/** What a feed row says about the session currently on a fiber. */
export interface SessionSnapshot {
  /** `shuttle.runtime.session_uuid` — WHICH session. */
  sessionUuid?: string
  /** The claude.ai bridge URL the daemon resolved from that uuid. */
  sessionLink?: string
}

/**
 * What we know about the session we are waiting for.
 *
 * `expectedSessionUuid` is the strong key: the dispatch response carries it for
 * a Claude worker, whose uuid is pre-specified at launch. When it is present,
 * nothing else is consulted — a row whose uuid matches is the new session, and
 * its link was resolved from that uuid.
 *
 * Without it (a codex/pi worker, whose uuid is scraped and backfilled seconds
 * later, or an older daemon), we fall back to difference from what we saw
 * before dispatching.
 */
export interface NewSessionTarget {
  expectedSessionUuid?: string
  previousSessionUuid?: string
  previousSessionLink?: string
}

/**
 * The link to navigate to, or `undefined` while the row still describes the old
 * session (or has no link yet).
 */
export function newSessionLink(
  target: NewSessionTarget,
  row: SessionSnapshot | undefined,
): string | undefined {
  const link = row?.sessionLink
  if (!link) return undefined

  if (target.expectedSessionUuid) {
    return row?.sessionUuid === target.expectedSessionUuid ? link : undefined
  }

  // Fallback: anything still equal to what we saw pre-dispatch is the old
  // session. A row carrying no uuid at all can only be judged by its link.
  if (target.previousSessionUuid && row?.sessionUuid === target.previousSessionUuid) {
    return undefined
  }
  if (target.previousSessionLink && link === target.previousSessionLink) return undefined
  return link
}

export interface WaitForNewSessionOptions {
  target: NewSessionTarget
  /** Refetch the feed and return this fiber's row. Rejections are treated as
   *  "not yet" — a dropped poll on a phone is ordinary. */
  poll: () => Promise<SessionSnapshot | undefined>
  /** Gap between polls. Default 3s — the bridge record lands 20–30s in. */
  intervalMs?: number
  /** Give up after this long. Default 90s. */
  timeoutMs?: number
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/**
 * Poll until the fiber's row belongs to the new session, then return its link.
 * `undefined` on timeout — the worker is running either way, so the caller
 * tells the user that rather than reporting a failure.
 */
export async function waitForNewSessionLink(
  options: WaitForNewSessionOptions,
): Promise<string | undefined> {
  const {
    target,
    poll,
    intervalMs = 3000,
    timeoutMs = 90_000,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
  } = options

  const startedAt = now()

  for (;;) {
    const row = await poll().catch(() => undefined)
    const link = newSessionLink(target, row)
    if (link) return link
    if (now() - startedAt >= timeoutMs) return undefined
    await sleep(intervalMs)
  }
}

/**
 * What the fiber-detail sheet hands the board when a fresh dispatch succeeds:
 * which fiber, the daemon's answer about the session it started, and what the
 * card said about the session it replaced.
 */
export interface NewSessionOpenRequest extends NewSessionTarget {
  fiberId: string
  /** The dispatch response's tmux session — what a fine pointer attaches to. */
  tmuxSession?: string
  /** The card's `originId`: which daemon owns this fiber. */
  shuttleHost?: string
}
