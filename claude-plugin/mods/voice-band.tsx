// The live-voice band: one dim line above the prompt, read from Shuttle's daemon.
//
//   ▁▂▅▇▃ …the live words, cut at a word from the left        🔈 <voice>
//   🎤 → <card>                                                🔈 paused
//   🎤 muted                                                   🔈 <n> waiting
//                                                              🔈 muted
//
// The words show while the voice target is this session, the mic level's last
// last twenty readings at their left, scrolling; Listening off draws no mic side and an idle
// speaker no speaker side. The mic text and the speaker text are buttons:
// a click, or Enter once the band has the focus (ctrl+x tab), toggles that mute.
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

type Ref = { fiber_id: string; name?: string } | null
type Voice = {
  available: boolean
  enabled: boolean
  muted: boolean
  state: string
  target: Ref
  pending: { fiber_id: string; words: number; text: string } | null
  preview: { fiber_id: string; words: number; text?: string } | null
  held?: { fiber_id: string; text: string }[]
  level?: { mic: number; at: string } | null
}
type Speak = {
  available: boolean
  speaking: { fiber_id: string; name?: string | null; voice: string; text: string } | null
  held: Record<string, number>
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
let placement: 'above' | 'below' = 'below'
let running = false

const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…')
// The tail of `s` that fits in `n`, cut at a word, led by an ellipsis.
function clipWords(s: string, n: number): string {
  if (s.length <= n) return s
  if (n <= 1) return ''
  const tail = s.slice(s.length - (n - 1))
  const space = tail.indexOf(' ')
  return '…' + (space >= 0 && space < tail.length - 1 ? tail.slice(space + 1) : tail)
}
// A level's glyph, -50 dBFS (the gate) to -10, and its theme colour: dim at
// the floor, green through the middle, amber from -20 dBFS.
const step = (db: number) => Math.min(4, Math.max(0, Math.floor(((db + 50) / 40) * 5)))
const tone = (i: number) => (i === 0 ? 'inactive' : i < 3 ? 'success' : 'warning')
// hark's speaker labels (`me:`, `S1:`), wherever a turn starts in the words.
const LABEL = /((?:^|\s)(?:me|S\d+):)/
const here = () => !!(voice?.available && voice.enabled && !voice.muted && mine(voice.target?.fiber_id))
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
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
  if (speak?.available) {
    const waiting = Object.entries(speak.held ?? {}).reduce((n, [id, k]) => n + (mine(id) ? k : 0), 0)
    if (speak.muted) spk = '🔈 muted'
    else if (speak.speaking) spk = '🔈 ' + speak.speaking.voice
    else if (speak.paused) spk = '🔈 paused'
    else if (waiting) spk = `🔈 ${waiting} waiting`
  }
  room -= spk ? spk.length + 3 : 0

  let mic = ''
  let parts: RenderChildren[] = []
  if (voice?.available && voice.enabled) {
    const v = voice
    if (v.muted) mic = '🎤 muted'
    else if (!mine(v.target?.fiber_id)) mic = clip('🎤 → ' + (v.target?.name ?? v.target?.fiber_id ?? 'nowhere'), room)
    else {
      const said = flat(
        (mine(v.pending?.fiber_id) && v.pending!.text) ||
          (mine(v.preview?.fiber_id) && v.preview!.text) ||
          v.held?.find(h => mine(h.fiber_id))?.text ||
          '',
      )
      // A narrow row keeps room for words: the ticker gives way, down to five glyphs, so the words keep twelve columns.
      const steps = levels.slice(-Math.max(5, Math.min(HISTORY, room - 13))).map(step)
      const words = clipWords(said, room - (steps.length ? steps.length + 1 : 0))
      mic = [steps.map(i => GLYPHS[i]).join(''), words].filter(Boolean).join(' ')
      parts = [
        ...steps.map((i, k) => <Text key={`l${k}`} color={tone(i)} dimColor={i === 0}>{GLYPHS[i]}</Text>),
        steps.length && words ? ' ' : '',
        ...words.split(LABEL).filter(Boolean).map((w, k) =>
          LABEL.test(w) ? <Text key={`w${k}`} color="suggestion">{w}</Text> : <Text key={`w${k}`} dimColor>{w}</Text>,
        ),
      ].filter(x => x !== '')
    }
  }
  return { mic, parts: parts.length ? parts : [<Text key="m" dimColor>{mic}</Text>], spk, speaking: !!speak?.speaking && !speak.muted }
}

export const register: Register = (on, options) => {
  placement = options.placement === 'above' ? 'above' : 'below'
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
    const { mic, parts, spk, speaking } = line(width, Text)
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
            {speaking ? <Text color="claude">{spk}</Text> : <Text dimColor>{spk}</Text>}
          </Button>
        ) : null}
      </Box>
    )
  })

  // Below: on the hint row. The engine keeps its mode pill and whatever follows
  // the hint live; the tree stands in for the hint's own text, so it sizes to
  // its content and the voice line follows the hint after a gap.
  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    if (placement !== 'below') return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const room = (e.viewport?.columns ?? 80) - e.props.hint.length - PILLS
    const { mic, parts, spk, speaking } = line(room, Text)
    if (!mic && !spk) return next(e)
    return (
      <Box flexDirection="row">
        <Text dimColor>{e.props.hint}</Text>
        {mic ? (
          <Button key="mic" plain label={mic} onPress={() => setMuted($, '/api/v1/voice', !voice?.muted)}>
            {['  ', ...parts]}
          </Button>
        ) : null}
        {spk ? (
          <Button key="speaker" plain label={spk} onPress={() => setMuted($, '/api/v1/speak', !speak?.muted)}>
            {'  '}{speaking ? <Text color="claude">{spk}</Text> : <Text dimColor>{spk}</Text>}
          </Button>
        ) : null}
      </Box>
    )
  })
}
