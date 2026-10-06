import mp3Data from './fixtures/sine.mp3?inline'
import wavData from './fixtures/sine.wav?inline'
import mp4Data from './fixtures/test.mp4?inline'
import webmData from './fixtures/test.webm?inline'
import imageData from './fixtures/figure.png?inline'
import pdfData from './fixtures/native.pdf?inline'
import type { ActivityBucket, CommitRecord, SessionRecord, TemporalFetchers } from '../src/board/views/index.js'

export const WORKSPACE_HOST = 'umber-workstation'
export const WORKSPACE_REMOTE = 'basalt-login-02'
export const WORKSPACE_UID = '01KVBR1F9BWBVKF97473PV67K8'
export const WORKSPACE_NAME = 'Calibrate the shear response'
export const WORKSPACE_ID = 'research/workspace/calibration-report'
export const WORKSPACE_REPORT = '/fixture-store/workspace/.felt/research/workspace/calibration-report/report.html'

export interface WorkspaceFileFixture {
  owner: string
  path: string
  mime: string
  body: Blob
}

export interface WorkspaceExample {
  host: string
  remote: string
  feed: {
    host: string
    generated_at: string
    fibers: Array<Record<string, unknown>>
    origins: Record<string, Record<string, unknown>>
  }
  bodies: Record<string, string>
  sessions: SessionRecord[]
  temporal: TemporalFetchers
  files: WorkspaceFileFixture[]
  receipts: Array<Record<string, unknown>>
  fiberIndex: Array<{ id: string; name: string }>
  fileResponse(url: string, method: string, headers?: HeadersInit): Response
}

const inlineBlob = (data: string, mime: string): Blob => {
  const encoded = data.slice(data.indexOf(',') + 1)
  const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0))
  return new Blob([bytes], { type: mime })
}

const blobFor = (data: string, mime: string): Blob => inlineBlob(data, mime)
// An empty ZIP's end-of-central-directory record is a complete archive.
const zipBytes = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...Array<number>(18).fill(0)])

const key = (owner: string, path: string): string => `${owner}\u0000${path}`

/** 64 hex digits that change with the identity they are computed from. */
function fixtureDigest(identity: string): string {
  let out = ''
  for (let round = 0; out.length < 64; round++) {
    let hash = 2166136261 ^ round
    for (let i = 0; i < identity.length; i++) hash = Math.imul(hash ^ identity.charCodeAt(i), 16777619)
    out += (hash >>> 0).toString(16).padStart(8, '0')
  }
  return out.slice(0, 64)
}

export interface WorkspaceNativeURLs {
  blobURLs: Record<string, string>
  rewrites: Array<{ owner: string; path: string; blobURL: string }>
}

/** Map native file routes to real fixture bytes so Chrome's built-in readers run under file://. */
export function installWorkspaceNativeURLs(example: WorkspaceExample): WorkspaceNativeURLs {
  const blobURLs = Object.fromEntries(example.files.map(file => [
    key(file.owner, file.path), URL.createObjectURL(file.body),
  ]))
  const rewrites: WorkspaceNativeURLs['rewrites'] = []
  const rewrite = (source: string): string => {
    if (!source.includes('/api/v1/file')) return source
    const url = new URL(source, document.baseURI)
    const asset = /\/api\/v1\/file-assets\/([^/]+)(\/.*)$/.exec(url.pathname)
    if (!asset && !url.pathname.endsWith('/api/v1/file')) return source
    const path = asset ? decodeURIComponent(asset[2]) : url.searchParams.get('path')
    const owner = asset ? decodeURIComponent(asset[1]) : url.searchParams.get('origin') || example.host
    if (!path) return source
    const blobURL = blobURLs[key(owner, path)]
    if (!blobURL) return source
    rewrites.push({ owner, path, blobURL })
    return `${blobURL}${url.hash}`
  }
  const patch = (prototype: object): void => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'src')
    if (!descriptor?.get || !descriptor.set) return
    Object.defineProperty(prototype, 'src', {
      configurable: descriptor.configurable,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(this: Element, value: string) { descriptor.set!.call(this, rewrite(String(value))) },
    })
  }
  patch(HTMLImageElement.prototype)
  patch(HTMLIFrameElement.prototype)
  patch(HTMLMediaElement.prototype)
  return { blobURLs, rewrites }
}

export const MUSIC_UID = '01KVBR7N2HK1ASN3AA67W134S4'
export const MUSIC_NAME = 'Music'
export const MUSIC_TRACKS = 19

/** `music` adds a listening channel: a report and nineteen recordings, the shape of a real album review. */
export function workspaceExample(now: number, options: { music?: boolean } = {}): WorkspaceExample {
  const minute = 60_000
  const day = 86_400_000
  const project = '/fixture-store/workspace'
  const iso = (offset: number): string => new Date(now + offset).toISOString()
  const origins = {
    [WORKSPACE_HOST]: { kind: 'local' as const, stale: false, lastPolledAt: iso(0) },
    [WORKSPACE_REMOTE]: { kind: 'remote' as const, stale: false, lastPolledAt: iso(-minute) },
  }
  const fibers = [
    {
      id: WORKSPACE_ID,
      uid: WORKSPACE_UID,
      name: WORKSPACE_NAME,
      status: 'closed',
      age: 0.1,
      outcome: 'The response passes the null test at every scale; the report and source products are ready for review.',
      host: WORKSPACE_HOST,
    },
    {
      id: 'research/workspace/weekly-summary',
      uid: '01KVBR2G7CXDWMG85592QW78M9',
      name: 'Weekly shear summary',
      status: 'open',
      age: 1,
      outcome: 'Collect the latest validation results and note what remains uncertain.',
      host: WORKSPACE_HOST,
    },
    {
      id: 'pipeline/spin/remote-review',
      uid: '01KVBR3H8DYFXNH96683RX89N0',
      name: 'Remote covariance review',
      status: 'active',
      age: 2,
      outcome: 'Check the covariance products on the remote host before the next run.',
      host: WORKSPACE_REMOTE,
    },
    {
      id: 'research/workspace/mask-validation',
      uid: '01KVBR4J9EZGYPJ07734SY90P1',
      name: 'Mask validation notes',
      status: 'closed',
      age: 3,
      outcome: 'The updated mask recovers the injected signal within the target tolerance.',
      host: WORKSPACE_HOST,
    },
    {
      id: 'pipeline/spin/transfer-check',
      uid: '01KVBR5K0FZHZQK18845TZ01Q2',
      name: 'Transfer-function check',
      status: 'open',
      age: 5,
      outcome: 'Compare the transfer curves across the two map resolutions.',
      host: WORKSPACE_REMOTE,
    },
    {
      id: 'research/workspace/method-note',
      uid: '01KVBR6M1GJ0ZRM29956V023R3',
      name: 'Method note',
      status: 'closed',
      age: 7,
      outcome: 'The response correction is measured from independent simulations.',
      host: WORKSPACE_HOST,
      inCardIndex: false,
    },
    ...(options.music ? [{
      id: 'research/workspace/music',
      uid: MUSIC_UID,
      name: MUSIC_NAME,
      status: 'closed',
      age: 0.05,
      outcome: 'Nineteen takes are rendered; the listening notes compare them.',
      host: WORKSPACE_HOST,
    }] : []),
  ]
  const previews = new URLSearchParams(location.search).getAll('theme-preview')
  const previewFor = (uid: string): string | undefined => previews.find(value => value.startsWith(`${uid}:`))?.slice(uid.length + 1)
  const rows = fibers.filter(fiber => fiber.inCardIndex !== false).map((fiber, index) => {
    const dir = `${project}/.felt/${fiber.id}`
    const entry: Record<string, unknown> = {
      origin: fiber.host,
      felt_store: project,
      path: `.felt/${fiber.id}/${fiber.id.split('/').at(-1)}.md`,
      dir,
      fiber: {
        id: fiber.id,
        uid: fiber.uid,
        name: fiber.name,
        status: fiber.status,
        outcome: fiber.outcome,
        theme: previewFor(fiber.uid) ?? ['portolan', 'blueprint', 'night-chart', 'laboratory-paper', 'portolan'][index],
        tags: ['workspace', 'research'],
        created_at: iso(-fiber.age * day),
        updated_at: iso(-minute),
        // Distinct from frontmatter stamps and receipt times: real file mtime.
        modified_at: iso(-47 * minute),
        closed_at: fiber.status === 'closed' ? iso(-fiber.age * day) : undefined,
        shuttle: {
          kind: fiber.id === 'pipeline/spin/remote-review' ? 'standing' : 'oneshot',
          schedule: fiber.id === 'pipeline/spin/remote-review' ? { expr: '0 9 * * *', tz: 'UTC' } : undefined,
          host: fiber.host,
          agent: 'claude-opus',
          effort: 'high',
          project_dir: project,
          ...(fiber.id === WORKSPACE_ID ? { runtime: { session_uuid: 'c1a5e0d2-5b8f-4c1e-9a7e-2f3d4b5c6a71', dispatched_at: iso(-3 * 60 * minute), handed_off_at: iso(-2 * 60 * minute) } } : {}),
        },
      },
    }
    if (fiber.id === 'pipeline/spin/remote-review') {
      entry.runtime = {
        state: 'running',
        phase: 'working',
        tmux_session: `remote-review-${fiber.uid}-shuttle`,
        last_activity_at: now - 5_000,
        started_at: now - 12 * minute,
      }
    }
    if (index === 0) entry.fiber = { ...(entry.fiber as Record<string, unknown>), updated_at: iso(-minute) }
    return entry
  })
  const mainDir = `${project}/.felt/${WORKSPACE_ID}`
  const linkedText = `${mainDir}/tables/mask.csv`
  const report = WORKSPACE_REPORT
  const notes = `${project}/deliverables/brief.md`
  const readme = `${project}/deliverables/readme.txt`
  const code = `${project}/deliverables/response.py`
  const pdf = `${project}/deliverables/response.pdf`
  const image = `${project}/deliverables/figure.png`
  const mp3 = `${project}/deliverables/tone.mp3`
  const wav = `${project}/deliverables/tone.wav`
  const mp4 = `${project}/deliverables/test.mp4`
  const webm = `${project}/deliverables/test.webm`
  const other = `${project}/deliverables/archive.zip`
  const missing = `${project}/deliverables/not-produced.csv`
  const remotePdf = '/scratch/fixture-store/covariance/remote-summary.pdf'
  const reportLine = (index: number): string => `<p>Report line ${index + 1}: the response remains stable across the independent validation patches.</p>`
  const wideTable = `<div id="wide-table" style="overflow-x:auto"><table style="border-collapse:collapse;white-space:nowrap"><tr>${Array.from({ length: 16 }, (_, i) => `<th style="padding:4px 12px">bin ${i + 1}</th>`).join('')}</tr><tr>${Array.from({ length: 16 }, (_, i) => `<td style="padding:4px 12px">${(0.99 + i / 1000).toFixed(3)}</td>`).join('')}</tr></table></div>`
  // A reveal.js-style deck and a script-driven carousel own their sideways gestures.
  const pageGestures = `<div id="gesture-deck" style="touch-action:pan-y;height:120px;background:#eee8dc">Deck</div><div id="gesture-carousel" style="height:120px;background:#e4ece4">Carousel</div><script>document.getElementById('gesture-carousel').addEventListener('touchmove',e=>e.preventDefault(),{passive:false})</script>`
  const longReport = Array.from({ length: 80 }, (_, index) => (index === 40 ? pageGestures : '') + reportLine(index)).join('\n')
  const reportHTML = `<!doctype html><html><head><meta charset="utf-8"><title>Calibration report</title><style>body{font:16px/1.5 sans-serif;margin:32px}h1{color:#514637}</style></head><body><h1 id="report-sentinel">Calibration report</h1><p id="report-identity"></p><p>Read <code>brief.md</code> and <a href="../../../../deliverables/brief.md">the field note</a>; listen to <code>tone.mp3</code> or <code>tone.wav</code>.</p>${wideTable}${longReport}<script>document.getElementById('report-identity').textContent='instance:'+crypto.randomUUID()</script></body></html>`
  const file = (owner: string, path: string, mime: string, body: Blob | string): WorkspaceFileFixture => ({
    owner,
    path,
    mime,
    body: body instanceof Blob ? body : new Blob([body], { type: mime }),
  })
  const files: WorkspaceFileFixture[] = [
    file(WORKSPACE_HOST, `${mainDir}/theme.css`, 'text/css', `
      @import 'https://example.invalid/font.css';
      @font-face { font-family: "Shuttle Fixture Flourish"; src: local("Georgia"); }
      @keyframes ink-flourish { from { opacity: .45; } to { opacity: 1; } }
      @keyframes \\31 ink { to { opacity: 1; } }
      @keyframes "foo bar" { to { opacity: 1; } }
      :scope { --ws-custom-ready: 1; --fixture-animation: ink-flourish 2s ease infinite alternate; --fixture-space-animation: "foo bar" 1s; }
      [data-part="fiber-header"] { animation-name: ink-flourish; }
      [data-part="prose"] h2 { animation: var(--fixture-space-animation, \\31 ink 1s); }
      [data-part="fiber-title"]::after { content: '✧'; display: block; color: var(--ws-verdict); font-family: "Shuttle Fixture Flourish"; animation: var(--fixture-animation, ink-flourish 2s ease infinite alternate); }
      @media (min-width: 1px) { @supports (display: grid) { @layer fixture { [data-part="label-bar"] { border-top-style: double; } } } }
      [data-part="prose"] { --ws-nested-ready: 1; & p { text-underline-offset: .2em; } --ws-after-nested: 1; }
      .kbn-desk .kbn-card { opacity: .13; }
      [data-part="audio-waveform"] { color: rgb(11, 109, 127); }
      @media (width: 1379px) { button { color: red !important; font-family: fantasy !important; } }
      @media (width: 1379px) { :scope { --ws-mono: fantasy; --ws-control-height: 99px; --ws-agent: red; --kbn-agent: red; --font-mono: fantasy; text-transform: uppercase; font-style: italic; } }
    `),
    file(WORKSPACE_HOST, `${project}/.felt/research/workspace/mask-validation/theme.css`, 'text/css', '{ ] broken css'),
    file(WORKSPACE_HOST, report, 'text/html', reportHTML),
    file(WORKSPACE_HOST, notes, 'text/markdown', '# Field note\n\nThe transfer ratio is consistent with unity in the validation range.\n\n| ell | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 1000 | 1100 | 1200 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n| ratio | 0.998 | 1.003 | 1.001 | 0.999 | 1.002 | 1.000 | 0.997 | 1.004 | 1.001 | 0.998 | 1.002 | 1.000 |\n\nRead [the report](../.felt/research/workspace/calibration-report/report.html), or listen to `tone.mp3`.\n'),
    file(WORKSPACE_HOST, readme, 'text/plain', 'Fixture text document.\n\nThis body is served by the mocked file route.\nListen to `tone.mp3`.\n'),
    file(WORKSPACE_HOST, code, 'text/x-python', 'def response(ell, transfer):\n    return ell * transfer\n'),
    file(WORKSPACE_HOST, linkedText, 'text/csv', 'ell,response\n100,0.998\n200,1.003\n'),
    file(WORKSPACE_HOST, pdf, 'application/pdf', blobFor(pdfData, 'application/pdf')),
    file(WORKSPACE_HOST, image, 'image/png', blobFor(imageData, 'image/png')),
    file(WORKSPACE_HOST, mp3, 'audio/mpeg', blobFor(mp3Data, 'audio/mpeg')),
    file(WORKSPACE_HOST, wav, 'audio/wav', blobFor(wavData, 'audio/wav')),
    file(WORKSPACE_HOST, mp4, 'video/mp4', blobFor(mp4Data, 'video/mp4')),
    file(WORKSPACE_HOST, webm, 'video/webm', blobFor(webmData, 'video/webm')),
    file(WORKSPACE_HOST, other, 'application/zip', new Blob([zipBytes], { type: 'application/zip' })), 
    file(WORKSPACE_REMOTE, remotePdf, 'application/pdf', blobFor(pdfData, 'application/pdf')),
    file(WORKSPACE_HOST, `${project}/deliverables/weekly.txt`, 'text/plain', 'A receipt-backed second channel.\n'),
    file(WORKSPACE_REMOTE, '/scratch/fixture-store/covariance/transfer.txt', 'text/plain', 'Remote receipt fixture.\n'),
    file(WORKSPACE_HOST, `${project}/deliverables/mask-validation.md`, 'text/markdown', '# Mask validation\n\nThe input mask was held fixed.\n'),
  ]
  const musicDir = `${project}/.felt/research/workspace/music`
  const tracks = options.music ? Array.from({ length: MUSIC_TRACKS }, (_, i) => `${project}/music/take-${String(i + 1).padStart(2, '0')}.${i % 2 ? 'wav' : 'mp3'}`) : []
  if (options.music) {
    files.push(file(WORKSPACE_HOST, `${musicDir}/report.html`, 'text/html', `<!doctype html><html><head><meta charset="utf-8"><title>Listening notes</title></head><body><h1>Listening notes</h1>${tracks.map(t => `<p>${t.split('/').at(-1)}: steady.</p>`).join('')}</body></html>`))
    for (const track of tracks) files.push(file(WORKSPACE_HOST, track, track.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg', track.endsWith('.wav') ? blobFor(wavData, 'audio/wav') : blobFor(mp3Data, 'audio/mpeg')))
  }
  const receipts: Array<Record<string, unknown>> = []
  const receipt = (fullPath: string, uid: string, offset: number, host: string, sessionId: string): void => {
    receipts.push({ fullPath, basename: fullPath.split('/').at(-1), timestamp: now + offset, sessionId, uid, host })
  }
  receipt(report, WORKSPACE_UID, -8 * minute, WORKSPACE_HOST, 'workspace-send-older')
  receipt(report, WORKSPACE_UID, -3 * minute, WORKSPACE_HOST, 'workspace-send-middle')
  receipt(report, WORKSPACE_UID, -1 * minute, WORKSPACE_HOST, 'workspace-send-latest')
  for (const path of [notes, readme, code, pdf, image, mp3, wav, mp4, webm, other, missing]) {
    receipt(path, WORKSPACE_UID, -2 * minute, WORKSPACE_HOST, 'workspace-delivery')
  }
  receipt(remotePdf, WORKSPACE_UID, -90 * minute, WORKSPACE_REMOTE, 'remote-delivery')
  receipt(linkedText, '01KVBR2G7CXDWMG85592QW78M9', -day, WORKSPACE_HOST, 'weekly-delivery')
  receipt(`${project}/deliverables/weekly.txt`, '01KVBR2G7CXDWMG85592QW78M9', -day, WORKSPACE_HOST, 'weekly-delivery')
  receipt('/scratch/fixture-store/covariance/transfer.txt', '01KVBR3H8DYFXNH96683RX89N0', -2 * day, WORKSPACE_REMOTE, 'remote-delivery')
  receipt(`${project}/deliverables/mask-validation.md`, '01KVBR4J9EZGYPJ07734SY90P1', -3 * day, WORKSPACE_HOST, 'mask-delivery')
  tracks.forEach((track, i) => receipt(track, MUSIC_UID, -(30 - i) * minute, WORKSPACE_HOST, 'music-render'))
  if (options.music) receipt(`${musicDir}/report.html`, MUSIC_UID, -minute, WORKSPACE_HOST, 'music-notes')
  const bodies: Record<string, string> = {
    'research/workspace/music': ':::{embed} report.html\n:title: Listening notes\n:::\n\nNineteen takes of the theme.',
    [WORKSPACE_ID]: [
      'The response test keeps the science path and the data products together.',
      '',
      ':::{embed} report.html',
      ':title: Calibration report',
      ':::',
      '',
      '## Validation notes',
      '',
      'Read the [mask table](tables/mask.csv) alongside the report.',
      '',
      'The estimator is documented in [[research/workspace/method-note]].',
      '',
      'Listen to `tone.mp3` while reading `brief.md`.',
    ].join('\n'),
    'research/workspace/method-note': 'The response correction uses independent simulations and leaves the measured shear unchanged in the null tests.',
    'research/workspace/weekly-summary': 'Weekly summary body.',
    'pipeline/spin/remote-review': 'The remote covariance review is running on the fixture host.',
    'research/workspace/mask-validation': 'The mask validation passed.',
    'pipeline/spin/transfer-check': 'Compare the transfer functions at both map resolutions.',
  }
  const sessions: SessionRecord[] = [
    { at: now - 3 * 60 * minute, fiber: WORKSPACE_ID, uid: WORKSPACE_UID, session: 'workspace-session-latest', harness: 'claude-code', agent: 'claude-opus', host: WORKSPACE_HOST, tmux: null, kind: 'dispatch' },
    { at: now - 8 * 60 * minute, fiber: WORKSPACE_ID, uid: WORKSPACE_UID, session: 'workspace-session-earlier', harness: 'claude-code', agent: 'claude-opus', host: WORKSPACE_HOST, tmux: null, kind: 'resume' },
  ]
  const buckets: ActivityBucket[] = []
  const commits: CommitRecord[] = []
  const temporal: TemporalFetchers = {
    activity: async (fromMs, toMs) => ({ host: WORKSPACE_HOST, from_ms: fromMs, to_ms: toMs, buckets, origins }),
    sessions: async sinceMs => ({ host: WORKSPACE_HOST, records: sessions.filter(record => record.at >= sinceMs), origins }),
    commits: async (fromMs, toMs) => ({ host: WORKSPACE_HOST, records: commits.filter(record => record.at >= fromMs && record.at < toMs), origins }),
  }
  const feed = {
    host: WORKSPACE_HOST,
    generated_at: iso(0),
    fibers: rows,
    origins: {
      [WORKSPACE_HOST]: { kind: 'local', stale: false, last_polled_at: iso(0), fiber_count: rows.length - 1 },
      [WORKSPACE_REMOTE]: { kind: 'remote', stale: false, last_polled_at: iso(-minute), fiber_count: 2 },
    },
  }
  const fiberIndex = [
    ...rows.map(row => {
      const fiber = row.fiber as Record<string, unknown>
      return { id: String(fiber.id), name: String(fiber.name) }
    }),
    { id: 'research/workspace/method-note', name: 'Method note' },
  ]
  const fileMap = new Map(files.map(item => [key(item.owner, item.path), item]))
  const fileResponse = (url: string, method: string, requestHeaders?: HeadersInit): Response => {
    const parsed = new URL(url, 'http://workspace-harness.invalid')
    const path = parsed.searchParams.get('path') ?? ''
    const owner = parsed.searchParams.get('origin') || WORKSPACE_HOST
    // Theme comparisons show each bundled base without the custom fixture layer.
    const found = path === `${mainDir}/theme.css` && previewFor(WORKSPACE_UID) ? undefined : fileMap.get(key(owner, path))
    if (parsed.pathname.endsWith('/file-info')) {
      return new Response(JSON.stringify(found
        ? { exists: true, size: found.body.size, modified_at: Math.floor(now / 1000) }
        : { exists: false }), { headers: { 'Content-Type': 'application/json' } })
    }
    if (!found) return new Response(null, { status: 404, statusText: 'Not Found' })
    // Shaped like the daemon's content-digest validator, so conditional reads answer 304.
    const etag = `W/"sha256-${fixtureDigest(`${owner}:${path}:${found.body.size}`)}"`
    const request = new Headers(requestHeaders)
    if (request.get('If-None-Match') === etag) return new Response(null, { status: 304, headers: { ETag: etag } })
    const headers = new Headers({ 'Content-Type': found.mime, 'Content-Length': String(found.body.size), ETag: etag, 'Accept-Ranges': 'bytes' })
    if (method.toUpperCase() === 'HEAD') return new Response(null, { status: 200, headers })
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.get('Range') ?? '')
    if (range) {
      const first = Number(range[1])
      const last = Math.min(found.body.size - 1, range[2] ? Number(range[2]) : found.body.size - 1)
      headers.set('Content-Range', `bytes ${first}-${last}/${found.body.size}`)
      headers.set('Content-Length', String(last - first + 1))
      return new Response(found.body.slice(first, last + 1), { status: 206, headers })
    }
    return new Response(found.body, { status: 200, headers })
  }
  return {
    host: WORKSPACE_HOST,
    remote: WORKSPACE_REMOTE,
    feed,
    bodies,
    sessions,
    temporal,
    files,
    receipts,
    fiberIndex,
    fileResponse,
  }
}
