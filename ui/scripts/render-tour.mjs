/**
 * Render the narrated Shuttle board tour from the committed documentation
 * screenshots. Run npm run video:docs from ui/; it needs ffmpeg and a local
 * Pocket TTS server (`pocket-tts serve --port 8321`).
 *
 * The tour teaches the board's actions. Controls the screenshots show (the
 * Drafts plus, the In flight star, Aloft, Temper and Discard) are zoomed and
 * ringed on docs/assets/shuttle-board-example.png. Controls no screenshot
 * shows (the Stash and New idea dialogs, a card's drawer, the Meeting menu)
 * appear as control guides: diagrams drawn here with ffmpeg, whose labels come
 * from ui/src/forms/StashForm.tsx, CaptureForm.tsx, meetingApi.ts and
 * ui/src/board/workspace/Dock.ts, and which say on screen that they are not
 * screenshots. Nothing is captured from a live board.
 *
 * Each scene's narration is a list of sentences. Every sentence is spoken by
 * a built-in Pocket TTS voice (TOUR_VOICE, default alba), trimmed of edge
 * silence and measured; the measured lengths set the scene's timing, its
 * rings and the WebVTT cue for that sentence, so editing a sentence cannot
 * drift the captions. Generated speech is cached by voice and text under
 * TOUR_TTS_CACHE (default: the system temp directory), and the assembled
 * track is loudness-normalized to -16 LUFS, -1.5 dBTP. The same sentences
 * become the transcript between the tour-transcript markers in docs/index.md
 * and docs/shuttle/index.md.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const assets = join(root, 'docs/assets')
const pages = [join(root, 'docs/index.md'), join(root, 'docs/shuttle/index.md')]
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe'
const VOICE = process.env.TOUR_VOICE || 'alba'
const TTS_URL = process.env.TOUR_TTS_URL || 'http://localhost:8321/tts'
const CACHE = process.env.TOUR_TTS_CACHE || join(tmpdir(), 'shuttle-tour-tts')

const W = 1280, H = 720, FPS = 30
const SRC_W = 1440, SRC_H = 810 // screenshots are 1440×760, padded to 16:9
const UP = 4                      // upsampling before the camera, for smooth motion
const FADE = 0.4
const LEAD = 0.6, GAP = 0.45, TAIL = 0.8 // seconds of quiet around and between sentences
const MOVE = 2.2                  // seconds the camera takes to reach its target
// Every segment is tagged alike, or concat mis-converts the ones after a full-range JPEG.
const COLOR = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']
const PAPER = '0xEAE0CC', INK = '0x2E2A26', RUST = '0xC2410C'
const CARD = '0xFBF6EC', RULE = '0xD8C7A3', FIELD = '0xFFFDF8', MUTED = `${INK}@0.55`
const OCHRE = '0xB98A22', COBALT = '0x3B5BA5', VERDIGRIS = '0x2F7A63', MADDER = '0xB04A3C'

const pick = (env, candidates) => {
  const found = [process.env[env], ...candidates].find(path => path && existsSync(path))
  if (!found) throw new Error(`no font found; set ${env} to a .ttf/.otf/.ttc file`)
  return found
}
const SANS = pick('TOUR_SANS_FONT', [
  '/System/Library/Fonts/Avenir Next.ttc',
  '/System/Library/Fonts/Helvetica.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
])
const SERIF = pick('TOUR_SERIF_FONT', [
  '/System/Library/Fonts/Supplemental/Georgia.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',
])
const MONO = pick('TOUR_MONO_FONT', [
  '/System/Library/Fonts/Menlo.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
])

/** A camera rectangle on the padded 1440×810 screenshot: left, top and width; height follows 16:9. */
const at = (x, y, w) => ({ x, y, w })
const FULL = at(0, 0, SRC_W)
// Screenshot coordinates are offset by the 25 px pad above the 760 px image.
const shot = (x, y, w, h) => ({ x, y: y + 25, w, h })

// Control-guide vocabulary, in 1280×720 frame coordinates.
const rect = (x, y, w, h, fill, line, t = 2) => ({ rect: true, x, y, w, h, fill, line, t })
const text = (x, y, value, o = {}) => ({ x, y, value, size: 18, font: SANS, color: INK, ...o })
const label = (x, y, value) => text(x, y, value, { font: MONO, size: 13, color: MUTED })
const field = (x, y, w, h, value, o = {}) => [rect(x, y, w, h, FIELD, RULE), text(x + 14, y + (h - 24) / 2, value, { size: 18, ...o })]
const TONES = {
  plain: { fill: CARD, line: `${INK}@0.35`, color: INK },
  ochre: { fill: OCHRE, color: '0xFFFDF8' },
  cobalt: { fill: COBALT, color: '0xFFFDF8' },
  send: { fill: '0xE9EEF8', line: COBALT, color: COBALT },
  temper: { fill: '0xE4EFE8', line: VERDIGRIS, color: VERDIGRIS },
  discard: { fill: '0xF8E9E4', line: MADDER, color: MADDER },
}
const button = (x, y, w, h, value, tone = 'plain', o = {}) => {
  const t = TONES[tone]
  return [rect(x, y, w, h, t.fill, t.line), text(x, y + (h - 26) / 2, value, { font: SERIF, size: 19, color: t.color, center: w, ...o })]
}
const panel = (x, y, w, h) => rect(x, y, w, h, CARD, RULE)
const guideHead = (title) => [
  text(60, 34, 'CONTROL GUIDE', { font: MONO, size: 15, color: RUST }),
  text(60, 58, title, { font: SERIF, size: 32 }),
  text(60, 104, 'Drawn from the board’s source code to show its labels — not a screenshot.', { size: 16, color: MUTED }),
]
const ring = (x, y, w, h, during) => ({ x, y, w, h, during })

/**
 * The tour. A scene is a title card, a shot (a camera on a screenshot) or a
 * guide (a drawn diagram); `say` is its narration, one caption per sentence,
 * and `shows` describes the picture for the transcript. A ring's `during`
 * lists the sentences it is drawn through; without it, the ring stays on.
 */
const scenes = [
  { card: true, title: 'The Shuttle board', lines: ['What each button does', 'Screenshots of the real board over a fictional workshop, and control guides'],
    shows: 'Title card.',
    say: ['Here is the Shuttle board, and how to use its main controls.'] },
  { image: 'shuttle-board-example.png', from: FULL, to: at(10, 12, 1420), move: 6,
    shows: 'The Desk screenshot, with fictional workshop tasks in Drafts, In flight and Awaiting review.',
    say: ['These Desk lanes show drafts not yet started, work in flight, and results awaiting your review.'] },
  { image: 'shuttle-board-example.png', from: at(10, 12, 1420), to: at(0, 0, 640),
    rings: [ring(...Object.values(shot(431, 61, 36, 36)))],
    shows: 'The Drafts lane head, with its round plus button ringed.',
    say: ['To write a task yourself, click the plus on Drafts.'] },
  { guide: [
      ...guideHead('Drafts + opens “Stash a constitution”'),
      panel(200, 140, 880, 530),
      text(240, 160, 'shuttle · stash', { font: MONO, size: 14, color: MUTED }),
      text(240, 182, 'Stash a constitution', { font: SERIF, size: 30 }),
      label(240, 238, 'TITLE'), ...field(240, 256, 800, 44, 'Collect speaker bios'),
      label(240, 314, 'BODY  ·  optional'),
      ...field(240, 332, 800, 58, 'Free-form — paragraphs, code, whatever. Skip it if the title is enough.', { color: `${INK}@0.45`, size: 17 }),
      label(240, 404, 'HOST'), label(510, 404, 'PROJECT'), label(780, 404, 'AGENT'),
      ...field(240, 422, 250, 40, 'my-laptop'), ...field(510, 422, 250, 40, 'workshop'), ...field(780, 422, 260, 40, 'Default (claude-opus)', { size: 17 }),
      label(240, 476, 'KIND'),
      rect(240, 494, 395, 50, '0xF5EBCF', OCHRE), text(258, 507, 'One-shot', { font: SERIF, size: 19 }), text(360, 510, 'lands in Drafts', { size: 15, color: MUTED }),
      rect(645, 494, 395, 50, FIELD, RULE), text(663, 507, 'Standing', { font: SERIF, size: 19 }), text(765, 510, 'on a schedule', { size: 15, color: MUTED }),
      ...button(808, 600, 104, 44, 'Cancel'), ...button(924, 600, 116, 44, 'Stash', 'ochre'),
      text(200, 682, 'The form also has Tags, Effort and Parent fiber.', { size: 15, color: MUTED }),
    ],
    rings: [ring(232, 230, 816, 240, [0]), ring(232, 486, 816, 66, [1]), ring(916, 592, 132, 60, [2])],
    shows: 'Control guide of the Stash a constitution form: Title, optional Body, Host, Project and Agent, Kind (One-shot or Standing), and the Stash button.',
    say: [
      'The Stash form asks for a title, optional details, a project and an agent.',
      'One-shot is a single task. Standing repeats on a schedule.',
      'With One-shot selected, Stash saves a draft card.',
    ] },
  { image: 'shuttle-board-example.png', from: at(0, 0, 640), to: at(470, 0, 660),
    rings: [ring(...Object.values(shot(907, 61, 36, 36)))],
    shows: 'The In flight lane head, with its round star button ringed.',
    say: ['Or click the star on In flight, and describe an idea in your own words.'] },
  { guide: [
      ...guideHead('The In flight star opens “New idea”'),
      panel(200, 140, 880, 530),
      text(240, 160, 'shuttle · capture', { font: MONO, size: 14, color: MUTED }),
      text(240, 182, 'New idea', { font: SERIF, size: 30 }),
      ...field(240, 240, 800, 150, 'Speak the idea — a session will write the card', { color: `${INK}@0.45`, size: 20 }).map(e => e.rect ? e : { ...e, y: 258 }),
      ...button(240, 404, 120, 40, 'Meeting'),
      label(240, 464, 'HOST'), label(510, 464, 'PROJECT'), label(780, 464, 'AGENT'),
      ...field(240, 482, 250, 40, 'my-laptop'), ...field(510, 482, 250, 40, 'workshop'), ...field(780, 482, 260, 40, 'claude-opus (default)', { size: 17 }),
      ...button(808, 600, 104, 44, 'Cancel'), ...button(924, 600, 116, 44, 'Spawn', 'cobalt'),
      text(200, 682, 'With Meeting on, the dialog becomes “Start a meeting”, and a scribe files the meeting as a new task.', { size: 15, color: MUTED }),
    ],
    rings: [ring(502, 474, 266, 56, [0]), ring(916, 592, 132, 60, [0, 1])],
    shows: 'Control guide of the New idea dialog: a large text box, a Meeting toggle, Host, Project and Agent, and the Spawn button.',
    say: [
      'Pick a project and press Spawn.',
      'An agent turns your words into a task, and its card appears a moment later.',
    ] },
  { guide: [
      ...guideHead('Click a card to open its actions'),
      panel(200, 140, 880, 530),
      text(240, 160, 'workshop/participant-guide', { font: MONO, size: 14, color: MUTED }),
      text(240, 182, 'Prepare the workshop guide', { font: SERIF, size: 30 }),
      rect(240, 234, 800, 40, '0xF3EBDA', RULE),
      text(254, 243, '▾', { font: MONO, size: 17, color: MUTED }),
      text(282, 243, 'claude-opus', { font: MONO, size: 16, color: COBALT }), text(408, 243, 'medium', { font: MONO, size: 16, color: MUTED }),
      text(510, 243, 'my-laptop:~/projects/workshop', { font: MONO, size: 16, color: MUTED }),
      rect(240, 290, 800, 128, FIELD, RULE),
      text(256, 304, 'What should the worker do next?', { font: SERIF, size: 20, color: `${INK}@0.45` }),
      ...button(574, 364, 124, 40, 'Meeting'), ...button(708, 364, 158, 40, 'New session', 'send'), ...button(876, 364, 150, 40, 'Resume', 'send'),
      label(240, 436, 'AGENT'), text(240, 454, 'claude-opus', { font: MONO, size: 16 }),
      label(420, 436, 'EFFORT'), text(420, 454, 'medium', { font: MONO, size: 16 }),
      label(600, 436, 'KIND'), text(600, 454, 'oneshot', { font: MONO, size: 16 }),
      label(780, 436, 'DUE'), text(780, 454, '—', { font: MONO, size: 16 }),
      label(240, 500, 'PARENT'), text(240, 518, 'workshop', { font: MONO, size: 16 }),
      text(240, 566, 'HISTORY  ▾', { font: MONO, size: 14, color: MUTED }),
      rect(240, 596, 800, 1, RULE),
      ...button(788, 610, 118, 42, 'Discard', 'discard'), ...button(918, 610, 122, 42, 'Temper', 'temper'),
    ],
    rings: [
      ring(226, 166, 828, 116, [0]), ring(232, 226, 816, 56, [1]),
      ring(232, 282, 816, 144, [2]),
      ring(700, 356, 174, 56, [3, 4]), ring(868, 356, 166, 56, [5, 6]),
    ],
    shows: 'Control guide of an open card: a strip naming its agent and place, a message box with Meeting, New session and Resume, the next launch’s settings, History, and Discard and Temper.',
    say: [
      'Click any card to open it.',
      'The strip under its title, showing who works it and where, unfolds its actions.',
      'Write a message for the worker if you like, then choose how to send it.',
      'New session starts a fresh conversation, which reads the task and its notes from the top.',
      'If a worker is still running, the board asks before cutting it off.',
      'Resume requests the task’s previous conversation.',
      'Use it when finished work needs one more change.',
    ] },
  { guide: [
      ...guideHead('Meeting opens Call, Room or Phone'),
      panel(60, 140, 600, 400),
      text(90, 160, 'workshop/participant-guide', { font: MONO, size: 14, color: MUTED }),
      text(90, 182, 'Prepare the workshop guide', { font: SERIF, size: 28 }),
      rect(90, 234, 540, 116, FIELD, RULE),
      text(106, 248, 'What should the worker do next?', { font: SERIF, size: 19, color: `${INK}@0.45` }),
      ...button(110, 298, 124, 40, 'Meeting'), ...button(244, 298, 150, 40, 'New session', 'send'), ...button(404, 298, 130, 40, 'Resume', 'send'),
      rect(110, 344, 170, 150, FIELD, `${INK}@0.35`),
      text(128, 356, 'Call', { font: SERIF, size: 19 }), text(128, 404, 'Room', { font: SERIF, size: 19 }), text(128, 452, 'Phone', { font: SERIF, size: 19 }),
      text(300, 358, 'the recorder computer’s mic and system audio', { size: 15, color: MUTED }),
      text(300, 406, 'the recorder computer’s mic alone', { size: 15, color: MUTED }),
      text(300, 454, 'your browser’s mic, streamed from the board', { size: 15, color: MUTED }),
      panel(720, 140, 500, 400),
      text(750, 162, 'WHILE IT RECORDS, ON THE CARD', { font: MONO, size: 13, color: MUTED }),
      rect(750, 196, 12, 12, MADDER, null, 'fill'), text(772, 190, 'Recording', { font: SERIF, size: 19 }), text(880, 193, '4:12', { font: MONO, size: 16, color: MUTED }),
      label(750, 236, 'LIVE TRANSCRIPT'),
      rect(750, 260, 420, 10, `${INK}@0.14`, null, 'fill'), rect(750, 284, 360, 10, `${INK}@0.14`, null, 'fill'),
      rect(750, 308, 400, 10, `${INK}@0.14`, null, 'fill'), rect(750, 332, 300, 10, `${INK}@0.14`, null, 'fill'),
      ...button(750, 376, 110, 42, 'Stop', 'discard'), ...button(872, 376, 130, 42, 'Terminal'),
      text(750, 446, 'The worker follows the transcript, files', { size: 16, color: MUTED }),
      text(750, 470, 'notes in a child fiber, and answers when', { size: 16, color: MUTED }),
      text(750, 494, 'someone addresses it by name.', { size: 16, color: MUTED }),
      text(60, 572, 'Meeting appears where the hark recorder is available. One meeting records at a time.', { size: 16, color: MUTED }),
      text(60, 598, 'The message box becomes the meeting’s note; the meeting joins this task’s worker.', { size: 16, color: MUTED }),
    ],
    rings: [
      ring(102, 290, 140, 56, [0]), ring(102, 336, 550, 166, [1]),
      ring(740, 228, 448, 120, [2]), ring(742, 368, 126, 58, [3]),
    ],
    shows: 'Control guide of the Meeting menu, with Call, Room and Phone, beside a card recording a meeting, with its live transcript, Stop and Terminal.',
    say: [
      'Meeting records a conversation and joins it to this task.',
      'Call records the recorder computer’s microphone and system audio. Room uses its microphone alone. Phone uses your browser’s microphone.',
      'The worker follows the live transcript, takes notes, and answers when you address it by name.',
      'Stop ends the recording.',
    ] },
  { image: 'shuttle-board-example.png', from: at(10, 12, 1420), to: at(470, 60, 500),
    rings: [ring(...Object.values(shot(881, 195, 54, 26)))],
    shows: 'A running card in In flight, Prepare the workshop guide, with its Aloft badge ringed.',
    say: ['On a running card, Aloft opens the worker’s conversation, in a terminal, a browser, or a desktop app.'] },
  { image: 'shuttle-board-example.png', from: at(470, 60, 500), to: at(935, 60, 500),
    rings: [ring(...Object.values(shot(980, 155, 420, 33)), [0]), ring(...Object.values(shot(1175, 194, 116, 28)), [1])],
    shows: 'Review the draft programme in Awaiting review: its outcome, then its Temper and Discard buttons, ringed in turn.',
    say: [
      'When a worker finishes, its outcome waits here for you.',
      'Read it, then press Temper to accept the result, or Discard to set it aside.',
    ] },
  { card: true, title: 'Set up Shuttle', lines: ['Start with one machine and one small task', 'cailmdaley.github.io/felt/shuttle/setup/'],
    shows: 'End card: Set up Shuttle, at cailmdaley.github.io/felt/shuttle/setup/.',
    say: ['To try it, set up Shuttle on one machine, and start with one small task.'] },
]

const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString()
const seconds = path => Number(run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]))
const frames = s => Math.ceil(s * FPS - 1e-6) / FPS

/** One sentence spoken, trimmed of edge silence, cached by voice and text. */
async function speak(sentence) {
  const key = createHash('sha256').update(`${VOICE}\n${sentence}`).digest('hex').slice(0, 20)
  const path = join(CACHE, `${VOICE}-${key}.wav`)
  if (existsSync(path)) return path
  const form = new FormData()
  form.set('text', sentence)
  form.set('voice_url', VOICE)
  const response = await fetch(TTS_URL, { method: 'POST', body: form }).catch(error => {
    throw new Error(`Pocket TTS is not reachable at ${TTS_URL} (start it with: pocket-tts serve --port 8321): ${error.message}`)
  })
  if (!response.ok) throw new Error(`Pocket TTS answered ${response.status} for: ${sentence}`)
  const raw = `${path}.raw.wav`
  await writeFile(raw, Buffer.from(await response.arrayBuffer()))
  const trim = 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.04'
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', raw, '-af', `${trim},areverse,${trim.replace('0.04', '0.12')},areverse`,
    '-ar', '24000', '-ac', '1', `${path}.tmp.wav`], { stdio: 'inherit' })
  await rename(`${path}.tmp.wav`, path)
  await rm(raw)
  return path
}

const ease = 'p*p*(3-2*p)'
const fmt = s => {
  const ms = Math.round(s * 1000)
  const h = String(Math.floor(ms / 3_600_000)).padStart(2, '0')
  const m = String(Math.floor(ms / 60_000) % 60).padStart(2, '0')
  const sec = String(Math.floor(ms / 1000) % 60).padStart(2, '0')
  return `${h}:${m}:${sec}.${String(ms % 1000).padStart(3, '0')}`
}
const html = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

await mkdir(CACHE, { recursive: true })
const work = await mkdtemp(join(tmpdir(), 'shuttle-tour-'))
try {
  // Speech first: its measured lengths time everything else.
  const voiced = []
  for (const scene of scenes) {
    const lines = []
    for (const sentence of scene.say) {
      const path = await speak(sentence)
      lines.push({ sentence, path, length: seconds(path) })
    }
    voiced.push(lines)
  }

  let start = 0
  const segments = [], cues = [], clips = []
  for (const [index, scene] of scenes.entries()) {
    // Sentence i is spoken from spans[i].a to spans[i].b, in scene time.
    let clock = LEAD
    const spans = voiced[index].map(line => {
      const span = { ...line, a: clock, b: clock + line.length }
      clock = span.b + GAP
      return span
    })
    const d = frames(spans.at(-1).b + TAIL)
    for (const span of spans) {
      cues.push({ start: start + span.a, end: start + span.b + Math.min(GAP, 0.3), text: span.sentence })
      clips.push({ path: span.path, at: start + span.a })
    }
    // A ring shows from just before its first sentence to the start of the one after its last.
    const showing = r => {
      if (!r.during) return `between(t,${LEAD - 0.3},${d})`
      const first = spans[r.during[0]], last = r.during.at(-1)
      const end = spans[last + 1]?.a - 0.1 || d
      return `between(t,${(first.a - 0.25).toFixed(3)},${end.toFixed(3)})`
    }

    const file = async (name, value) => {
      const path = join(work, `${index}-${name}.txt`)
      await writeFile(path, value)
      return path
    }
    const draw = async (name, t) => {
      const x = t.center ? `${t.x}+(${t.center}-text_w)/2` : String(t.x)
      return `drawtext=fontfile='${t.font}':textfile='${await file(name, t.value)}':expansion=none:fontsize=${t.size}:fontcolor=${t.color}:x=${x}:y=${t.y}:y_align=font`
    }
    const graph = []
    let input = []
    if (scene.card) {
      graph.push(`color=c=${PAPER}:s=${W}x${H}:r=${FPS}:d=${d}[bg]`)
      let chain = `[bg]${await draw('title', { value: scene.title, font: SERIF, size: 60, color: INK, x: 0, y: 'h/2-104', center: 'w' })}`
      chain += `,drawbox=x=(iw-120)/2:y=ih/2-6:w=120:h=3:color=${RUST}:t=fill`
      for (const [i, line] of scene.lines.entries()) {
        chain += `,${await draw(`line${i}`, { value: line, font: SANS, size: i ? 22 : 30, color: i ? `${INK}@0.7` : INK, x: 0, y: `h/2+${26 + i * 52}`, center: 'w' })}`
      }
      graph.push(`${chain}[cam]`)
    } else if (scene.guide) {
      graph.push(`color=c=${PAPER}:s=${W}x${H}:r=${FPS}:d=${d}[bg]`)
      const parts = []
      for (const [i, e] of scene.guide.entries()) {
        if (e.rect) {
          if (e.fill) parts.push(`drawbox=x=${e.x}:y=${e.y}:w=${e.w}:h=${e.h}:color=${e.fill}:t=fill`)
          if (e.line && e.t !== 'fill') parts.push(`drawbox=x=${e.x}:y=${e.y}:w=${e.w}:h=${e.h}:color=${e.line}:t=${e.t}`)
        } else parts.push(await draw(`g${i}`, e))
      }
      for (const r of scene.rings ?? []) {
        parts.push(`drawbox=x=${r.x}:y=${r.y}:w=${r.w}:h=${r.h}:color=${RUST}@0.9:t=4:enable='${showing(r)}'`)
      }
      graph.push(`[bg]${parts.join(',')}[cam]`)
    } else {
      // The screenshot, padded and upsampled once, loops as frames; rings are drawn
      // on it in screenshot coordinates, then zoompan eases the camera from one
      // rectangle to the other over the first `move` seconds and holds.
      const still = join(work, `${index}-still.png`)
      execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', join(assets, scene.image), '-vf',
        `pad=${SRC_W}:${SRC_H}:0:25:color=${PAPER},scale=${SRC_W * UP}:${SRC_H * UP}:flags=lanczos`, still], { stdio: 'inherit' })
      input = ['-loop', '1', '-framerate', String(FPS), '-t', String(d), '-i', still]
      const move = Math.min(scene.move ?? MOVE, d)
      const eased = ease.replaceAll('p', `min(1,in/${Math.round(move * FPS)})`)
      const lerp = k => `(${scene.from[k]}+(${scene.to[k] - scene.from[k]})*${eased})`
      const rings = (scene.rings ?? []).map(r =>
        `,drawbox=x=${(r.x - 4) * UP}:y=${(r.y - 4) * UP}:w=${(r.w + 8) * UP}:h=${(r.h + 8) * UP}:color=${RUST}@0.9:t=${3 * UP}:enable='${showing(r)}'`).join('')
      graph.push(`[0:v]format=rgb24${rings},` +
        `zoompan=z='${SRC_W}/${lerp('w')}':x='${UP}*${lerp('x')}':y='${UP}*${lerp('y')}'` +
        `:d=1:s=${W}x${H}:fps=${FPS},trim=duration=${d},setpts=PTS-STARTPTS[raw]`)
      graph.push(`[raw]drawtext=fontfile='${SANS}':text='Screenshot · fictional example':expansion=none:fontsize=17:fontcolor=${INK}@0.75:box=1:boxcolor=${PAPER}@0.85:boxborderw=8:x=w-text_w-22:y=20[cam]`)
    }
    graph.push(`[cam]fade=t=in:st=0:d=${FADE}:color=${PAPER},fade=t=out:st=${(d - FADE).toFixed(3)}:d=${FADE}:color=${PAPER},scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[out]`)
    const script = join(work, `${index}.graph`)
    await writeFile(script, graph.join(';\n'))
    const segment = join(work, `${index}.mp4`)
    execFileSync(ffmpeg, ['-v', 'error', '-y', ...input, '-/filter_complex', script, '-map', '[out]',
      '-r', String(FPS), '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', ...COLOR, segment], { stdio: 'inherit' })
    segments.push(segment)
    scene.start = start
    scene.duration = d
    start += d
  }

  // The narration: every sentence placed at its start, then one loudness pass
  // measured and a second applied, to -16 LUFS integrated and -1.5 dBTP.
  const placed = join(work, 'narration.wav')
  const mix = clips.map((clip, i) => `[${i}:a]adelay=${Math.round(clip.at * 1000)}:all=1[a${i}]`).join(';') +
    `;${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0:duration=longest,apad=whole_dur=${start.toFixed(3)}[mix]`
  await writeFile(join(work, 'mix.graph'), mix)
  execFileSync(ffmpeg, ['-v', 'error', '-y', ...clips.flatMap(clip => ['-i', clip.path]), '-/filter_complex', join(work, 'mix.graph'),
    '-map', '[mix]', '-ar', '48000', '-ac', '1', placed], { stdio: 'inherit' })
  const target = 'I=-16:TP=-1.5:LRA=11'
  const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', placed, '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-'],
    { encoding: 'utf8' }).stderr
  const m = JSON.parse(probe.slice(probe.lastIndexOf('{'), probe.lastIndexOf('}') + 1))
  const narration = join(work, 'narration-normalized.wav')
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', placed, '-af',
    `loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000`,
    '-ar', '48000', '-ac', '1', narration], { stdio: 'inherit' })

  const list = join(work, 'segments.txt')
  await writeFile(list, segments.map(s => `file '${s}'`).join('\n'))
  const video = join(assets, 'shuttle-board-tour.mp4')
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-i', narration,
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', ...COLOR,
    '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', video], { stdio: 'inherit' })
  // The poster is the Desk overview.
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-ss', String(scenes[1].start + 3), '-i', video, '-frames:v', '1', '-q:v', '3',
    join(assets, 'shuttle-board-tour-poster.jpg')], { stdio: 'inherit' })

  const vtt = ['WEBVTT', '', ...cues.flatMap((cue, i) => [String(i + 1), `${fmt(cue.start)} --> ${fmt(cue.end)}`, cue.text, ''])]
  await writeFile(join(assets, 'shuttle-board-tour.vtt'), vtt.join('\n'))

  const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  const transcript = [
    '<!-- tour-transcript:start -->',
    '<details class="tour-transcript">',
    `<summary>Transcript of the board tour (${clock(start)})</summary>`,
    ...scenes.map(scene => `<p><span class="tour-time">${clock(scene.start)}</span> <em>${html(scene.shows)}</em> ${html(scene.say.join(' '))}</p>`),
    '</details>',
    '<!-- tour-transcript:end -->',
  ].join('\n')
  const marked = /<!-- tour-transcript:start -->[\s\S]*<!-- tour-transcript:end -->/
  for (const page of pages) {
    const doc = await readFile(page, 'utf8')
    if (!marked.test(doc)) throw new Error(`${page} lacks the tour-transcript markers`)
    await writeFile(page, doc.replace(marked, transcript))
  }
  console.log(`wrote ${video} (${start.toFixed(1)} s, voice ${VOICE}), poster, captions and transcripts`)
} finally {
  await rm(work, { recursive: true, force: true })
}
