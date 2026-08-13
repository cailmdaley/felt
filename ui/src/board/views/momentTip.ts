/**
 * The hover tooltip the temporal views share — and the machinery that fills it
 * with real words.
 *
 * ## Why it is one module
 *
 * Week rasters a day into slots; Day draws a lane per fiber. Different marks,
 * different geometry — but the same question when you point at one: *what was
 * happening here?* The answer has the same shape either way (a time span, one
 * line per pigment saying who and how much, then the words), so it is built and
 * drawn once here. The views keep only their own snapping and positioning,
 * which is the part that genuinely differs.
 *
 * ## The words
 *
 * The activity plane holds no text — a bucket is `{m, s, cwd, k, n}`. For a
 * long time that was the end of it, and the tooltip said so
 * ({@link SLOT_NO_TEXT_NOTE}). What changed is not the activity plane but the
 * JOIN: the session ledger pairs a tmux name to a harness session UUID, and the
 * harness writes a transcript under that UUID. `GET /api/v1/moment` reads it.
 * So a mark can now be asked what was said in it, and the note stays for the
 * minutes where nothing answers — an unpaired session, another harness, a
 * transcript that has been cleaned up. THE NOTE IS NOT A PLACEHOLDER. It is the
 * true statement whenever the words are not recovered, and it must never be
 * replaced by an invented sentence.
 *
 * Between the two sits a third answer. A minute of pure tool work said nothing
 * — but the transcript knows WHAT IT DID, and `/api/v1/moment` returns that as
 * `tools` whenever it has no words to return. So the footer has a precedence:
 * the words, else the tools, else the note. The tools text is drawn in a
 * monospaced, dimmed register precisely because it is not speech; the note
 * now appears only when there were neither words nor tools.
 *
 * `tools` itself carries one of two shapes, distinguished only by whether it
 * contains a newline — the daemon decides which, this module just draws
 * whichever arrives. Few enough calls (six or fewer) and it is one call per
 * line, oldest first (`"Bash — run the tests"`); more than that and it is the
 * old single-line aggregate (`"Bash ×2 · Read"`). Either way it is drawn as
 * lines in `.kbn-tip-tools`, never split into a synthetic per-call list here
 * — the daemon already decided how many lines this minute is worth.
 *
 * ## Fetch discipline
 *
 * A pointer crossing a rail passes over dozens of marks. {@link MomentLoader}
 * therefore debounces ({@link MOMENT_DEBOUNCE_MS}), caches by mark, and drops
 * the answer to a mark you have already left. "Abort" here means *ignore*, not
 * *cancel the request*: the fetcher memoizes by argument tuple, so a cancelled
 * in-flight request would poison that memo for every later hover of the same
 * mark. The debounce is what actually stops the traffic; the drop only stops a
 * late answer from painting itself over a tooltip that has moved on.
 *
 * A PIN fetches again with `full`, because the excerpts are truncated on the
 * daemon: the hover's answer already has the ellipsis baked into its strings,
 * so no amount of CSS gets the rest of the sentence back. The two answers are
 * cached under separate keys and the pinned peek falls back to the brief one,
 * which is what makes pinning repaint rather than blank.
 */

import './momentTip.css'
import type { ActivityBucket, MomentExcerpt, MomentResult } from './TemporalData.js'
import type { MomentSource } from './join.js'

export type { MomentSource }

/** The honest note under a tooltip whose words were not recovered.
 *
 *  Reached when the minute's session was never paired in the ledger, ran under
 *  a harness that keeps no readable transcript, or spoke nothing inside the
 *  span — and while a fetch is still out. */
export const SLOT_NO_TEXT_NOTE = 'the minute is recorded, not the words'

/**
 * The kinds the board draws.
 *
 * `notify` arrives on the wire and is deliberately absent: an idle nudge is
 * not a state of the work. An agent that is genuinely blocked on you already
 * reads as the GAP on a live lane — no wash, no steering tick — and that
 * absence is the truer mark than a hairline nobody could act on.
 */
export type DrawnKind = Exclude<ActivityBucket['k'], 'notify'>

/** What each raster kind means when a person hovers it — the second person,
 *  because a tooltip is answering "what was I doing here?". Shares its claims
 *  with `ACTIVITY_KEY_ITEMS`; the wording is closer in. */
export const SLOT_PHRASE: Record<DrawnKind, string> = {
  attention: 'you',
  agent: 'tool call',
  reply: 'agent',
}

/** Strongest signal first — a human steering, then the agent work underneath
 *  it. The order the ink is layered in, read top to bottom. */
export const SLOT_KIND_ORDER: DrawnKind[] = ['attention', 'agent', 'reply']

export interface SlotTipRow {
  /** The pigment this line is about, so the tooltip speaks the rail's colours
   *  rather than restating them in words alone. */
  kind: DrawnKind
  phrase: string
  where: string
  count: number
  shuttle: boolean
}

export interface SlotTip {
  /** `14:32–14:36`, the hovered span. */
  time: string
  rows: SlotTipRow[]
  /** The recovered words, when `/api/v1/moment` found any. Absent means the
   *  renderer falls through to {@link SlotTip.tools}, and then to
   *  {@link SLOT_NO_TEXT_NOTE}. */
  detail?: MomentExcerpt[]
  /** What the minute DID when it said nothing — one call per line
   *  (`"Bash — run the tests"`) when there were few enough to list, else the
   *  aggregate (`"Bash ×2 · Read"`) as a single line; the two are told apart
   *  by whether a `\n` is present. Drawn in place of the words, in a register
   *  that is visibly not speech: nobody said this, and a tooltip that let it
   *  read as a quote would be inventing one. */
  tools?: string
  /** Where the words live when they could not be read from here — a remote
   *  daemon that is down. Shown instead of the note, because "gone" and
   *  "elsewhere" are different answers. */
  note?: string
}

/** `14:32` in the browser's zone. */
export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

// ── Which mark the pointer is asking about ───────────────────────────────────

/** Which mark a pointer resolved to, and how it got there. */
export interface MarkPick {
  /** Index into the positions handed in. */
  index: number
  /**
   * The pointer was in the DEAD ZONE right of the last mark, and the rail
   * caught it. The views draw a quiet highlight on the mark while this is set,
   * so it is visible that the answer is the last thing that happened here
   * rather than something under the pointer.
   */
  magnetized: boolean
}

/**
 * The mark a pointer is asking about: the nearest one within `snapPx`, or —
 * anywhere past the last mark on the rail — the last mark itself.
 *
 * ## Why the right-hand dead zone is a magnet
 *
 * The most common question a lane answers is "what was the last thing that
 * happened here?", and the honest answer sits at one x-coordinate that gets
 * harder to hit the quieter the lane is. On a fiber that stopped at eleven in
 * the morning, the entire afternoon is blank paper that answers nothing, and
 * finding the last mark means pixel-hunting a hairline at the left edge of a
 * lot of nothing. So the blank paper answers instead: everything to the right
 * of the last mark reports that mark.
 *
 * It costs nothing, because that region had no other meaning. Nothing happened
 * there — there is no competing mark for the pointer to be asking about, and
 * hiding the tooltip was never an *answer*, only an absence of one.
 *
 * THE TWO ZONES ABUT EXACTLY and there is no third rule between them. Within
 * `snapPx` of any mark the ordinary snap wins, so a near-miss on the last mark
 * behaves exactly as a near-miss on any other and reads as an ordinary hover;
 * past that, the pointer is unambiguously in empty paper and the magnet takes
 * it. The buffer past the mark is therefore `snapPx` itself rather than a
 * constant of its own — a second number here could only open a gap or an
 * overlap between the two rules.
 *
 * Left of the FIRST mark there is no magnet, deliberately. That region is the
 * part of the day that had not happened yet when the lane began, and "the
 * earliest thing that happened here" is not a question anybody asks of it.
 */
// ── The last exchange ────────────────────────────────────────────────────────

/** A mark on a rail as {@link lastExchange} needs it: when, and what kinds of
 *  event landed in it. Both views' marks reduce to this. */
export interface ExchangeMark {
  atMs: number
  /** The wire's own kind, not {@link DrawnKind}: a caller hands its marks over
   *  as it holds them, and `notify` — which draws nothing anywhere — is simply
   *  a kind this function never asks about. */
  kinds: readonly { kind: ActivityBucket['k']; count: number }[]
}

/** One side of the last exchange — a message, and when it was sent. */
export interface ExchangeTurn {
  /** `attention` is yours, `reply` is the agent's. */
  kind: 'attention' | 'reply'
  atMs: number
}

export interface LastExchange {
  /**
   * The last message each way, IN THE ORDER THEY HAPPENED — the whole point of
   * the structure. Empty when the lane holds no messages at all; one entry when
   * only one side ever spoke.
   */
  turns: ExchangeTurn[]
  /** Tool calls that landed after the last of those turns, if any. */
  toolsAfter: { atMs: number; count: number } | null
}

/**
 * The last thing said on a rail, both ways round.
 *
 * ## Why the ORDER is the content
 *
 * The magnet answers "what was the last thing that happened here?", and for a
 * lane you are orchestrating, the useful form of that question is nearly always
 * *did I get a reply yet, or am I the last word?* Those two states are the same
 * two facts in opposite orders — your message and the agent's — so reporting
 * them in a fixed register order (as an ordinary per-minute tooltip does, via
 * {@link SLOT_KIND_ORDER}) throws away the only bit that distinguishes them.
 * Here the sequence is the message: you-then-agent means it answered, and
 * agent-then-you means it is your turn to be waited on.
 *
 * TOOL CALLS AFTERWARDS ARE A THIRD STATE and not a third turn. An agent that
 * replied and then kept working, and an agent that replied and stopped, look
 * identical if you only report the words; the first is still busy. So calls
 * landing after the last turn are carried separately, with their count, rather
 * than being folded in as another voice — nobody said them.
 *
 * Reads only what was RECORDED: the kinds on the marks, which are the activity
 * plane's own claim about which minutes held a message of yours, a reply, or
 * tool work. It never needs the transcript, so the order and the times are
 * correct even when no words come back at all.
 */
export function lastExchange(marks: readonly ExchangeMark[]): LastExchange {
  const latest = (kind: DrawnKind): number | null => {
    let at: number | null = null
    for (const mark of marks) {
      if (!mark.kinds.some((k) => k.kind === kind && k.count > 0)) continue
      if (at === null || mark.atMs > at) at = mark.atMs
    }
    return at
  }

  const you = latest('attention')
  const agent = latest('reply')
  const turns: ExchangeTurn[] = []
  if (you !== null) turns.push({ kind: 'attention', atMs: you })
  if (agent !== null) turns.push({ kind: 'reply', atMs: agent })
  turns.sort((a, b) => a.atMs - b.atMs)

  // Everything after the last WORD — or, on a lane where nothing was ever said,
  // everything there is. A rail of pure tool work still has a last moment, and
  // "it worked and said nothing" is the honest report of it.
  const after = turns.length > 0 ? turns[turns.length - 1].atMs : -Infinity
  let atMs = -Infinity
  let count = 0
  for (const mark of marks) {
    if (mark.atMs <= after) continue
    const tools = mark.kinds.find((k) => k.kind === 'agent')?.count ?? 0
    if (tools <= 0) continue
    count += tools
    if (mark.atMs > atMs) atMs = mark.atMs
  }
  return { turns, toolsAfter: count > 0 ? { atMs, count } : null }
}

export function pickMark(
  positionsPx: readonly number[],
  x: number,
  snapPx: number,
): MarkPick | null {
  if (positionsPx.length === 0) return null

  let index = -1
  let bestPx = Infinity
  let last = -1
  let lastPx = -Infinity
  positionsPx.forEach((px, i) => {
    const d = Math.abs(px - x)
    if (d < bestPx) {
      bestPx = d
      index = i
    }
    // Read rather than assumed: both callers hand these in ascending order,
    // but the rule is about the RIGHTMOST mark and should say so itself.
    if (px > lastPx) {
      lastPx = px
      last = i
    }
  })

  if (index >= 0 && bestPx <= snapPx) return { index, magnetized: false }
  if (x > lastPx) return { index: last, magnetized: true }
  return null
}

/** How a speaker is named in the entry header: short enough to sit on one
 *  line beside a timestamp with room to spare. Color, not the word, is what
 *  actually carries "who" at a glance (see momentTip.css) — the word is the
 *  fallback for anyone not reading in colour. */
const ROLE_LABEL: Record<MomentExcerpt['role'], string> = {
  user: 'you',
  assistant: 'agent',
  notification: 'note',
}

/**
 * The delegation register's labels — an arrow, because these two lines are
 * the only ones on the slip that have a DIRECTION. A prompt goes out to an
 * agent; a report comes back from one. The role labels cannot say that (they
 * would both read "agent", the parent's own voice), and it is the one thing a
 * reader needs to tell the two halves of a delegation apart at a glance.
 */
const DELEGATION_LABEL: Record<'spawn' | 'return', string> = {
  spawn: '→ spawn',
  return: '← return',
}

/**
 * Draw one tooltip. Rebuilt rather than patched — it is one small subtree, and
 * a hover that moves between marks must never show a stale half of the last
 * one.
 *
 * The shape is the honest shape of what is known: a time span, then one line
 * per pigment, then either the recovered words or the note that they were not.
 */
export function renderTip(host: HTMLElement, tip: SlotTip): void {
  host.textContent = ''

  const when = document.createElement('div')
  when.className = 'kbn-tip-time'
  when.textContent = tip.time
  host.append(when)

  for (const row of tip.rows) {
    const line = document.createElement('div')
    // The kind rides on the row, so the register word can take its speaker's
    // colour exactly as the excerpt cards below do. One grammar for "who" on
    // the whole slip, rather than colour in the cards and grey in the summary.
    line.className = `kbn-tip-row kbn-tip-row-${row.kind}`

    const swatch = document.createElement('span')
    swatch.className =
      `kbn-tip-swatch kbn-tip-key-${row.kind}${row.shuttle ? ' kbn-tip-swatch-const' : ''}`
    line.append(swatch)

    const phrase = document.createElement('span')
    phrase.className = 'kbn-tip-phrase'
    phrase.textContent = row.phrase
    line.append(phrase)

    if (row.where) {
      const where = document.createElement('span')
      where.className = 'kbn-tip-where'
      where.textContent = row.where
      line.append(where)
    }

    // A count of 1 is what a single event looks like; printing "×1" would make
    // every ordinary minute look like it had been measured.
    if (row.count > 1) {
      const count = document.createElement('span')
      count.className = 'kbn-tip-count'
      count.textContent = `×${row.count}`
      line.append(count)
    }
    host.append(line)
  }

  if (tip.detail && tip.detail.length > 0) {
    const said = document.createElement('div')
    said.className = 'kbn-tip-said kbn-tip-section'
    for (const excerpt of tip.detail) {
      // A missing kind is prose — that is what every excerpt was before the
      // registers existed, and an older daemon still says it that way.
      const delegated = excerpt.kind === 'spawn' || excerpt.kind === 'return'
      const line = document.createElement('div')
      line.className = delegated
        ? `kbn-tip-line kbn-tip-deleg kbn-tip-deleg-${excerpt.kind}`
        : `kbn-tip-line kbn-tip-line-${excerpt.role}`

      // The header: who + when, on one line, always. `kbn-tip-label` is
      // allowed to truncate before `kbn-tip-when` ever wraps — a reader can
      // lose a long agent name, never the clock.
      const head = document.createElement('div')
      head.className = 'kbn-tip-line-head'

      const label = document.createElement('span')
      label.className = 'kbn-tip-label'
      label.textContent = delegated
        ? DELEGATION_LABEL[excerpt.kind as 'spawn' | 'return']
        : ROLE_LABEL[excerpt.role]
      head.append(label)

      // WHO is a separate span from the label: it is the one part of a
      // delegation header that names the other agent. A delegation with no
      // name recoverable simply carries none — the arrow already says which
      // half of the pair it is.
      if (delegated && excerpt.name) {
        const who = document.createElement('span')
        who.className = 'kbn-tip-who'
        who.textContent = excerpt.name
        head.append(who)
      }

      const when = document.createElement('span')
      when.className = 'kbn-tip-when'
      when.textContent = clockTime(excerpt.at_ms)
      head.append(when)

      line.append(head)

      const text = document.createElement('span')
      text.className = 'kbn-tip-text'
      text.append(document.createTextNode(excerpt.text))
      line.append(text)

      said.append(line)
    }
    host.append(said)
    return
  }

  // No words. What DID happen is still knowable, and naming the tools beats
  // saying nothing happened to be said. The note survives underneath it, for
  // the minutes where even this is unavailable.
  //
  // `tools` is one line (the aggregate) or several (one call per line); a
  // `\n` split renders either the same way; a lone line never gains an empty
  // sibling because a string with no `\n` splits to a one-element array.
  if (tip.tools) {
    const tools = document.createElement('div')
    tools.className = 'kbn-tip-tools kbn-tip-section'
    for (const line of tip.tools.split('\n')) {
      const row = document.createElement('div')
      row.className = 'kbn-tip-tools-line'
      row.textContent = line
      tools.append(row)
    }
    host.append(tools)
    return
  }

  const foot = document.createElement('div')
  foot.className = 'kbn-tip-note kbn-tip-section'
  foot.textContent = tip.note ?? SLOT_NO_TEXT_NOTE
  host.append(foot)
}

// ── Fetching the words ───────────────────────────────────────────────────────

/** Long enough that sweeping a pointer down a rail asks for nothing, short
 *  enough that stopping on a mark feels like the tooltip already knew. */
export const MOMENT_DEBOUNCE_MS = 150

/** At most this many transcripts per hovered mark. A mark almost always has
 *  one session behind it; a busy slot can have several, and asking all of them
 *  would turn one hover into a fan-out. */
const MAX_SOURCES = 2

/** The tooltip holds a few lines, not a conversation. */
const MAX_EXCERPTS = 6

export interface MomentWords {
  excerpts: MomentExcerpt[]
  /** The tool line for a wordless mark. See {@link SlotTip.tools}. */
  tools?: string
  /** Set when a source could not be read from here — "words live on <host>". */
  note?: string
}

type Fetcher = (
  session: string,
  fromMs: number,
  toMs: number,
  host?: string | null,
  full?: boolean,
) => Promise<MomentResult>

/**
 * Per-hover word fetching: debounced, cached by mark, and deaf to answers for
 * a mark the pointer has left.
 *
 * Usage is two calls. {@link MomentLoader.peek} is synchronous and answers from
 * the cache, so a re-hover paints the words in the same frame as the tooltip.
 * {@link MomentLoader.request} schedules the fetch and calls back exactly once
 * if — and only if — the same mark is still the one being hovered.
 */
export class MomentLoader {
  private readonly cache = new Map<string, MomentWords>()
  private timer: ReturnType<typeof setTimeout> | null = null
  /** The mark a pending or in-flight request belongs to. Cleared on leave, and
   *  compared on arrival: that comparison IS the abort. */
  private pending: string | null = null

  private readonly fetcher: Fetcher
  private readonly debounceMs: number

  constructor(fetcher: Fetcher, debounceMs: number = MOMENT_DEBOUNCE_MS) {
    this.fetcher = fetcher
    this.debounceMs = debounceMs
  }

  /**
   * Words already known for `key`, or undefined.
   *
   * A `full` peek falls back to the brief answer when the untruncated one has
   * not arrived: pinning a mark you were already hovering should paint the
   * words you were reading immediately, and let the full text replace them a
   * moment later — not blank the slip while a second fetch goes out.
   */
  peek(key: string, full = false): MomentWords | undefined {
    if (!full) return this.cache.get(key)
    return this.cache.get(fullKey(key)) ?? this.cache.get(key)
  }

  /**
   * Ask for `key`'s words after the debounce, then hand them to `onWords`.
   *
   * Idempotent per mark: asking again for the mark already pending restarts
   * nothing. A `key` already cached, or one with no sources, never touches the
   * network.
   */
  request(
    key: string,
    sources: readonly MomentSource[],
    fromMs: number,
    toMs: number,
    onWords: (words: MomentWords) => void,
    full = false,
  ): void {
    const cacheKey = full ? fullKey(key) : key
    if (this.pending === cacheKey) return
    this.cancel()
    if (this.cache.has(cacheKey) || sources.length === 0) return
    this.pending = cacheKey
    this.timer = setTimeout(() => {
      this.timer = null
      void this.load(sources, fromMs, toMs, full).then((words) => {
        this.cache.set(cacheKey, words)
        // The pointer may have moved on while this was out; that answer is
        // still worth keeping (it is cached above) but must not be painted.
        if (this.pending !== cacheKey) return
        this.pending = null
        onWords(words)
      })
    }, this.debounceMs)
  }

  /** Stop waiting on whatever was asked for. Called on mouse-leave and on
   *  every move to a different mark. */
  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.pending = null
  }

  private async load(
    sources: readonly MomentSource[],
    fromMs: number,
    toMs: number,
    full: boolean,
  ): Promise<MomentWords> {
    const results = await Promise.all(
      sources
        .slice(0, MAX_SOURCES)
        .map((source) => this.fetcher(source.session, fromMs, toMs, source.host, full)),
    )
    const excerpts = results
      .flatMap((result) => result.excerpts)
      .sort((a, b) => a.at_ms - b.at_ms)
      .slice(0, MAX_EXCERPTS)
    const note = results.find((result) => result.note)?.note
    // Precedence, strongest answer first: what was said, else what was done,
    // else where the words live. A note only earns the footer when there is
    // nothing to show instead — if one host answered and another is down, the
    // words that ARE here are the better answer.
    if (excerpts.length > 0) return { excerpts }
    const tools = results.find((result) => result.tools)?.tools
    if (tools) return { excerpts, tools }
    return { ...(note ? { note } : {}), excerpts }
  }
}

/** The pinned fetch's cache slot for a mark. Two entries per mark, deliberately
 *  — the brief answer and the untruncated one are two different answers about
 *  the same minute, and a pin must not be served the hover's cut text. */
function fullKey(key: string): string {
  return `full:${key}`
}

/** The dedup a caller does before handing sources over: same session on the
 *  same host is one transcript however many buckets pointed at it. */
export function dedupeSources(sources: readonly (MomentSource | null)[]): MomentSource[] {
  const seen = new Set<string>()
  const out: MomentSource[] = []
  for (const source of sources) {
    if (!source) continue
    const key = `${source.host ?? ''} ${source.session}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(source)
  }
  return out
}
