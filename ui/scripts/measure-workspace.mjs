// Measure the document workspace against a running board (live data or the
// harness): Desk card → first page, page steps, channel switches, the Board
// overview's first thumbnails, the phone reader, every /api request per phase
// (count, bytes, duplicate reads of one document, time queued before send) and
// main-thread long tasks. Read-only: it clicks cards, steps pages and presses
// j / 3 / Escape, never a verdict, launch or composer.
//
//   node scripts/measure-workspace.mjs --base http://127.0.0.1:5198/ \
//     --cards "Card name A" "Card name B" [--runs 3] [--json out.json]
//
// Each run is cold (a fresh browser context: empty HTTP cache and storage),
// then warm (the same context reloaded). Times are medians over runs.
import { writeFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const args = process.argv.slice(2)
const flag = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] }
const list = name => { const i = args.indexOf(name); if (i < 0) return []; const out = []; for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j++) out.push(args[j]); return out }
const base = flag('--base', 'http://127.0.0.1:4000/')
const cards = list('--cards')
const runs = Number(flag('--runs', '3'))
const steps = Number(flag('--steps', '3'))
const jsonOut = flag('--json', null)
const devices = list('--devices').length ? list('--devices') : ['desktop', 'phone']
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
if (!cards.length) throw new Error('--cards needs a Desk card name')

const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
}
const TIMEOUT = 30_000

const longTaskProbe = () => {
  window.__perfLong = []
  try {
    new PerformanceObserver(list => { for (const e of list.getEntries()) window.__perfLong.push({ start: e.startTime, duration: e.duration }) })
      .observe({ type: 'longtask', buffered: true })
  } catch { /* unsupported */ }
}

function documentOf(url) {
  try {
    const u = new URL(url)
    if (u.pathname.endsWith('/api/v1/file') || u.pathname.endsWith('/api/v1/file-info')) return u.searchParams.get('path')
    const asset = u.pathname.match(/\/api\/v1\/file-assets\/[^/]+(\/.*)$/)
    if (asset) return decodeURIComponent(asset[1])
    if (u.pathname.match(/\/api\/v1\/fibers\//)) return `fiber:${u.pathname.split('/').pop()}`
  } catch { /* opaque */ }
  return null
}

async function session(device, label) {
  const context = await browser.newContext(VIEWPORTS[device])
  await context.addInitScript(longTaskProbe)
  const page = await context.newPage()
  const requests = []
  let phase = 'load'
  context.on('request', r => {
    if (!r.url().includes('/api/')) return
    requests.push({ r, phase, url: r.url(), method: r.method(), range: r.headers().range ?? null, at: Date.now(), done: false })
  })
  const finish = async (r, failed) => {
    const rec = requests.find(x => x.r === r)
    if (!rec) return
    rec.done = true; rec.failed = failed
    try {
      const response = failed ? null : await r.response()
      rec.status = response?.status() ?? null
      const t = r.timing()
      rec.queued = t.requestStart >= 0 ? t.requestStart : null
      rec.ttfb = t.responseStart >= 0 && t.requestStart >= 0 ? t.responseStart - t.requestStart : null
      rec.total = t.responseEnd >= 0 ? t.responseEnd : null
      rec.bytes = failed ? 0 : (await r.sizes()).responseBodySize
      rec.fromCache = response ? (await response.headerValue('x-from-cache')) !== null : false
    } catch { /* torn down */ }
  }
  context.on('requestfinished', r => void finish(r, false))
  context.on('requestfailed', r => void finish(r, true))
  return { context, page, requests, setPhase: p => { phase = p }, label, device }
}

// The selected page counts as painted once its viewer has revealed (or shows its
// failure state), the fiber body is no longer loading, and the selection has held
// for 600 ms; the time reported is when that final page first became ready.
function settled([start, before]) {
  const st = (window.__settle ??= {})
  const page = document.querySelector('.ws-page.ws-selected')
  const key = page?.dataset.key
  const title = document.querySelector('.ws-channel-title')?.textContent ?? ''
  const viewer = page?.querySelector('.ws-document-viewer')
  const ready = !!page && (viewer ? viewer.style.opacity !== '0' || !!page.querySelector('.ws-document-state')
    : !!page.querySelector('.ws-content > :not(.ws-placeholder)'))
  const loading = [...document.querySelectorAll('.ws-selected .ws-body-status')].some(n => n.textContent.startsWith('Loading'))
  const moved = `${title}|${key}` !== before
  const now = performance.now()
  if (!moved || !ready || loading || st.key !== `${title}|${key}`) {
    st.key = `${title}|${key}`
    st.readyAt = moved && ready && !loading ? now : null
    return false
  }
  st.readyAt ??= now
  return now - st.readyAt >= 600 ? st.readyAt - start : false
}

async function timed(page, action) {
  const before = await page.evaluate(() => { window.__settle = {}; return `${document.querySelector('.ws-channel-title')?.textContent ?? ''}|${document.querySelector('.ws-page.ws-selected')?.dataset.key}` })
  const start = await page.evaluate(() => performance.now())
  await action()
  const handle = await page.waitForFunction(settled, [start, before], { timeout: TIMEOUT, polling: 'raf' })
  return handle.jsonValue()
}

async function openCard(page, name) {
  return timed(page, () => page.evaluate(name => {
    const card = [...document.querySelectorAll('.kbn-desk .kbn-card')].find(c => c.querySelector('.kbn-card-name')?.textContent === name)
    if (!card) throw new Error(`no Desk card named ${name}`)
    card.click()
  }, name))
}

async function step(page, device) {
  return timed(page, device === 'phone'
    ? () => page.evaluate(() => document.querySelector('[aria-label="Next document"]')?.click())
    : () => page.keyboard.press('ArrowRight'))
}

async function switchChannel(page) {
  return timed(page, () => page.keyboard.press('j'))
}

async function overview(page) {
  await page.keyboard.press('Escape')
  await page.waitForSelector('.kbn-desk .kbn-card', { timeout: TIMEOUT })
  await page.waitForTimeout(300)
  const start = await page.evaluate(() => performance.now())
  await page.keyboard.press('3')
  await page.waitForSelector('.ws-overview-folio', { timeout: TIMEOUT })
  const folios = (await page.evaluate(() => performance.now())) - start
  let first = null
  try {
    await page.waitForSelector('.ws-thumbnail-ready', { timeout: 10_000 })
    first = (await page.evaluate(() => performance.now())) - start
  } catch { /* none within 10 s */ }
  await page.waitForTimeout(Math.max(0, 3000 - ((await page.evaluate(() => performance.now())) - start)))
  const at3s = await page.locator('.ws-thumbnail-ready').count()
  const visible = await page.evaluate(() => [...document.querySelectorAll('.ws-thumbnail')].filter(t => { const r = t.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.width > 0 }).length)
  return { folios, first, at3s, visible }
}

function summarise(requests, phase) {
  const rs = requests.filter(r => r.phase === phase)
  const docs = new Map()
  for (const r of rs) {
    const doc = documentOf(r.url)
    if (!doc) continue
    const kind = `${r.method}${r.range ? ' range' : ''}`
    const entry = docs.get(doc) ?? []
    entry.push(kind); docs.set(doc, entry)
  }
  const duplicates = [...docs.values()].filter(kinds => kinds.filter(k => k.startsWith('GET')).length > 1).length
  const extraGets = [...docs.values()].reduce((sum, kinds) => sum + Math.max(0, kinds.filter(k => k.startsWith('GET')).length - 1), 0)
  const queued = rs.map(r => r.queued).filter(q => q != null).sort((a, b) => a - b)
  return {
    requests: rs.length,
    bytes: rs.reduce((s, r) => s + (r.bytes ?? 0), 0),
    documents: docs.size,
    duplicateDocs: duplicates,
    extraGets,
    heads: rs.filter(r => r.method === 'HEAD').length,
    status304: rs.filter(r => r.status === 304).length,
    queuedMax: queued.length ? Math.round(queued.at(-1)) : 0,
    queuedP50: queued.length ? Math.round(queued[Math.floor(queued.length / 2)]) : 0,
  }
}

async function longTasks(page, since) {
  return page.evaluate(since => {
    const tasks = (window.__perfLong ?? []).filter(t => t.start >= since)
    return { count: tasks.length, total: Math.round(tasks.reduce((s, t) => s + t.duration, 0)), max: Math.round(Math.max(0, ...tasks.map(t => t.duration))) }
  }, since)
}

async function scenario(s, warm) {
  const { page, device } = s
  const out = {}
  s.setPhase('load')
  const loadStart = Date.now()
  // Warm starts again from the Desk, keeping the HTTP cache and storage.
  if (warm) await page.goto('about:blank')
  await page.goto(base)
  await page.waitForSelector('.kbn-desk .kbn-card', { timeout: TIMEOUT })
  out.deskMs = Date.now() - loadStart
  await page.waitForTimeout(1500)
  const mark = async name => { s.setPhase(name); return page.evaluate(() => performance.now()) }

  let t0 = await mark('open')
  out.openMs = await openCard(page, cards[0])
  await page.waitForTimeout(2500)
  out.openLong = await longTasks(page, t0)

  t0 = await mark('step')
  out.stepMs = []
  for (let i = 0; i < steps; i++) { out.stepMs.push(await step(page, device)); await page.waitForTimeout(700) }
  out.stepLong = await longTasks(page, t0)

  t0 = await mark('switch')
  out.switchMs = await switchChannel(page)
  await page.waitForTimeout(2500)
  out.switchLong = await longTasks(page, t0)

  if (device === 'desktop') {
    t0 = await mark('overview')
    out.overview = await overview(page)
    out.overviewLong = await longTasks(page, t0)
  }
  await page.waitForTimeout(500)
  for (const phase of ['load', 'open', 'step', 'switch', 'overview']) out[`net_${phase}`] = summarise(s.requests, phase)
  out.requests = s.requests.map(({ r, ...rest }) => ({ ...rest, doc: documentOf(rest.url) }))
  s.requests.length = 0
  return out
}

const median = xs => { const v = xs.filter(x => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : null }
const results = []
for (const device of devices) {
  for (let run = 0; run < runs; run++) {
    const s = await session(device, `${device}#${run}`)
    try {
      const cold = await scenario(s, false)
      const warm = await scenario(s, true)
      results.push({ device, run, cold, warm })
      console.error(`${device} run ${run}: open ${Math.round(cold.openMs)}/${Math.round(warm.openMs)} ms`)
    } catch (error) {
      console.error(`${device} run ${run} failed: ${error.message}`)
    } finally { await s.context.close() }
  }
}
await browser.close()

const rows = []
for (const device of devices) for (const temp of ['cold', 'warm']) {
  const rs = results.filter(r => r.device === device).map(r => r[temp])
  if (!rs.length) continue
  const m = f => median(rs.map(f))
  const net = phase => Object.fromEntries(Object.keys(rs[0][`net_${phase}`]).map(k => [k, m(r => r[`net_${phase}`][k])]))
  rows.push({
    device, temp, runs: rs.length,
    deskMs: m(r => r.deskMs), openMs: m(r => r.openMs), stepMs: m(r => median(r.stepMs)), stepMaxMs: m(r => Math.max(...r.stepMs)),
    switchMs: m(r => r.switchMs),
    overviewFoliosMs: m(r => r.overview?.folios), overviewFirstThumbMs: m(r => r.overview?.first), overviewReadyAt3s: m(r => r.overview?.at3s),
    longOpen: m(r => r.openLong.total), longStep: m(r => r.stepLong.total), longSwitch: m(r => r.switchLong.total), longMax: m(r => Math.max(r.openLong.max, r.stepLong.max, r.switchLong.max, r.overviewLong?.max ?? 0)),
    net: { load: net('load'), open: net('open'), step: net('step'), switch: net('switch'), overview: net('overview') },
  })
}
const fmt = x => x == null ? '—' : typeof x === 'number' ? String(Math.round(x)) : x
console.log('device  temp  desk  open  step(med/max)  switch  ov-folios  ov-thumb  ov@3s  long(open/step/switch,max)')
for (const r of rows) console.log([r.device, r.temp, fmt(r.deskMs), fmt(r.openMs), `${fmt(r.stepMs)}/${fmt(r.stepMaxMs)}`, fmt(r.switchMs), fmt(r.overviewFoliosMs), fmt(r.overviewFirstThumbMs), fmt(r.overviewReadyAt3s), `${fmt(r.longOpen)}/${fmt(r.longStep)}/${fmt(r.longSwitch)},${fmt(r.longMax)}`].join('  '))
console.log('\nnetwork per phase: requests · KB · docs · dup docs · extra GETs · HEADs · 304s · queued p50/max ms')
for (const r of rows) for (const [phase, n] of Object.entries(r.net)) if (n.requests) console.log(`${r.device} ${r.temp} ${phase.padEnd(8)} ${fmt(n.requests)} · ${fmt(n.bytes / 1024)} · ${fmt(n.documents)} · ${fmt(n.duplicateDocs)} · ${fmt(n.extraGets)} · ${fmt(n.heads)} · ${fmt(n.status304)} · ${fmt(n.queuedP50)}/${fmt(n.queuedMax)}`)
if (jsonOut) await writeFile(jsonOut, JSON.stringify({ base, cards, runs, results, rows }, null, 2))
