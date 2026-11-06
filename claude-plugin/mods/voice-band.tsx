// The live-voice band: one dim line above the prompt, read from Shuttle's daemon.
//
//   ▁▂▅▇▃ …the live words, cut at a word from the left        🔈 <voice>
//   🎤 → <card>                                                🔈 paused
//   🎤 muted                                                   🔈 <n> waiting
//                                                              🔈 muted
//
// The words show while the voice target is this session, the mic level's last
// five readings at their left; Listening off draws no mic side and an idle
// speaker no speaker side. The mic text and the speaker text are buttons:
// a click, or Enter once the band has the focus (ctrl+x tab), toggles that mute.
import type { EngineInterface, Register } from 'claude-code'

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

// Module state: a reload starts it over and session.start fills it again.
let base = 'http://127.0.0.1:4000'
let self: string[] = []
let voice: Voice | null = null
let speak: Speak | null = null
let seen = ''
let levels: number[] = []
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
const glyph = (db: number) => GLYPHS[Math.min(4, Math.max(0, Math.floor(((db + 50) / 40) * 5)))]
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
  levels = here() && v?.level ? [...levels, v.level.mic].slice(-5) : []
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

export const register: Register = on => {
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
    if (e.props.hasSurvey) return next(e)

    let spk = ''
    if (speak?.available) {
      const waiting = Object.entries(speak.held ?? {}).reduce((n, [id, k]) => n + (mine(id) ? k : 0), 0)
      if (speak.muted) spk = '🔈 muted'
      else if (speak.speaking) spk = '🔈 ' + speak.speaking.voice
      else if (speak.paused) spk = '🔈 paused'
      else if (waiting) spk = `🔈 ${waiting} waiting`
    }

    const width = e.props.bodyColumns
    const room = width - (spk ? spk.length + 3 : 0)
    let mic = ''
    if (voice?.available && voice.enabled) {
      const v = voice
      if (v.muted) mic = '🎤 muted'
      else if (!mine(v.target?.fiber_id)) mic = clip('🎤 → ' + (v.target?.name ?? v.target?.fiber_id ?? 'nowhere'), room)
      else {
        const words = flat(
          (mine(v.pending?.fiber_id) && v.pending!.text) ||
            (mine(v.preview?.fiber_id) && v.preview!.text) ||
            v.held?.find(h => mine(h.fiber_id))?.text ||
            '',
        )
        const ticker = levels.map(glyph).join('')
        mic = ticker && words ? ticker + ' ' + clipWords(words, room - ticker.length - 1) : ticker || clipWords(words, room)
      }
    }

    if (!mic && !spk) return next(e)
    const { Box, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" width={width}>
        <Box flexGrow={1}>
          {mic ? (
            <Button key="mic" plain dimColor label={mic}
              onPress={() => setMuted($, '/api/v1/voice', !voice?.muted)} />
          ) : null}
        </Box>
        {spk ? (
          <Button key="speaker" plain dimColor label={spk}
            onPress={() => setMuted($, '/api/v1/speak', !speak?.muted)} />
        ) : null}
      </Box>
    )
  })
}
