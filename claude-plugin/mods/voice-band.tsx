// The Shuttle line, read from Shuttle's daemon: on the prompt's hint row
// (placement `below`) or as a band above the prompt (`above`).
//
//   ⧉ ⌗ ☰ ⚇ → here 12 words · “…and then the other thing” ✕
//   ⧉ ⌗ ☰ ⚆ → here 12 words · sends in 9s ✕
//   ⧉ ⌗ ☰ ⚆ → voice-modes 8 words · asleep, say “send” ✕
//   ⧉ ⌗ ☰ ⚆ → here · ✓ 12 words sent
//   ⧉ ⌗ ☰ ⚆ 📌 → voice-modes
//   ⧉ ⌗ ☰ ⊘
//   ⧉ ⌗ ☰ ○
//
// Pins at the left open this session's family page, tapestry and constitution
// on the board. The audio glyph, drawn in the pins' register, says what the
// mic hears: ⚇ sound arriving, ⚆ open and quiet, ⊘ muted, and a click turns
// Listening off; ○ Listening off, and a click starts it as the board's Listen does.
// `→ here` or `→ <slug>` names where the words go, bright when that is another
// card. `n words` counts what was said and not yet sent, the line in progress
// included. Then what is happening to them: the last words heard while
// speech runs, the seconds until the quiet gap sends them, that the card is
// asleep and takes only words ending in "send", or for ten seconds what became
// of the last batch. A dim red `✕` drops the unsent words.
// With voice unavailable there is no audio side.
import type { EngineInterface, Register } from 'claude-code'

type Ref = { fiber_id: string; name?: string } | null
type Voice = {
  available: boolean
  mode: 'off' | 'following' | 'pinned'
  follow: boolean
  destination: Ref
  paused: boolean
  cold?: boolean
  pending_words?: number
  sends_in_ms?: number | null
  preview?: { text: string } | null
  last?: { at: string; status: 'delivered' | 'unconfirmed' | 'failed'; text?: string } | null
  level?: { mic: number } | null
}
type Page = 'constitution' | 'tapestry' | 'files'

const LIVE = 150 // words come here: the glyph and count move with speech
const FAST = 500
const SLOW = 5000
// dBFS, with hysteresis: speech lights ⚇ above ON, and it holds until the
// level falls below OFF, so room noise stays ⚆ and a phrase doesn't flicker.
const ON = -36
const OFF = -44
let sounding = false
const RECENT = 10_000 // how long the last batch's fate stays on the line
const TAIL = 6 // words of the line in progress shown while speech runs

// Module state: a reload starts it over and session.start fills it again.
let base = 'http://127.0.0.1:4000'
let self: string[] = []
let dir = ''
let voice: Voice | null = null
let now = 0
let tapestry = false
let seen = ''
let placement: 'above' | 'below' = 'above'
let running = false

const mine = (id?: string) => !!id && self.includes(id)
const listening = (v: Voice | null): v is Voice => !!v?.available && v.mode !== 'off'
const here = () => listening(voice) && !voice.paused && mine(voice.destination?.fiber_id)
// The fiber's frontmatter id when it has one, else its path id.
const uid = () => self[self.length - 1]
const slug = (ref: Ref) => (ref?.fiber_id.includes('/') ? ref.fiber_id.split('/').pop() : ref?.name ?? ref?.fiber_id) ?? 'nowhere'

async function get<T>($: EngineInterface, path: string): Promise<T | null> {
  try {
    const r = await $.http.fetch(base + path)
    return r.ok ? (JSON.parse(r.text) as T) : null
  } catch {
    return null
  }
}

const count = (text?: string) => text?.replace(/^\w+: /gm, '').split(/\s+/).filter(Boolean).length ?? 0
const plural = (n: number) => `${n} word${n === 1 ? '' : 's'}`

// What is happening to the words, most pressing first.
function fate(v: Voice, n: number): { text: string; color?: string } | null {
  const partial = v.preview?.text.trim().replace(/[.…\s]+$/, '')
  if (partial) {
    const words = partial.split(/\s+/), tail = words.slice(-TAIL).join(' ')
    // The cut is marked once: a tail that opens on the transcript's own ellipsis keeps it.
    return { text: `“${words.length > TAIL && !/^(…|\.\.)/.test(tail) ? '…' : ''}${tail}”` }
  }
  if (n && v.cold) return { text: 'asleep, say “send”', color: 'warning' }
  if (n && v.sends_in_ms != null) return { text: `sends in ${Math.ceil(v.sends_in_ms / 1000)}s` }
  if (n || !v.last || now - Date.parse(v.last.at) > RECENT) return null
  const said = v.last.text ? plural(count(v.last.text)) : 'words'
  return v.last.status === 'delivered' ? { text: `✓ ${said} sent`, color: 'success' }
    : v.last.status === 'failed' ? { text: `✗ ${said} not sent`, color: 'error' }
    : { text: `? ${said} unconfirmed`, color: 'warning' }
}

function redraw($: EngineInterface): void {
  const v = voice && { ...voice, level: voice.level && voice.level.mic > (sounding ? OFF : ON), sends_in_ms: voice.sends_in_ms != null && Math.ceil(voice.sends_in_ms / 1000) }
  const key = JSON.stringify([v, tapestry, !!voice?.last && now - Date.parse(voice.last.at) <= RECENT])
  if (key === seen) return
  seen = key
  $.ui.invalidate('ui.render')
}

async function poll($: EngineInterface): Promise<number> {
  voice = await get<Voice>($, '/api/v1/voice')
  now = await $.clock.now()
  redraw($)
  return here() ? LIVE : voice?.available ? FAST : SLOW
}

async function loop($: EngineInterface): Promise<void> {
  $.clock.after(await poll($), () => loop($))
}

// The pins' own slow read: whether the fiber has a companion page.
async function pins($: EngineInterface): Promise<void> {
  let found = false
  for (const file of ['tapestry.html', 'artifact.html', 'report.html']) {
    if (await $.fs.exists(`${dir}/${file}`).catch(() => false)) { found = true; break }
  }
  tapestry = found
  redraw($)
  $.clock.after(SLOW, () => pins($))
}

async function post($: EngineInterface, path: string, body?: object): Promise<void> {
  await $.http.fetch(base + path, {
    method: 'POST',
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  await poll($)
}

// The pins and the audio side, or null with nothing to draw.
function line($: EngineInterface, ui: { Box: any; Button: any; Text: any }) {
  const { Box, Button, Text } = ui
  const pin = (page: Page, label: string) => (
    <Box key={page} marginRight={1}>
      <Button key={page} plain dimColor label={label} onPress={() => post($, '/api/v1/board/open', { fiber_id: uid(), page })} />
    </Box>
  )
  const pinned = self.length
    ? [
        pin('files', '⧉'),
        tapestry ? pin('tapestry', '⌗') : null,
        pin('constitution', '☰'),
      ]
    : []

  let audio = null
  if (voice?.available && voice.mode === 'off') {
    audio = (
      <Box flexDirection="row">
        <Button key="mic" plain dimColor label="○" onPress={() => post($, '/api/v1/voice', { enabled: true, muted: false, source: 'desktop' })} />
      </Box>
    )
  } else if (listening(voice)) {
    const v = voice
    const db = v.level?.mic ?? -Infinity
    sounding = db > (sounding ? OFF : ON)
    const glyph = v.paused ? '⊘' : sounding ? '⚇' : '⚆'
    const n = v.paused ? 0 : (v.pending_words ?? 0) + count(v.preview?.text)
    const elsewhere = !mine(v.destination?.fiber_id)
    const pin = !v.follow && v.destination ? '📌 ' : ''
    const where = v.destination && (pin || !v.paused) ? `${pin}→ ${elsewhere ? slug(v.destination) : 'here'}` : ''
    const what = v.paused ? null : fate(v, n)
    audio = (
      <Box flexDirection="row">
        <Button key="mic" plain label={glyph} onPress={() => post($, '/api/v1/voice', { enabled: false })} />
        {where ? <Text key="where" dimColor={!elsewhere}>{` ${where}`}</Text> : null}
        {n ? <Text key="words">{` ${plural(n)}`}</Text> : null}
        {what ? <Text key="fate" dimColor={!what.color} color={what.color} wrap="truncate-end">{` · ${what.text}`}</Text> : null}
        {n ? <Button key="discard" plain label="cancel" onPress={() => { $.ui.toast(`${plural(n)} cancelled`); return post($, '/api/v1/voice/discard') }}>{' '}<Text color="error" dimColor>✕</Text></Button> : null}
      </Box>
    )
  }
  return pinned.length || audio ? { pinned, audio } : null
}

export const register: Register = (on, options) => {
  placement = options.placement === 'below' ? 'below' : 'above'
  on('session.start', async ($, e, next) => {
    base = (await $.env.get('SHUTTLE_DAEMON_URL'))?.replace(/\/+$/, '') || base
    const path = await $.env.get('SHUTTLE_FIBER_PATH')
    if (path) {
      dir = path.slice(0, path.lastIndexOf('/'))
      self = [dir.split('/.felt/').pop()!]
      try {
        const id = /^id:\s*(\S+)/m.exec(await $.fs.read(path))?.[1]
        if (id) self.push(id)
      } catch {}
    }
    if (!running) {
      running = true
      loop($)
      if (self.length) pins($)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (placement !== 'above' || e.props.hasSurvey) return next(e)
    const ui = $.ui.resolve(e)
    const drawn = line($, ui)
    if (!drawn) return next(e)
    const { Box } = ui
    return (
      <Box flexDirection="row" width={e.props.bodyColumns}>
        {drawn.pinned}
        {drawn.audio}
      </Box>
    )
  })

  // Below: on the hint row, in place of the engine's hint text (`shift+tab to
  // cycle`, `esc to interrupt`). The engine keeps its permission-mode pill and
  // its ` · ` separator at the left; no hook or setting removes them.
  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    if (placement !== 'below') return next(e)
    const ui = $.ui.resolve(e)
    const drawn = line($, ui)
    if (!drawn) return next(e)
    const { Box } = ui
    return (
      <Box flexDirection="row">
        {drawn.pinned}
        {drawn.audio}
      </Box>
    )
  })
}
