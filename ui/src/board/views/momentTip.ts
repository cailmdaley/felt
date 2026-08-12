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
  attention: 'you prompted',
  agent: 'agent working',
  reply: 'agent replied',
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

/** How a speaker is marked in the tooltip: a nib per voice, no names. Who said
 *  it is a two-way distinction here, and a glyph carries it without spending a
 *  line on it. */
const ROLE_GLYPH: Record<MomentExcerpt['role'], string> = {
  user: '›',
  assistant: '‹',
  notification: '※',
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
    line.className = 'kbn-tip-row'

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
    said.className = 'kbn-tip-said'
    for (const excerpt of tip.detail) {
      const line = document.createElement('div')
      line.className = `kbn-tip-line kbn-tip-line-${excerpt.role}`

      const glyph = document.createElement('span')
      glyph.className = 'kbn-tip-glyph'
      glyph.textContent = ROLE_GLYPH[excerpt.role]
      line.append(glyph)

      const text = document.createElement('span')
      text.className = 'kbn-tip-text'
      text.textContent = excerpt.text
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
    tools.className = 'kbn-tip-tools'
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
  foot.className = 'kbn-tip-note'
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

  /** Words already known for `key`, or undefined. */
  peek(key: string): MomentWords | undefined {
    return this.cache.get(key)
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
  ): void {
    if (this.pending === key) return
    this.cancel()
    if (this.cache.has(key) || sources.length === 0) return
    this.pending = key
    this.timer = setTimeout(() => {
      this.timer = null
      void this.load(key, sources, fromMs, toMs).then((words) => {
        this.cache.set(key, words)
        // The pointer may have moved on while this was out; that answer is
        // still worth keeping (it is cached above) but must not be painted.
        if (this.pending !== key) return
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
    _key: string,
    sources: readonly MomentSource[],
    fromMs: number,
    toMs: number,
  ): Promise<MomentWords> {
    const results = await Promise.all(
      sources
        .slice(0, MAX_SOURCES)
        .map((source) => this.fetcher(source.session, fromMs, toMs, source.host)),
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
