// The live-voice line, read from Shuttle's daemon: on the prompt's hint row
// (placement `below`) or as a band above the prompt (`above`).
//
//   ▁▁▂▅▇▅▃▂▁▁▁▁▁▁▁▁▁▁▁▁                                       🔈 <voice>
//   🎤 → <card>                                                🔈 paused
//   ● meeting → <card>                                         🔈 <n> waiting
//   🎤 paused                                                  🔈 muted
//                                                    🔈 Civbench 2, felt debug 1 +1
//
// The mic side says what holds the mic: following (🎤) the card in view, or a
// meeting (●) joined to one card. While words come to this session it is the
// level ticker, its last twenty readings scrolling left; Listening off draws no mic side and
// an idle speaker no speaker side. Lines other cards hold until they are in
// view follow the speaker's state, named, the two with most first. The mic and speaker texts are buttons: a
// click, or Enter once the band has the focus (ctrl+x tab), toggles that mute;
// a meeting pauses from the board.
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

type Ref = { fiber_id: string; name?: string } | null
type Voice = {
  available: boolean
  enabled: boolean
  muted: boolean
  state: string
  target: Ref
  /** What holds the mic, where words go now, and whether it is paused. */
  mode?: 'off' | 'following' | 'meeting'
  destination?: Ref
  paused?: boolean
  level?: { mic: number; at: string } | null
}
type Held = { fiber_id: string; origin?: string | null; name?: string | null; n: number }
type Speak = {
  available: boolean
  speaking: { fiber_id: string; name?: string | null; voice: string; text: string } | null
  held: Held[]
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
const modeOf = (v: Voice) => v.mode ?? (v.enabled ? 'following' : 'off')
const destinationOf = (v: Voice) => (v.mode ? v.destination : v.target) ?? null
const pausedOf = (v: Voice) => v.paused ?? v.muted
const here = () => !!(voice?.available && modeOf(voice) !== 'off' && !pausedOf(voice) && mine(destinationOf(voice)?.fiber_id))
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

async function reveal($: EngineInterface, card: Held): Promise<void> {
  await $.http.fetch(base + '/api/v1/voice/reveal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(card.origin ? { fiber_id: card.fiber_id, origin: card.origin } : { fiber_id: card.fiber_id }),
  })
  await poll($)
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
  let state = ''
  let chips: Held[] = []
  let more = 0
  if (speak?.available) {
    const held = speak.held ?? []
    const waiting = held.reduce((n, card) => n + (mine(card.fiber_id) ? card.n : 0), 0)
    if (speak.muted) state = '🔈 muted'
    else if (speak.speaking) state = '🔈 ' + speak.speaking.voice
    else if (speak.paused) state = '🔈 paused'
    else if (waiting) state = `🔈 ${waiting} waiting`
    // Lines other cards hold until they are in view: the two with most, then +n.
    const others = held.filter(card => !mine(card.fiber_id)).sort((a, b) => b.n - a.n)
    chips = others.slice(0, 2)
    more = others.length - chips.length
    if (chips.length && !state) state = '🔈'
  }
  const chipText = (card: Held) => `${clip(card.name || card.fiber_id.split('/').pop()!, 20)} ${card.n}`
  const spk = [state, chips.map(chipText).join(', ') + (more ? ` +${more}` : '')]
    .filter(Boolean)
    .join(state === '🔈' ? ' ' : ' · ')
  room -= spk ? spk.length + 3 : 0

  let mic = ''
  let parts: RenderChildren[] = []
  if (voice?.available && modeOf(voice) !== 'off') {
    const v = voice
    const meeting = modeOf(v) === 'meeting'
    const dest = destinationOf(v)
    const glyph = meeting ? '● meeting' : '🎤'
    if (pausedOf(v)) mic = `${glyph} paused`
    else if (!mine(dest?.fiber_id)) mic = clip(`${glyph} → ` + (dest?.name ?? dest?.fiber_id ?? 'nowhere'), room)
    else {
      const steps = levels.map(step)
      mic = (meeting ? '● ' : '') + steps.map(i => GLYPHS[i]).join('')
      parts = [
        ...(meeting ? [<Text key="rec" color="error">● </Text>] : []),
        ...steps.map((i, k) => <Text key={`l${k}`} color={tone(i)} dimColor={i === 0}>{GLYPHS[i]}</Text>),
      ]
    }
  }
  return {
    mic,
    parts: parts.length ? parts : [<Text key="m" dimColor>{mic}</Text>],
    spk,
    state,
    chips: chips.map(card => ({ card, text: chipText(card) })),
    more,
  }
}

// The speaker side: its state mutes the speaker on a press, and each held
// card's chip opens that card, as a click on the board does.
function speakerSide(
  $: EngineInterface,
  ui: { Box: any; Button: any; Text: any },
  side: { state: string; chips: { card: Held; text: string }[]; more: number },
) {
  const { Box, Button, Text } = ui
  const speaking = !!speak?.speaking && !speak.muted
  const sep = side.state === '🔈' ? ' ' : ' · '
  return (
    <Box flexDirection="row">
      {side.state ? (
        <Button key="speaker" plain label={side.state} onPress={() => setMuted($, '/api/v1/speak', !speak?.muted)}>
          <Text color={speaking ? 'claude' : undefined} dimColor={!speaking}>{side.state}</Text>
        </Button>
      ) : null}
      {side.chips.flatMap(({ card, text }, k) => [
        <Text key={`sep${k}`} dimColor>{k ? ', ' : sep}</Text>,
        <Button key={`held:${card.fiber_id}`} plain dimColor label={text} onPress={() => reveal($, card)} />,
      ])}
      {side.more ? <Text key="more" dimColor>{` +${side.more}`}</Text> : null}
    </Box>
  )
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
    const side = line(width, Text)
    const { mic, parts, spk } = side
    if (!mic && !spk) return next(e)
    return (
      <Box flexDirection="row" width={width}>
        <Box flexGrow={1}>
          {mic ? (
            <Button key="mic" plain label={mic} onPress={() => voice && modeOf(voice) === 'following' && setMuted($, '/api/v1/voice', !voice.muted)}>
              {parts}
            </Button>
          ) : null}
        </Box>
        {spk ? speakerSide($, { Box, Button, Text }, side) : null}
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
    const side = line(room, Text)
    const { mic, parts, spk } = side
    if (!mic && !spk) return next(e)
    return (
      <Box flexDirection="row">
        {mic ? (
          <Button key="mic" plain label={mic} onPress={() => voice && modeOf(voice) === 'following' && setMuted($, '/api/v1/voice', !voice.muted)}>
            {parts}
          </Button>
        ) : null}
        {mic && spk ? <Text dimColor>{'  '}</Text> : null}
        {spk ? speakerSide($, { Box, Button, Text }, side) : null}
      </Box>
    )
  })
}
