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
 * drawn once here. The views keep only their own snapping — where the anchor
 * falls, which is the part that genuinely differs; how the slip hangs off that
 * anchor is `placeTip`, and is the same rule everywhere.
 *
 * ## The words
 *
 * The activity plane holds no text — a bucket is `{m, s, cwd, k, n}`. For a
 * long time that was the end of it. What changed is not the activity plane but the
 * JOIN: the session ledger pairs a tmux name to a harness session UUID, and the
 * harness writes a transcript under that UUID. `GET /api/v1/moment` reads it.
 * So a mark can now be asked what was said in it, and the note stays for the
 * minutes where nothing answers — an unpaired session, another harness, a
 * transcript that has been cleaned up. THE NOTE IS NOT A PLACEHOLDER. It is the
 * true statement whenever the words are not recovered, and it must never be
 * replaced by an invented sentence.
 *
 * Between the two sits a third answer. A minute of tool work may have said
 * nothing — but the transcript knows WHAT IT DID, and `/api/v1/moment` returns
 * the calls one per line beside whatever was said. Both are drawn, always; the
 * calls in a monospaced, dimmed register precisely because they are not speech.
 * The note appears only when there was nothing else at all.
 *
 * ## The one rule this module exists to enforce
 *
 * A SLIP MAY NEVER CLAIM MORE THAN IT SHOWS. Every count on it counts the
 * items directly beneath it, every cut list says it was cut and how much of it
 * is here, and every register word that names a message is either followed by
 * that message or annotated with the reason it is not. The failure this
 * replaces was structural rather than accidental: the ×N came from the
 * activity plane (a tally of harness hook events for that minute) and the list
 * came from the transcript (the actual tool calls, capped), and the two had no
 * reason on earth to agree — "tool calls ×7" over two lines, "×14" over six,
 * "×12" over none, "agent" over silence. See {@link SlotTipRow.count},
 * {@link TipSection} and {@link reconcileRows}: no builder can now assemble a
 * slip that disagrees with itself, because none of them assembles one by hand.
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


/**
 * The kinds the board draws.
 *
 * `notify` arrives on the wire and is deliberately absent: an idle nudge is
 * not a state of the work. An agent that is genuinely blocked on you already
 * reads as the GAP on a live lane — no wash, no steering tick — and that
 * absence is the truer mark than a hairline nobody could act on.
 */
export type DrawnKind = Exclude<ActivityBucket['k'], 'notify'>

/**
 * What each raster kind means when a person hovers it — the second person,
 * because a tooltip is answering "what was I doing here?".
 *
 * EVERY PHRASE HERE IS A COMPLETE CLAIM ON ITS OWN. Two of them used to be
 * nouns waiting for a number ("tool call", "agent"), and both were false in
 * the same way: the number they took was the activity plane's per-minute
 * EVENT tally, which counts harness hooks — a `pre_tool_use` and its
 * `post_tool_use` are two, a `session_start` is one, a minute filled in
 * between a long call's two ends is one — and never counted tool calls. So
 * "tool calls ×7" was a count of something else entirely, printed above
 * however many calls the transcript happened to return.
 *
 * The kinds now say what the recorded mark actually witnesses: a minute the
 * agent was working in, a minute it finished a turn in, a minute you spoke in.
 * Quantities that a reader can go and check live on the sections below, which
 * count what they list. See {@link SlotTipRow.count}.
 */
export const SLOT_PHRASE: Record<DrawnKind, string> = {
  attention: 'you',
  agent: 'agent working',
  reply: 'agent replied',
}

/**
 * Which kinds' ×N is a count of MESSAGES, and therefore of things the slip can
 * show.
 *
 * `attention` buckets count `user_prompt_submit` events and `reply` buckets
 * count `stop` events — one prompt and one finished turn apiece, each of which
 * is an excerpt the transcript holds. Those counts are joinable, so they may be
 * printed. `agent` is the residue of every other hook and counts nothing a
 * reader could ever be shown.
 */
const MESSAGE_KINDS = new Set<DrawnKind>(['attention', 'reply'])

/**
 * The ×N a row of this kind may print, or undefined for none.
 *
 * ONE FUNCTION, SO THE RULE CANNOT BE FORGOTTEN IN ONE VIEW AND KEPT IN
 * ANOTHER. Day and Week both build rows out of bucket kinds; both used to hand
 * every kind's `n` straight to the renderer.
 */
export function rowCount(kind: DrawnKind, n: number): number | undefined {
  return MESSAGE_KINDS.has(kind) && n > 1 ? n : undefined
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
  /**
   * Rendered `×N` — AND ONLY EVER A COUNT OF THINGS THIS SLIP CAN PRODUCE.
   *
   * That is the whole discipline of this module. A `×N` reads as a promise
   * that N of something are here; when the number came from one place and the
   * list from another, the slip could say "×14" over six lines, or over none,
   * and be lying in a way no reader could diagnose. Any other quantity — a
   * span of minutes, a count of hook events — is prose and belongs in
   * {@link SlotTipRow.note}, where it names its own unit and promises nothing.
   */
  count?: number
  /** A muted qualifier after the phrase: `27 min`, `no text recorded`. Prose,
   *  so it may say anything true; never a bare number. */
  note?: string
  shuttle: boolean
}

/**
 * A list, and how many there were.
 *
 * `total` is never below `items.length` and is the ONLY number allowed beside
 * this list. When they differ the renderer says so in as many words — "showing
 * 6 of 34" — rather than letting six items sit under a claim of thirty-four.
 */
export interface TipSection<T> {
  items: T[]
  total: number
}

export interface SlotTip {
  /**
   * What this slip is ABOUT, when the surface cannot say — a fiber's name over
   * a hollow mark, which stands alone on blank paper with no lane label beside
   * it. The activity marks never carry one: their lane is labelled a few
   * centimetres to the left and has been the whole time the pointer travelled
   * there, and restating it would spend the head line on the one thing the
   * reader can already see.
   */
  title?: string
  /** `14:32–14:36`, the hovered span. */
  time: string
  rows: SlotTipRow[]
  /**
   * WHAT IS KNOWN, plainly — a ledger of label/value pairs read straight off a
   * card. The obligation marks' whole content: they report a commitment rather
   * than a stretch of recorded work, so there is nothing to count and nothing
   * to quote, only facts somebody wrote down. Every value here is a field that
   * exists; a field that is absent contributes no row, because "agent: —" is
   * an answer nobody gave.
   */
  facts?: { label: string; value: string }[]
  /**
   * The register the slip is drawn in. `owed` is the hollow gold of a thing
   * scheduled and not yet done — the pigment its mark already wears on the
   * rail, so the slip and the glyph that summoned it are visibly one thought.
   * Absent is the ordinary parchment slip of recorded work.
   */
  tone?: 'owed'
  /** The recovered words, with the number that were there to recover. */
  said?: TipSection<MomentExcerpt>
  /** What the window DID: one line per tool call (`"Bash — run the tests"`),
   *  with the true call count beside it. Drawn alongside the words rather than
   *  instead of them — a minute that spoke and also ran forty calls is two
   *  facts — and in a register that is visibly not speech: nobody said this,
   *  and a slip that let it read as a quote would be inventing a quote. */
  tools?: TipSection<string>
  /** The older single-string tool report, from a daemon that sends no
   *  `tool_lines`. Drawn as lines, claiming NOTHING about how many there were —
   *  which is exactly what such a daemon can support. */
  toolsText?: string
  /** Where the words live when they could not be read from here — a remote
   *  daemon that is down. Shown instead of the note, because "gone" and
   *  "elsewhere" are different answers. */
  note?: string
  /**
   * The transcript has answered (possibly with nothing). Until it has, the
   * slip states only what the marks recorded and volunteers no absence: "no
   * text recorded" while the fetch is still in flight would be a claim the
   * slip cannot yet make.
   */
  resolved?: boolean
  /** Pinned: every section is showing everything it has, so none of them
   *  invites a pin. */
  pinned?: boolean
}

/** `14:32` in the browser's zone. */
export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

// ── The words, as they were written ──────────────────────────────────────────
//
// A transcript is markdown. It was typed as markdown and it means what markdown
// means, so a card showing `**the mound is too smooth**` with the asterisks
// still in it is showing the source of the sentence rather than the sentence.
//
// THIS IS A SEPARATE RENDERER FROM `renderMarkdown` IN utils.ts, deliberately,
// and the reason is the one thing that matters here: SAFETY BY CONSTRUCTION.
// That renderer runs `marked` over text and hands the result to `innerHTML`
// with raw HTML passing straight through — a considered risk for fiber bodies,
// which the person reading them wrote. Transcript excerpts are a different
// provenance: they are whatever any agent or any tool emitted, and a `<script>`
// in a tool's output must never become a tag. So everything here is ESCAPED
// FIRST and the markup is introduced afterwards, onto text that can no longer
// contain a tag. There is no sanitizer to get wrong, because no unsafe string
// is ever built.
//
// Inline-only is the common case (an excerpt is a line or two), but a PINNED
// card asks the daemon for the untruncated text and gets whole reports back, so
// the block basics have to survive: paragraphs, fenced code, and lists.

/** Where a code span is parked while the rest of the inline grammar runs, so
 *  `**` inside backticks stays two asterisks. NUL cannot occur in the escaped
 *  text (it is stripped on the way in), which is what makes it a safe fence. */
const CODE_SLOT = '\u0000'

/** Inline markup, applied to ALREADY-ESCAPED text. */
function inlineMarkup(escaped: string): string {
  const spans: string[] = []
  // Code first and parked: its content is literal by definition, and running
  // the emphasis rules over it would rewrite the very characters it is quoting.
  let out = escaped.replace(/`([^`]+)`/g, (_, code: string) => {
    spans.push(`<code>${code}</code>`)
    return `${CODE_SLOT}${spans.length - 1}${CODE_SLOT}`
  })

  // A LINK BECOMES ITS TEXT, styled but inert. The card is a quotation inside a
  // tooltip: a live href would be a navigation target in a slip that vanishes
  // when the pointer moves, and on the hover card it cannot even be clicked
  // (`pointer-events: none`). The words are the content; the URL is not.
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]*)\)/g, '<span class="kbn-tip-md-link">$1</span>')

  // Bold before emphasis, or `**x**` is read as an emphasis containing a stray
  // asterisk. Underscores are matched only at word boundaries, so `snake_case`
  // and `__init__` survive as themselves.
  out = out
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])__(?=\S)([\s\S]*?\S)__(?=$|[\s).,;:!?])/g, '$1<strong>$2</strong>')
    .replace(/\*(?=\S)([^*\n]*?\S)\*/g, '<em>$1</em>')
    .replace(/(^|[\s(])_(?=\S)([^_\n]*?\S)_(?=$|[\s).,;:!?])/g, '$1<em>$2</em>')

  return out.replace(
    new RegExp(`${CODE_SLOT}(\\d+)${CODE_SLOT}`, 'g'),
    (_, i: string) => spans[Number(i)] ?? '',
  )
}

/** One block's lines, as a list, when they all open with a bullet or a number. */
function listMarkup(lines: string[]): string | null {
  const bullet = lines.every((l) => /^\s*[-*+]\s+\S/.test(l))
  const ordered = !bullet && lines.every((l) => /^\s*\d+[.)]\s+\S/.test(l))
  if (!bullet && !ordered) return null
  const items = lines
    .map((l) => `<li>${inlineMarkup(l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''))}</li>`)
    .join('')
  return ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`
}

/**
 * A transcript excerpt as HTML: markdown rendered, everything escaped first.
 *
 * Safe for `innerHTML` by construction — see the note above. The only tags in
 * the output are the ones this function writes.
 */
export function renderExcerptMarkdown(text: string): string {
  // NUL is stripped rather than escaped: it is the code-span fence below, and
  // it has no meaning in a transcript.
  const clean = text.replace(/\u0000/g, '')

  const out: string[] = []
  // Fenced code is taken whole, before anything is split on blank lines — a
  // fence may contain them, and a report's code block is the one place where
  // the line breaks are the content.
  const fence = /^```[^\n]*\n([\s\S]*?)^```[ \t]*$/gm
  let at = 0
  const flush = (chunk: string): void => {
    for (const block of chunk.split(/\n{2,}/)) {
      const lines = block.split('\n').filter((l) => l.trim() !== '')
      if (lines.length === 0) continue
      const list = listMarkup(lines)
      // A hard-wrapped paragraph is one paragraph: the newlines inside it are
      // the writer's line width, not their meaning.
      out.push(list ?? `<p>${inlineMarkup(lines.join('\n'))}</p>`)
    }
  }
  for (let m = fence.exec(clean); m !== null; m = fence.exec(clean)) {
    flush(escapeTipHtml(clean.slice(at, m.index)))
    out.push(`<pre><code>${escapeTipHtml(m[1])}</code></pre>`)
    at = m.index + m[0].length
  }
  flush(escapeTipHtml(clean.slice(at)))
  return out.join('')
}

/** The escape every string above passes through before it is allowed near a
 *  tag. Local rather than imported from utils.ts so this module's safety does
 *  not depend on a helper written for a different purpose. */
function escapeTipHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
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
interface ExchangeTurn {
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
  /**
   * Agent work that landed after the last of those turns, if any: when it last
   * happened, how many EVENTS were recorded, and — the number a slip may
   * actually show a reader — how many MINUTES it spans.
   *
   * `count` is kept because it is what the activity plane recorded, and
   * dropping a recorded fact to fix a rendering is the wrong repair. But it is
   * a tally of harness hooks, not of tool calls, and no list of seven things
   * exists to put under a "×7"; `minutes` is a duration, says its own unit, and
   * is the honest form of "it has been busy since". See `magnetTip`.
   */
  toolsAfter: { atMs: number; count: number; minutes: number } | null
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
  let minutes = 0
  for (const mark of marks) {
    if (mark.atMs <= after) continue
    const tools = mark.kinds.find((k) => k.kind === 'agent')?.count ?? 0
    if (tools <= 0) continue
    count += tools
    // One mark is one minute on both rails that call this, so the marks
    // themselves are the duration — no arithmetic on the timestamps, which
    // would have to guess at a grain this function is not told.
    minutes += 1
    if (mark.atMs > atMs) atMs = mark.atMs
  }
  return { turns, toolsAfter: count > 0 ? { atMs, count, minutes } : null }
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

// ── The content contract ─────────────────────────────────────────────────────
//
// EVERY VIEW'S SLIP IS ASSEMBLED THROUGH THESE TWO FUNCTIONS, and that is the
// point. The slip has two kinds of statement on it — what the ACTIVITY PLANE
// recorded (the rows: a minute somebody spoke in, a minute an agent worked in)
// and what the TRANSCRIPT returned (the sections: the words, the calls) — and
// every inconsistency this module has ever shown was one of those two speaking
// for the other. A count taken from the marks, printed over a list taken from
// the transcript. A register word naming a message the words never contained.
//
// So: the rows may only print a number that counts something the sections can
// produce, and the sections carry their own totals and say when they are cut.
// A builder that wants a slip calls `tipContent` for the sections and
// `reconcileRows` for the rows, and cannot get this wrong by hand.

/** The sections of a slip, from whatever the loader recovered. */
export function tipContent(
  words: MomentWords | undefined,
  pinned = false,
): Pick<SlotTip, 'said' | 'tools' | 'toolsText' | 'note' | 'resolved' | 'pinned'> {
  return {
    ...(words?.excerpts.length
      ? { said: { items: words.excerpts, total: words.excerptTotal } }
      : {}),
    ...(words?.toolLines.length
      ? { tools: { items: words.toolLines, total: words.toolTotal } }
      : {}),
    // Only from a daemon with no per-call lines to send. Never both: two
    // renderings of the same calls, one of them uncounted, is the ambiguity
    // this whole shape exists to remove.
    ...(!words?.toolLines.length && words?.toolsText ? { toolsText: words.toolsText } : {}),
    ...(words?.note ? { note: words.note } : {}),
    resolved: words !== undefined,
    pinned,
  }
}

/**
 * The rows, reconciled with what actually came back.
 *
 * NO LABEL WITHOUT ITS CONTENT. A row reading "agent replied" names a message,
 * and a slip that shows the row and not the message has told the reader a word
 * and withheld the thing the word was for. It cannot always be helped — the
 * session may be unpaired, the transcript cleaned up, the harness one that
 * writes no transcript we can read — but it can always be SAID. So once the
 * fetch has answered, a row whose message is not among the excerpts gains the
 * true statement in its place: `agent replied · no text recorded`.
 *
 * Before the fetch answers, nothing is added. "No text recorded" about a
 * request still in flight is not honesty, it is a guess that happens to be
 * wrong for a few hundred milliseconds.
 */
export function reconcileRows(
  rows: readonly SlotTipRow[],
  content: Pick<SlotTip, 'said' | 'resolved'>,
): SlotTipRow[] {
  if (!content.resolved) return [...rows]
  const heard = new Set<DrawnKind>()
  for (const excerpt of content.said?.items ?? []) {
    // Only PROSE answers for a row: the delegation registers are an agent
    // talking to another agent, and neither half is the reply this lane's
    // `stop` event recorded.
    if ((excerpt.kind ?? 'prose') !== 'prose') continue
    if (excerpt.role === 'user') heard.add('attention')
    if (excerpt.role === 'assistant') heard.add('reply')
  }
  return rows.map((row) =>
    MESSAGE_KINDS.has(row.kind) && !heard.has(row.kind)
      ? { ...row, note: row.note ?? 'no text recorded' }
      : row,
  )
}

/** A div with a class and, usually, its text — the shape every node below has. */
function el(tag: string, cls: string, text = ''): HTMLElement {
  const node = document.createElement(tag)
  node.className = cls
  node.textContent = text
  return node
}

/** How a cut section announces itself. `showing 6 of 34 tool calls` — the two
 *  numbers side by side, because the gap between them is the fact. */
function sectionHead(section: TipSection<unknown>, noun: string, pinned: boolean): HTMLElement | null {
  if (section.total > section.items.length) {
    return el('div', 'kbn-tip-sechead', `showing ${section.items.length} of ${section.total} ${noun}` +
      (pinned ? '' : ' · click to pin for all'))
  }
  return section.items.length > 1 ? el('div', 'kbn-tip-sechead', `${noun} ×${section.total}`) : null
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
  // The register rides on the slip, not on the caller: two views draw hollow
  // marks and both must summon the same gold.
  host.classList.toggle('kbn-tip-owed', tip.tone === 'owed')

  if (tip.title) host.append(el('div', 'kbn-tip-title', tip.title))
  if (tip.time) host.append(el('div', 'kbn-tip-time', tip.time))

  if (tip.facts && tip.facts.length > 0) {
    const facts = el('div', 'kbn-tip-facts')
    for (const fact of tip.facts) {
      const row = el('div', 'kbn-tip-fact')
      row.append(
        el('span', 'kbn-tip-factlabel', fact.label),
        el('span', 'kbn-tip-factvalue', fact.value),
      )
      facts.append(row)
    }
    host.append(facts)
  }

  for (const row of tip.rows) {
    // The kind rides on the row, so the register word can take its speaker's
    // colour exactly as the excerpt cards below do. One grammar for "who" on
    // the whole slip, rather than colour in the cards and grey in the summary.
    const line = el('div', `kbn-tip-row kbn-tip-row-${row.kind}`)
    line.append(el(
      'span',
      `kbn-tip-swatch kbn-tip-key-${row.kind}${row.shuttle ? ' kbn-tip-swatch-const' : ''}`,
    ))
    line.append(el('span', 'kbn-tip-phrase', row.phrase))
    if (row.where) line.append(el('span', 'kbn-tip-where', row.where))
    // A count of 1 is what a single event looks like; printing "×1" would make
    // every ordinary minute look like it had been measured. `rowCount` has
    // already refused every count that was not a count of messages.
    if (row.count !== undefined) line.append(el('span', 'kbn-tip-count', `×${row.count}`))
    // The qualifier: a span, a unit, or the admission that the message this
    // row names was not recovered. See `reconcileRows`.
    if (row.note) line.append(el('span', 'kbn-tip-rownote', row.note))
    host.append(line)
  }

  if (tip.said && tip.said.items.length > 0) {
    const said = el('div', 'kbn-tip-said kbn-tip-section')
    const sechead = sectionHead(tip.said, 'messages', tip.pinned ?? false)
    if (sechead) said.append(sechead)
    for (const excerpt of tip.said.items) {
      // A missing kind is prose — that is what every excerpt was before the
      // registers existed, and an older daemon still says it that way.
      const delegated = excerpt.kind === 'spawn' || excerpt.kind === 'return'
      const line = el('div', delegated
        ? `kbn-tip-line kbn-tip-deleg kbn-tip-deleg-${excerpt.kind}`
        : `kbn-tip-line kbn-tip-line-${excerpt.role}`)

      // The header: who + when, on one line, always. `kbn-tip-label` is
      // allowed to truncate before `kbn-tip-when` ever wraps — a reader can
      // lose a long agent name, never the clock.
      const head = el('div', 'kbn-tip-line-head')
      head.append(el('span', 'kbn-tip-label', delegated
        ? DELEGATION_LABEL[excerpt.kind as 'spawn' | 'return']
        : ROLE_LABEL[excerpt.role]))

      // WHO is a separate span from the label: it is the one part of a
      // delegation header that names the other agent. A delegation with no
      // name recoverable simply carries none — the arrow already says which
      // half of the pair it is.
      if (delegated && excerpt.name) head.append(el('span', 'kbn-tip-who', excerpt.name))

      head.append(el('span', 'kbn-tip-when', clockTime(excerpt.at_ms)))
      line.append(head)

      const text = el('span', 'kbn-tip-text')
      // Markdown, rendered — the transcript was written as markdown and means
      // what markdown means. Safe for innerHTML by construction: every string
      // is escaped before any tag is introduced. See `renderExcerptMarkdown`.
      text.innerHTML = renderExcerptMarkdown(excerpt.text)
      line.append(text)

      said.append(line)
    }
    host.append(said)
  }

  // WHAT RAN, alongside whatever was said rather than instead of it. This used
  // to be an `else`: a minute with any prose in it drew its words and stopped,
  // so a turn that spoke once and then made forty tool calls could report the
  // count and never a single name. The two are different facts about the same
  // minute and the card has room for both — the daemon sends both now (see
  // `Shuttle.Moment`), and this draws both.
  //
  // The head is where the honesty lives: `tool calls ×5` when all five are
  // below it, `showing 6 of 34 tool calls · click to pin for all` when they
  // are not. There is no third case, because the section carries its own
  // total and cannot be handed somebody else's.
  //
  // An older daemon sends a single string instead of per-call lines, and it is
  // drawn with NO head: nothing here knows how many calls it stands for, and
  // inventing a number is the bug, not the fix.
  const toolLines = tip.tools?.items.length
    ? tip.tools.items
    : tip.toolsText ? tip.toolsText.split('\n') : null
  if (toolLines) {
    const tools = el('div', 'kbn-tip-tools kbn-tip-section')
    const sechead = tip.tools?.items.length
      ? sectionHead(tip.tools, 'tool calls', tip.pinned ?? false)
      : null
    if (sechead) tools.append(sechead)
    for (const line of toolLines) tools.append(el('div', 'kbn-tip-tools-line', line))
    host.append(tools)
  }

  // NOTHING RECOVERED, AND NOTHING SAID ABOUT IT. The card used to close with
  // "the minute is recorded, not the words" — a gloss explaining the card's own
  // limitation to a reader who had not asked. These cards state facts; a fact
  // nobody has is not one of them, and an empty footer says the same thing
  // without spending a line on saying it.
  //
  // `note` survives because it is not a gloss: it names WHERE the words are
  // ("words live on basalt-login-02"), which is a fact about the fleet and
  // actionable — a different claim from "we have none".
  if (tip.note) host.append(el('div', 'kbn-tip-note kbn-tip-section', tip.note))
}

/** Past this much of the container's width the slip hangs off the anchor's
 *  left instead of its right, so a late minute does not push it off the sheet. */
const TIP_FLIP_FRACTION = 0.62

/** The gap between the anchor and the near edge of the slip, either way round. */
const TIP_GAP_PX = 9

/** The one floating slip element, made once and re-used: `held` unless the
 *  view rebuilt its chart out from under it. */
export function ensureTipHost(parent: HTMLElement | null, held: HTMLElement | null): HTMLElement {
  if (held?.isConnected) return held
  const tip = el('div', 'kbn-tip')
  parent?.append(tip)
  return tip
}

/**
 * Hang the slip off an anchor.
 *
 * `box` is the container the tip is positioned within — the same element it was
 * appended to — measured by the caller, and `anchorX`/`topPx` are already in
 * that box's coordinates. That split is the whole point: WHERE the mark is
 * differs per view (a pointer position, a minute fraction, a slot fraction) and
 * stays with the view; how a slip hangs off it does not, and lives here.
 */
export function placeTip(tip: HTMLElement, box: DOMRect, anchorX: number, topPx: number): void {
  const flip = anchorX > box.width * TIP_FLIP_FRACTION
  tip.style.top = `${topPx}px`
  tip.classList.toggle('kbn-tip-flip', flip)
  tip.style.left = flip ? 'auto' : `${anchorX + TIP_GAP_PX}px`
  tip.style.right = flip ? `${box.width - anchorX + TIP_GAP_PX}px` : 'auto'
}

// ── Fetching the words ───────────────────────────────────────────────────────

/** Long enough that sweeping a pointer down a rail asks for nothing, short
 *  enough that stopping on a mark feels like the tooltip already knew. */
const MOMENT_DEBOUNCE_MS = 150

/** At most this many transcripts per hovered mark — a HOVER bound only. A mark
 *  almost always has one session behind it; a busy slot can have several, and
 *  asking all of them on every sweep would turn one hover into a fan-out.
 *
 *  The cap is a budget, not a priority: which transcripts it spends itself on
 *  is decided by `spoke` — see `MomentLoader.load`. PINNED IS EXEMPT: a pin
 *  is a deliberate request to see everything, and a slip that silently asked
 *  only four of a busy slot's sessions would drop the rest with no "showing X
 *  of Y" to say so — the totals below are summed only over what was asked,
 *  so a source dropped here is a source the slip never even admits missing.
 *  See `MomentLoader.load`. */
const MAX_SOURCES = 4

/** The tooltip holds a few lines, not a conversation. */
const MAX_EXCERPTS = 6

/** A PINNED slip is a conversation — a panel you scroll, not a glance. The
 *  bound survives only so a pathological window cannot become the DOM. */
const MAX_EXCERPTS_PINNED = 200

/**
 * The excerpts a slip shows, human speech first past the cap.
 *
 * Same invariant, one layer down. Merged excerpts were cut to
 * {@link MAX_EXCERPTS} in time order, so a busy window could spend the whole
 * budget on agent prose and delegation reports and drop the one sentence a
 * person typed — again leaving a spine with nothing under it. Human prose is
 * therefore reserved first, and the survivors are put back into time order:
 * what is shown still reads as a conversation, it is only WHICH lines survive
 * that the human half now wins.
 *
 * `user` alone is not the test. A transcript's user records also carry the
 * delegation register (`return` — a subagent's report, a teammate message),
 * which nobody typed; only `prose` is speech.
 */
function pickExcerpts(excerpts: readonly MomentExcerpt[], cap: number): MomentExcerpt[] {
  const human = (e: MomentExcerpt): boolean => e.role === 'user' && (e.kind ?? 'prose') === 'prose'
  const inTime = [...excerpts].sort((a, b) => a.at_ms - b.at_ms)
  const kept = new Set(inTime.filter(human).slice(0, cap))
  for (const e of inTime) {
    if (kept.size >= cap) break
    kept.add(e)
  }
  return inTime.filter((e) => kept.has(e))
}

/**
 * What the loader recovered for one mark — the lists, AND how many there were
 * to recover.
 *
 * THE TOTALS ARE NOT DECORATION. Three separate caps sit between a transcript
 * and this object: the daemon's own (6 excerpts, 6 tool lines on a hover),
 * {@link MAX_SOURCES} on how many transcripts a mark may ask, and
 * {@link pickExcerpts} on the merged result. Every one of them is invisible in
 * the lists alone. Carrying the totals is what lets the slip say "showing 6 of
 * 34" instead of quietly presenting six as all there was.
 */
export interface MomentWords {
  excerpts: MomentExcerpt[]
  /** Messages in the window before any cap — never below `excerpts.length`. */
  excerptTotal: number
  /** One line per tool call, oldest first, cut to this fetch's cap. */
  toolLines: string[]
  /** Calls in the window before that cut. */
  toolTotal: number
  /** The older daemon's single tool string, when it sent no lines. */
  toolsText?: string
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
    // The budget applies to a HOVER's sweep only. A pin is a reader asking to
    // see everything this slot holds, and the daemon's own caps (`@full_cap`,
    // `@full_tool_lines_cap` in moment.ex) are the backstop for that — cutting
    // the source list here as well would drop whole sessions with nothing on
    // the slip to say so, which is the truncation this module exists to make
    // impossible.
    //
    // SPEAKERS FIRST, and that is the invariant this ordering exists for:
    // a mark that draws a spine claims a human message, and the tooltip under it
    // must be able to show that message. The spine is drawn from the attention
    // buckets; the words come from whichever transcripts the cap let through.
    // Cutting the list in arrival order let those two disagree — a Week slot is
    // four minutes wide and routinely pools four sessions, so the session that
    // spoke was often not among the ones asked, and the slip showed agent prose
    // and tool lines under a red spine. Sorting on `spoke` makes the cap cut the
    // silent transcripts first, so every session behind a spine is asked before
    // any session that only worked. Stable, so arrival order still breaks ties
    // within each group.
    const ordered = [...sources.filter((s) => s.spoke), ...sources.filter((s) => !s.spoke)]
    const results = await Promise.all(
      (full ? ordered : ordered.slice(0, MAX_SOURCES))
        .map((source) => this.fetcher(source.session, fromMs, toMs, source.host, full)),
    )
    const merged = results.flatMap((result) => result.excerpts)
    const excerpts = pickExcerpts(merged, full ? MAX_EXCERPTS_PINNED : MAX_EXCERPTS)
    const note = results.find((result) => result.note)?.note

    // EVERYTHING TRAVELS, ALWAYS. This used to be a precedence — words, else
    // tools, else the note — and the first branch was the bug: a minute that
    // said anything at all dropped its tool report on the floor, client-side,
    // after the daemon had gone to the trouble of sending both. That is why
    // the calls sometimes appeared under a hover and sometimes did not, with
    // nothing about the minute to explain which. The renderer draws whichever
    // of them exist; deciding for it was never this function's business.
    //
    // The note is the one thing that stays conditional, because it is a
    // statement about ABSENCE: with words in hand from one host, "words live
    // on <other host>" is no longer the answer to anything.
    const toolLines = results.flatMap((result) => result.toolLines ?? [])
    const legacy = toolLines.length === 0 ? results.find((r) => r.tools)?.tools : undefined
    return {
      excerpts,
      excerptTotal: Math.max(
        excerpts.length,
        // A result with no count is from a daemon that predates the field; its
        // own list is the best total available for it.
        results.reduce((sum, r) => sum + (r.excerptCount ?? r.excerpts.length), 0),
      ),
      toolLines,
      toolTotal: results.reduce((sum, r) => sum + (r.toolCount ?? r.toolLines?.length ?? 0), 0),
      ...(legacy ? { toolsText: legacy } : {}),
      ...(excerpts.length === 0 && note ? { note } : {}),
    }
  }
}

/** The pinned fetch's cache slot for a mark. Two entries per mark, deliberately
 *  — the brief answer and the untruncated one are two different answers about
 *  the same minute, and a pin must not be served the hover's cut text. */
function fullKey(key: string): string {
  return `full:${key}`
}

/** The dedup a caller does before handing sources over: same session on the
 *  same host is one transcript however many buckets pointed at it.
 *
 *  `spoke` is the OR across the copies, not the first one's: a session that
 *  contributed one attention minute and nine agent minutes spoke, whichever
 *  bucket happened to arrive first. Folding it any other way would lose the
 *  very flag the fetch cap sorts on — see `MomentLoader.load`. */
export function dedupeSources(sources: readonly (MomentSource | null)[]): MomentSource[] {
  const seen = new Map<string, MomentSource>()
  const out: MomentSource[] = []
  for (const source of sources) {
    if (!source) continue
    const key = `${source.host ?? ''}\u0000${source.session}`
    const held = seen.get(key)
    if (held) {
      if (source.spoke) held.spoke = true
      continue
    }
    // A copy, so the OR above never writes back into a caller's own object.
    const folded = { ...source }
    seen.set(key, folded)
    out.push(folded)
  }
  return out
}
