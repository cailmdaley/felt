// The live-voice band: one line above the prompt, read from Shuttle's daemon.
//
//   m: 🎤  <the words as hark and then Aqua hear them>   s: 🔈
//   m: 🎤 → <card>        the mic is fixed on another card
//   m: 🎤 muted
//                                  s: 🔈 <card>: <line> | paused | n held | muted
//
// With Listening off the mic side is not drawn, and with the speaker idle too
// the band is not drawn at all. The 🎤 and 🔈 labels are buttons: click one, or
// focus the band (ctrl+x tab) and press m or s, to toggle that mute.
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
  speaking: { fiber_id: string; name?: string | null; voice: string; text: string } | null
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

    let mic = ''
    let words = ''
    if (listening) {
      const v = voice!
      if (v.muted) mic = '🎤 muted'
      else if (!mine(v.target?.fiber_id)) mic = '🎤 → ' + clip(v.target?.name ?? v.target?.fiber_id ?? 'nowhere', 32)
      else {
        mic = '🎤'
        if (mine(v.pending?.fiber_id)) words = v.pending!.text
        else if (mine(v.preview?.fiber_id)) words = v.preview!.text ?? `${v.preview!.words} words…`
        else words = v.held?.find(h => mine(h.fiber_id))?.text ?? ''
      }
    }

    let spk = ''
    if (speak?.available) {
      const mineHeld = Object.entries(speak.held ?? {}).reduce((n, [id, k]) => n + (mine(id) ? k : 0), 0)
      const who = speak.speaking && (speak.speaking.name || speak.speaking.voice)
      if (speak.muted) spk = '🔈 muted'
      else if (speak.speaking) spk = `🔈 ${clip(who!, 20)}: ${clip(flat(speak.speaking.text), 40)}`
      else if (speak.paused) spk = '🔈 paused'
      else if (mineHeld) spk = `🔈 ${mineHeld} held`
    }

    if (!listening && !spk) return next(e)
    spk ||= '🔈'
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = e.props.bodyColumns
    const room = width - (mic ? mic.length + 4 : 0) - (spk.length + 4) - 2

    return (
      <Box flexDirection="row" justifyContent="space-between" width={width}>
        {mic ? (
          <Button key="mic" hotkey="m" plain dimColor={mic !== '🎤'} label={mic}
            onPress={() => setMuted($, '/api/v1/voice', !voice?.muted)} />
        ) : null}
        <Text>{' ' + clipStart(flat(words), room) + ' '}</Text>
        <Button key="speaker" hotkey="s" plain dimColor={!speak?.speaking} label={spk}
          onPress={() => setMuted($, '/api/v1/speak', !speak?.muted)} />
      </Box>
    )
  })
}
