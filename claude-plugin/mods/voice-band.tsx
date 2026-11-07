// The Shuttle line, read from Shuttle's daemon: on the prompt's hint row
// (placement `below`) or as a band above the prompt (`above`).
//
//   ☰ ⌗ ⧉² 🔊 12 words… ✕
//   ☰ ⌗ ⧉² 🔈 → voice-modes · 8 words… ✕
//   ☰ ⌗ ⧉² 🔇
//
// Pins at the left open this session's constitution, tapestry and sent files
// on the board. The audio glyph says what the mic hears: 🔊 sound arriving,
// 🔈 open and quiet, 🔇 muted; a click toggles the mute. `n words…` counts
// what was said but not yet sent, and `✕` drops it; `→ <slug>` names the card
// words go to when it is not this one. Listening off draws no audio side.
import type { EngineInterface, Register } from 'claude-code'

type Ref = { fiber_id: string; name?: string } | null
type Voice = {
  available: boolean
  mode: 'off' | 'following' | 'meeting'
  destination: Ref
  paused: boolean
  pending_words?: number
  level?: { mic: number } | null
}
type Page = 'constitution' | 'tapestry' | 'files'

const LIVE = 150 // words come here: the glyph and count move with speech
const FAST = 500
const SLOW = 5000
const GATE = -50 // dBFS: above it, sound is arriving
const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹'

// Module state: a reload starts it over and session.start fills it again.
let base = 'http://127.0.0.1:4000'
let self: string[] = []
let dir = ''
let voice: Voice | null = null
let tapestry = false
let sent = 0
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

function redraw($: EngineInterface): void {
  const key = JSON.stringify([voice, tapestry, sent])
  if (key === seen) return
  seen = key
  $.ui.invalidate('ui.render')
}

async function poll($: EngineInterface): Promise<number> {
  voice = await get<Voice>($, '/api/v1/voice')
  redraw($)
  return here() ? LIVE : voice?.available ? FAST : SLOW
}

async function loop($: EngineInterface): Promise<void> {
  $.clock.after(await poll($), () => loop($))
}

// The pins' own slow read: whether the fiber has a tapestry, and how many files it sent.
async function pins($: EngineInterface): Promise<void> {
  tapestry = await $.fs.exists(dir + '/tapestry.html').catch(() => false)
  sent = (await get<{ files: unknown[] }>($, '/api/v1/sent-files?uid=' + encodeURIComponent(uid())))?.files.length ?? sent
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
        pin('constitution', '☰'),
        tapestry ? pin('tapestry', '⌗') : null,
        sent ? pin('files', '⧉' + [...String(sent)].map(d => SUP[+d]).join('')) : null,
      ]
    : []

  let audio = null
  if (listening(voice)) {
    const v = voice
    const glyph = v.paused ? '🔇' : (v.level?.mic ?? -Infinity) > GATE ? '🔊' : '🔈'
    const n = v.paused ? 0 : v.pending_words ?? 0
    const where = v.paused || mine(v.destination?.fiber_id) ? '' : ` → ${slug(v.destination)}`
    const words = where + (n ? `${where ? ' ·' : ''} ${n} words…` : '')
    audio = (
      <Box flexDirection="row">
        <Button key="mic" plain label={glyph} onPress={() => post($, '/api/v1/voice/toggle')} />
        {words ? <Text key="words" dimColor>{words}</Text> : null}
        {n ? <Button key="discard" plain dimColor label=" ✕" onPress={() => post($, '/api/v1/voice/discard')} /> : null}
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
