// The live-voice line, read from Shuttle's daemon: on the prompt's hint row
// (placement `below`) or as a band above the prompt (`above`).
//
//   ▁▁▂▅▇▅▃▂▁▁▁▁▁▁▁▁▁▁▁▁                                       🔈 <voice>
//   🎤 → <card>                                                🔈 paused
//   🎤 muted                                                   🔈 <n> waiting
//                                                              🔈 muted
//                                                    🔈 Civbench 2, felt debug 1 +1
//
// While the voice target is this session the mic side is the level ticker,
// its last twenty readings scrolling left; Listening off draws no mic side and
// an idle speaker no speaker side. Lines other cards hold until they are in
// view follow the speaker's state, named, the two with most first. The mic and speaker texts are buttons: a
// click, or Enter once the band has the focus (ctrl+x tab), toggles that mute.
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

type Ref = { fiber_id: string; name?: string } | null
type Voice = {
  available: boolean
  enabled: boolean
  muted: boolean
  state: string
  target: Ref
  level?: { mic: number; at: string } | null
}
type Held = { fiber_id: string; name?: string | null; n: number }
type Speak = {
  available: boolean
  speaking: { fiber_id: string; name?: string | null; voice: string; text: string } | null
  // A list of held cards; the map with held_names is the daemon's older shape.
  held: Held[] | Record<string, number>
  held_names?: Record<string, string | null>
  paused: boolean
  muted: boolean
}

const LIVE = 150 // the mic is here: the level ticker moves
const FAST = 500
const SLOW = 5000
const GLYPHS = '▁▂▃▅▇'
const HISTORY = 20 // ticker readings kept: about 3 s at the live poll, so a phrase leaves a shape
const PILLS = 26 // the hint row's margin, mode label and separator (`  ⏵⏵ auto mode on · `, ~20), with slack; the API does not measure it

// Module state: a reload starts it over and session.start fills it again.
let base = 'http://127.0.0.1:4000'
let self: string[] = []
let voice: Voice | null = null
let speak: Speak | null = null
let seen = ''
let levels: number[] = []
let placement: 'above' | 'below' = 'above'
let running = false

const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…')
// A level's glyph, -50 dBFS (the gate) to -10, and its theme colour: dim at
// the floor, green through the middle, amber from -20 dBFS.
const step = (db: number) => Math.min(4, Math.max(0, Math.floor(((db + 50) / 40) * 5)))
const tone = (i: number) => (i === 0 ? 'inactive' : i < 3 ? 'success' : 'warning')
const here = () => !!(voice?.available && voice.enabled && !voice.muted && mine(voice.target?.fiber_id))
const heldList = (s: Speak): Held[] =>
  Array.isArray(s.held)
    ? s.held
    : Object.entries(s.held ?? {}).map(([fiber_id, n]) => ({ fiber_id, n, name: s.held_names?.[fiber_id] }))
const mine = (id?: string) => !!id && self.includes(id)

async function get<T>($: EngineInterface, path: string): Promise<T | null> {
  try {
    const r = await $.http.fetch(base + path)
    return r.ok ? (JSON.parse(r.text) as T) : null
  } catch {
    return null
  }
}

async function poll($: EngineInterface): Promise<number> {
  const [v, s] = await Promise.all([get<Voice>($, '/api/v1/voice'), get<Speak>($, '/api/v1/speak')])
  voice = v
  speak = s
  levels = here() && v?.level ? [...levels, v.level.mic].slice(-HISTORY) : []
  const key = JSON.stringify([v, s, levels])
  if (key !== seen) {
    seen = key
    $.ui.invalidate('ui.render')
  }
  return here() ? LIVE : v?.available || s?.available ? FAST : SLOW
}

async function loop($: EngineInterface): Promise<void> {
  $.clock.after(await poll($), () => loop($))
}

async function setMuted($: EngineInterface, path: string, muted: boolean): Promise<void> {
  await $.http.fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ muted }),
  })
  await poll($)
}

// What the voice line says now: the mic side as plain text and as coloured
// parts, and the speaker side; empty strings where a side has nothing.
function line(room: number, Text: any) {
  let spk = ''
  let held = ''
  if (speak?.available) {
    const held_ = heldList(speak)
    const waiting = held_.reduce((n, h) => n + (mine(h.fiber_id) ? h.n : 0), 0)
    if (speak.muted) spk = '🔈 muted'
    else if (speak.speaking) spk = '🔈 ' + speak.speaking.voice
    else if (speak.paused) spk = '🔈 paused'
    else if (waiting) spk = `🔈 ${waiting} waiting`
    // Lines other cards hold until they are in view: the two with most, then +n.
    const others = held_.filter(h => !mine(h.fiber_id)).sort((a, b) => b.n - a.n)
    if (others.length) {
      const named = others
        .slice(0, 2)
        .map(h => `${clip(h.name || h.fiber_id.split('/').pop()!, 20)} ${h.n}`)
        .join(', ')
      held = named + (others.length > 2 ? ` +${others.length - 2}` : '')
    }
  }
  const speaking = !!speak?.speaking && !speak.muted
  const spkParts: RenderChildren[] = [
    spk ? <Text key="s" color={speaking ? 'claude' : undefined} dimColor={!speaking}>{spk}</Text> : '',
    held ? <Text key="h" dimColor>{spk ? ' · ' + held : '🔈 ' + held}</Text> : '',
  ].filter(x => x !== '')
  spk = spk && held ? `${spk} · ${held}` : spk || (held && '🔈 ' + held)
  room -= spk ? spk.length + 3 : 0

  let mic = ''
  let parts: RenderChildren[] = []
  if (voice?.available && voice.enabled) {
    const v = voice
    if (v.muted) mic = '🎤 muted'
    else if (!mine(v.target?.fiber_id)) mic = clip('🎤 → ' + (v.target?.name ?? v.target?.fiber_id ?? 'nowhere'), room)
    else {
      const steps = levels.map(step)
      mic = steps.map(i => GLYPHS[i]).join('')
      parts = steps.map((i, k) => <Text key={`l${k}`} color={tone(i)} dimColor={i === 0}>{GLYPHS[i]}</Text>)
    }
  }
  return { mic, parts: parts.length ? parts : [<Text key="m" dimColor>{mic}</Text>], spk, spkParts }
}

export const register: Register = (on, options) => {
  placement = options.placement === 'below' ? 'below' : 'above'
  on('session.start', async ($, e, next) => {
    base = (await $.env.get('SHUTTLE_DAEMON_URL'))?.replace(/\/+$/, '') || base
    const path = await $.env.get('SHUTTLE_FIBER_PATH')
    if (path) {
      self = [path.split('/.felt/').pop()!.split('/').slice(0, -1).join('/')]
      try {
        const id = /^id:\s*(\S+)/m.exec(await $.fs.read(path))?.[1]
        if (id) self.push(id)
      } catch {}
    }
    if (!running) {
      running = true
      loop($)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (placement !== 'above' || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const width = e.props.bodyColumns
    const { mic, parts, spk, spkParts } = line(width, Text)
    if (!mic && !spk) return next(e)
    return (
      <Box flexDirection="row" width={width}>
        <Box flexGrow={1}>
          {mic ? (
            <Button key="mic" plain label={mic} onPress={() => setMuted($, '/api/v1/voice', !voice?.muted)}>
              {parts}
            </Button>
          ) : null}
        </Box>
        {spk ? (
          <Button key="speaker" plain label={spk} onPress={() => setMuted($, '/api/v1/speak', !speak?.muted)}>
            {spkParts}
          </Button>
        ) : null}
      </Box>
    )
  })

  // Below: on the hint row, in place of the engine's hint text (`shift+tab to
  // cycle`, `esc to interrupt`). The engine keeps its permission-mode pill and
  // its ` · ` separator at the left; no hook or setting removes them.
  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    if (placement !== 'below') return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const room = (e.viewport?.columns ?? 80) - PILLS
    const { mic, parts, spk, spkParts } = line(room, Text)
    if (!mic && !spk) return next(e)
    return (
      <Box flexDirection="row">
        {mic ? (
          <Button key="mic" plain label={mic} onPress={() => setMuted($, '/api/v1/voice', !voice?.muted)}>
            {parts}
          </Button>
        ) : null}
        {spk ? (
          <Button key="speaker" plain label={spk} onPress={() => setMuted($, '/api/v1/speak', !speak?.muted)}>
            {[mic ? '  ' : '', ...spkParts].filter(x => x !== '')}
          </Button>
        ) : null}
      </Box>
    )
  })
}
