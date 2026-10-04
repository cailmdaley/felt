/**
 * Render the Shuttle board tour video from the committed documentation
 * screenshots. Run npm run video:docs from ui/; it needs only ffmpeg.
 *
 * Each scene moves a camera between two rectangles on one screenshot and
 * lays captions over it. Nothing is captured from a live board: every frame
 * is a crop of docs/assets/shuttle-board-example.png or board-chronicle.jpg.
 * The same captions become the WebVTT track and the timed transcript between
 * the tour-transcript markers in docs/shuttle/tour.md.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const assets = join(root, 'docs/assets')
const page = join(root, 'docs/shuttle/tour.md')
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'

const W = 1280, H = 720, FPS = 30
const SRC_W = 1440, SRC_H = 810 // screenshots are 1440×760, padded to 16:9
const UP = 4                      // upsampling before the camera, for smooth motion
const FADE = 0.4
// Every segment is tagged alike, or concat mis-converts the ones after a full-range JPEG.
const COLOR = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']
const PAPER = '0xEAE0CC', INK = '0x2E2A26', RUST = '0xC2410C'

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

/** A rectangle on the padded 1440×810 screenshot, given by its left, top and width; height follows 16:9. */
const at = (x, y, w) => ({ x, y, w })
const FULL = at(0, 0, SRC_W)
// Screenshot coordinates are offset by the 25 px pad above the 760 px image.
const box = (x, y, w, h) => ({ x, y: y + 25, w, h })

const scenes = [
  { card: true, duration: 4.5, title: 'The Shuttle board',
    lines: ['A short tour of the Desk and Chronicle', 'Screenshots of the real board, over a fictional example'] },
  { image: 'shuttle-board-example.png', duration: 7, from: FULL, to: at(40, 20, 1360),
    captions: [
      'The Desk shows every task as a card, in three lanes.',
      'This example plans a small workshop. Its tasks and data are fictional.',
    ] },
  { image: 'shuttle-board-example.png', duration: 5.5, from: at(0, 40, 760), to: at(0, 50, 700),
    rings: [box(21, 108, 447, 214)],
    captions: ['Drafts: tasks written down, but not started.'] },
  { image: 'shuttle-board-example.png', duration: 10, from: at(420, 50, 640), to: at(470, 110, 500),
    rings: [box(497, 108, 446, 120)],
    captions: [
      'In flight: an agent, called a worker, is running on each of these.',
      'The card names the task and the result it should reach.',
      'Aloft marks a running worker. Click it to open that worker’s conversation.',
    ] },
  { image: 'shuttle-board-example.png', duration: 10, from: at(840, 50, 600), to: at(940, 95, 500),
    rings: [box(973, 108, 446, 120)],
    captions: [
      'Awaiting review: a worker finished and recorded an outcome.',
      'This outcome says what still needs confirming before the workshop.',
      'Temper accepts the result. Discard sets it aside.',
    ] },
  { image: 'board-chronicle.jpg', duration: 8, from: FULL, to: at(0, 90, 1120),
    captions: [
      'Chronicle, the second tab, lays each task along the calendar.',
      'Marks show the days its workers were busy, through today.',
    ] },
  { card: true, duration: 4.5, title: 'Set up Shuttle',
    lines: ['Start with one machine and one small task', 'cailmdaley.github.io/felt/shuttle/setup/'] },
]

const ease = 'p*p*(3-2*p)'
const fmt = s => {
  const ms = Math.round(s * 1000)
  const h = String(Math.floor(ms / 3_600_000)).padStart(2, '0')
  const m = String(Math.floor(ms / 60_000) % 60).padStart(2, '0')
  const sec = String(Math.floor(ms / 1000) % 60).padStart(2, '0')
  return `${h}:${m}:${sec}.${String(ms % 1000).padStart(3, '0')}`
}

const work = await mkdtemp(join(tmpdir(), 'shuttle-tour-'))
const cues = []
try {
  let start = 0
  const segments = []
  for (const [index, scene] of scenes.entries()) {
    const d = scene.duration
    const text = async (name, value) => {
      const path = join(work, `${index}-${name}.txt`)
      await writeFile(path, value)
      return path
    }
    const fadeAlpha = (a, b) => `if(lt(t,${a}+0.3),(t-${a})/0.3,if(gt(t,${b}-0.3),(${b}-t)/0.3,1))`
    const graph = []
    if (scene.card) {
      graph.push(`color=c=${PAPER}:s=${W}x${H}:r=${FPS}:d=${d}[bg]`)
      let chain = `[bg]drawtext=fontfile='${SERIF}':textfile='${await text('title', scene.title)}':expansion=none:fontsize=60:fontcolor=${INK}:x=(w-text_w)/2:y=h/2-90`
      chain += `,drawbox=x=(iw-120)/2:y=ih/2-6:w=120:h=3:color=${RUST}:t=fill`
      for (const [i, line] of scene.lines.entries()) {
        chain += `,drawtext=fontfile='${SANS}':textfile='${await text(`line${i}`, line)}':expansion=none:fontsize=${i ? 24 : 30}:fontcolor=${INK}${i ? '@0.7' : ''}:x=(w-text_w)/2:y=h/2+${30 + i * 52}`
      }
      graph.push(`${chain}[cam]`)
      cues.push({ start, end: start + d, text: [scene.title, ...scene.lines].join('\n'), card: true })
    } else {
      // zoompan shows iw/zoom of the upsampled image from (x, y); the camera eases from one rectangle to the other.
      const frames = Math.round(d * FPS)
      const eased = ease.replaceAll('p', `min(1,on/${frames - 1})`)
      const lerp = k => `(${scene.from[k]}+(${scene.to[k] - scene.from[k]})*${eased})`
      const rings = (scene.rings ?? []).map(r =>
        `,drawbox=x=${(r.x - 4) * UP}:y=${(r.y - 4) * UP}:w=${(r.w + 8) * UP}:h=${(r.h + 8) * UP}:color=${RUST}@0.9:t=${3 * UP}`).join('')
      graph.push(`[0:v]pad=${SRC_W}:${SRC_H}:0:25:color=${PAPER},scale=${SRC_W * UP}:${SRC_H * UP}:flags=lanczos${rings},` +
        `zoompan=z='${SRC_W}/${lerp('w')}':x='${UP}*${lerp('x')}':y='${UP}*${lerp('y')}'` +
        `:d=${frames}:s=${W}x${H}:fps=${FPS},trim=duration=${d},setpts=PTS-STARTPTS[raw]`)
      // Each caption gets an equal share of the scene, after a short settle.
      const share = (d - 0.6) / scene.captions.length
      let chain = `[raw]drawtext=fontfile='${SANS}':text='Screenshot · fictional example':expansion=none:fontsize=17:fontcolor=${INK}@0.75:box=1:boxcolor=${PAPER}@0.85:boxborderw=8:x=w-text_w-22:y=20`
      for (const [i, caption] of scene.captions.entries()) {
        const a = +(0.4 + i * share).toFixed(2), b = +(0.4 + (i + 1) * share - 0.1).toFixed(2)
        chain += `,drawtext=fontfile='${SANS}':textfile='${await text(`cap${i}`, caption)}':expansion=none:fontsize=30` +
          `:fontcolor=0xFBF6EC:box=1:boxcolor=${INK}@0.88:boxborderw=18|26:x=(w-text_w)/2:y=h-text_h-58` +
          `:enable='between(t,${a},${b})':alpha='${fadeAlpha(a, b)}'`
        cues.push({ start: start + a, end: start + b, text: caption })
      }
      graph.push(`${chain}[cam]`)
    }
    graph.push(`[cam]fade=t=in:st=0:d=${FADE}:color=${PAPER},fade=t=out:st=${d - FADE}:d=${FADE}:color=${PAPER},scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[out]`)
    const script = join(work, `${index}.graph`)
    await writeFile(script, graph.join(';\n'))
    const segment = join(work, `${index}.mp4`)
    const input = scene.card ? [] : ['-i', join(assets, scene.image)]
    execFileSync(ffmpeg, ['-v', 'error', '-y', ...input, '-/filter_complex', script, '-map', '[out]',
      '-r', String(FPS), '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', ...COLOR, segment], { stdio: 'inherit' })
    segments.push(segment)
    start += d
  }

  const list = join(work, 'segments.txt')
  await writeFile(list, segments.map(s => `file '${s}'`).join('\n'))
  const video = join(assets, 'shuttle-board-tour.mp4')
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', ...COLOR,
    '-movflags', '+faststart', '-an', video], { stdio: 'inherit' })
  // The poster is the Desk overview with its first caption.
  const posterAt = scenes[0].duration + 1.5
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-ss', String(posterAt), '-i', video, '-frames:v', '1', '-q:v', '3',
    join(assets, 'shuttle-board-tour-poster.jpg')], { stdio: 'inherit' })

  const vtt = ['WEBVTT', '', ...cues.flatMap((cue, i) => [String(i + 1), `${fmt(cue.start)} --> ${fmt(cue.end)}`, cue.text, ''])]
  await writeFile(join(assets, 'shuttle-board-tour.vtt'), vtt.join('\n'))

  const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  const rows = cues.map(cue => `| ${clock(cue.start)} | ${cue.card ? `**${cue.text.split('\n').join(' — ')}**` : cue.text} |`)
  const transcript = ['<!-- tour-transcript:start -->', '| Time | On screen |', '|---|---|', ...rows, '<!-- tour-transcript:end -->'].join('\n')
  const doc = await readFile(page, 'utf8')
  const marked = /<!-- tour-transcript:start -->[\s\S]*<!-- tour-transcript:end -->/
  if (!marked.test(doc)) throw new Error(`${page} lacks the tour-transcript markers`)
  await writeFile(page, doc.replace(marked, transcript))
  console.log(`wrote ${video} (${start.toFixed(1)} s), poster, captions and transcript`)
} finally {
  await rm(work, { recursive: true, force: true })
}
