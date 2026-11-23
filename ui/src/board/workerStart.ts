import { HumanMessageIds, repeatNotice } from './humanMessageId.js'
import { dispatchFailureMessage, needsProjectDir, postForceDispatch, type DispatchFailureBody, type PastedImage } from './KanbanModalShared.js'
import { hasWorkerToStop, type KanbanCard } from './KanbanTypes.js'
import type { SessionMode, StartWorker } from './workspace/workerActions.js'

export interface WorkerStartResult {
  ok: boolean
  tmuxSession?: string
  needsProjectDir?: DispatchFailureBody
  error?: string
}

/** Why a start answered 409 delivered nothing, in the words the human acts on. */
export function alreadyRunningMessage(body: { tmux_session?: string; terminal?: string | null }, said: boolean): string {
  if (body.tmux_session && !body.terminal) {
    return `Shuttle holds a worker for this fiber but cannot reach its terminal, so ${said ? 'the message was not sent' : 'nothing opened'}. Stop it, then resume.`
  }
  return said ? 'A worker is already running for this fiber; the message was not sent.' : 'A worker is already running for this fiber.'
}

/**
 * A "New session" over a live worker is a cut: the daemon stamps the
 * clean-exit marker, kills the running session, and starts fresh, discarding
 * whatever in-flight context that worker held. A dormant card cuts nothing, so
 * it is silent; Resume never cuts.
 */
export function cutQuestion(card: KanbanCard): string | null {
  if (!hasWorkerToStop(card)) return null
  const working = card.runtimePhase === 'working' ? ' (actively working)' : ''
  return `A worker is still running for “${card.name}”${working}.\n\n` +
    `Start a new session? This cuts the open session and discards its ` +
    `in-flight context.`
}

/** {@link cutQuestion}, asked in the browser's own dialog. */
export function confirmCut(card: KanbanCard): boolean {
  const question = cutQuestion(card)
  return question === null || window.confirm(question)
}

/**
 * Send one force dispatch (`/api/v1/dispatch`) for `card` with explicit
 * `resume_mode` (`previous`, `fresh`, or `continue`). Returns whether the
 * daemon took it, and any refusal or project-directory prompt the caller
 * should surface.
 */
export async function dispatchWorkerStart(
  shuttleBase: string,
  messageIds: HumanMessageIds,
  card: KanbanCard,
  mode: SessionMode,
  opts: { message?: string; images?: PastedImage[]; projectDir?: string } = {},
): Promise<WorkerStartResult> {
  const message = opts.message ?? ''
  const images = opts.images ?? []
  let res: Response
  try {
    res = await postForceDispatch(shuttleBase, card, {
      user_message: message,
      message_id: messageIds.for([card.originId, card.id, message, ...images.map(image => `${image.name}:${image.data.length}`)].join('\0')),
      resume_mode: mode,
      ...(images.length ? { images } : {}),
      ...(opts.projectDir ? { project_dir: opts.projectDir } : {}),
    })
  } catch (err: unknown) {
    return { ok: false, error: `Shuttle did not answer (${(err as { message?: string })?.message ?? String(err)}). Check the board before trying again.` }
  }
  const body = (await res.json().catch(() => ({}))) as DispatchFailureBody & { tmux_session?: string; terminal?: string | null; duplicate?: boolean; disposition?: string }
  const said = !!message || images.length > 0
  const reachable = res.status === 409 && !!body.tmux_session && !!body.terminal
  if (res.ok || (reachable && !said)) {
    messageIds.sent()
    const notice = repeatNotice(body)
    if (notice) return { ok: false, error: notice }
    return { ok: true, tmuxSession: body.tmux_session }
  }
  if (res.status === 409) return { ok: false, error: alreadyRunningMessage(body, said) }
  if (needsProjectDir(body)) return { ok: false, needsProjectDir: body, error: dispatchFailureMessage(body, `Requeue failed (${res.status})`, res.status) }
  return { ok: false, error: dispatchFailureMessage(body, `Requeue failed (${res.status})`, res.status) }
}

/**
 * Standalone `StartWorker` callback for a page that has no Dock: runs
 * {@link dispatchWorkerStart} with its own {@link HumanMessageIds}, asks the
 * caller before a cut, and reports success or refusal to it.
 */
export function createWorkerStarter(
  shuttleBase: string,
  callbacks: { confirmCut: (card: KanbanCard) => Promise<boolean>; onStarted?: () => void; onError?: (message: string) => void },
): StartWorker {
  const messageIds = new HumanMessageIds()
  let busy = false
  return async (card, mode, message, word, images) => {
    if (busy) return false
    busy = true
    const original = word.textContent ?? ''
    try {
      if (mode === 'fresh' && !await callbacks.confirmCut(card)) return false
      word.textContent = message || images.length ? 'Sending…' : mode === 'previous' ? 'Resuming…' : 'Starting…'
      const result = await dispatchWorkerStart(shuttleBase, messageIds, card, mode, { message, images })
      if (result.ok) {
        callbacks.onStarted?.()
        return true
      }
      if (result.error) callbacks.onError?.(result.error)
      return false
    } finally {
      word.textContent = original
      busy = false
    }
  }
}
