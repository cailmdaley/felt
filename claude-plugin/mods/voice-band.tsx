// The live-voice band: one line above the prompt, read from Shuttle's daemon.
//
//   m: ● here | m: ○ → <card> | m: mic muted | m: mic failed   where words go
//   …the words as hark and then Aqua hear them  (only when the mic is here)
//   s: 🔈 <voice>: <line> | paused | n held | speaker muted
//
// With Listening off and the speaker idle, the band is not drawn.
// The mic and speaker labels are buttons: click one, or focus the band
// (ctrl+x tab) and press m or s, to toggle that mute.
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
}
type Speak = {
  available: boolean
  speaking: { fiber_id: string; voice: string; text: string } | null
  held: Record<string, number>
  paused: boolean
  muted: boolean
}

const FAST = 500
const SLOW = 5000

// Module state: a reload starts it over and session.start fills it again.
let base = 'http://127.0.0.1:4000'
let self: string[] = []
let voice: Voice | null = null
let speak: Speak | null = null
let seen = ''
let running = false

const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…')
const clipStart = (s: string, n: number) =>
  s.length <= n ? s : n <= 0 ? '' : '…' + s.slice(s.length - (n - 1))
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

async function poll($: EngineInterface): Promise<boolean> {
  const [v, s] = await Promise.all([get<Voice>($, '/api/v1/voice'), get<Speak>($, '/api/v1/speak')])
  voice = v
  speak = s
  const key = JSON.stringify([v, s])
  if (key !== seen) {
    seen = key
    $.ui.invalidate('ui.render')
  }
  return !!(v?.available || s?.available)
}

async function loop($: EngineInterface): Promise<void> {
  const live = await poll($)
  $.clock.after(live ? FAST : SLOW, () => loop($))
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
    const listening = !!(voice?.available && voice.enabled)

    let mic = 'mic off'
    let micLive = false
    if (listening) {
      if (voice!.muted) mic = 'mic muted'
      else if (voice!.state === 'failed') mic = 'mic failed'
      else if (mine(voice!.target?.fiber_id)) [mic, micLive] = ['● here', true]
      else mic = '○ → ' + clip(voice!.target?.name ?? voice!.target?.fiber_id ?? 'nowhere', 28)
    }

    let words = ''
    if (mine(voice?.pending?.fiber_id)) words = voice!.pending!.text
    else if (mine(voice?.preview?.fiber_id)) words = voice!.preview!.text ?? `${voice!.preview!.words} words…`
    const held = voice?.held?.find(h => mine(h.fiber_id))
    const middle = flat(words || (held ? 'held: ' + held.text : ''))

    let spk = ''
    let spkLive = false
    if (speak?.available) {
      const mineHeld = Object.entries(speak.held ?? {}).reduce((n, [id, k]) => n + (mine(id) ? k : 0), 0)
      if (speak.muted) spk = 'speaker muted'
      else if (speak.speaking) [spk, spkLive] = [`🔈 ${speak.speaking.voice}: ${clip(flat(speak.speaking.text), 40)}`, true]
      else if (speak.paused) spk = '🔈 paused'
      else if (mineHeld) spk = `🔈 ${mineHeld} held`
    }

    if (!listening && !spk) return next(e)
    spk ||= '🔈'
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = e.props.bodyColumns
    const room = width - (mic.length + 3) - (spk.length + 4) - 2

    return (
      <Box flexDirection="row" justifyContent="space-between" width={width}>
        <Button key="mic" hotkey="m" plain dimColor={!micLive} label={mic}
          onPress={() => setMuted($, '/api/v1/voice', !voice?.muted)} />
        <Text dimColor={!words}>{' ' + clipStart(middle, room) + ' '}</Text>
        <Button key="speaker" hotkey="s" plain dimColor={!spkLive} label={spk}
          onPress={() => setMuted($, '/api/v1/speak', !speak?.muted)} />
      </Box>
    )
  })
}
