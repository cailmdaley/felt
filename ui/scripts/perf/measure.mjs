// The board's load, idle and interaction costs, against a running board (the
// daemon at :4000, or `vite preview` of a build, which proxies /api to it).
// Read-only: it clicks cards and presses Escape and arrow keys, never a verdict,
// launch or composer.
//   node scripts/perf/measure.mjs <mode> [--base URL[,URL…]] [--cpu 4] [--secs 300] [--runs 3] [--json out]
// cold          first paint, Desk painted, channel open, long tasks; several
//               --base URLs run interleaved, so the comparison shares conditions
// idle-desk     over --secs: tab CPU, script/layout/style time, heap, DOM nodes,
// idle-channel  requests and bytes by path, timers fired, long tasks
// interact      long tasks and dropped frames while hovering cards, scrolling,
//               opening a channel and switching between the Desk and the reader
import { writeFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const args = process.argv.slice(2)
const mode = args[0]
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1] }
const base = flag('--base', 'http://localhost:5186/')
const cpu = Number(flag('--cpu', '1'))
const secs = Number(flag('--secs', '300'))
const runs = Number(flag('--runs', '3'))
const card = flag('--card', null)
const jsonOut = flag('--json', null)
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await chromium.launch({ executablePath: chrome, headless: true })
const med = xs => { const s = [...xs].filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }

const probe = () => {
  window.__long = []
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__long.push({ s: e.startTime, d: e.duration }) }).observe({ type: 'longtask', buffered: true }) } catch {}
  const counts = window.__timers = { timeout: 0, interval: 0, intervalFires: 0, raf: 0, timeoutFires: 0 }
  const st = window.setTimeout, si = window.setInterval, raf = window.requestAnimationFrame
  window.setTimeout = function (fn, ...r) { counts.timeout++; return st.call(this, typeof fn === 'function' ? (...a) => { counts.timeoutFires++; return fn(...a) } : fn, ...r) }
  window.setInterval = function (fn, ...r) { counts.interval++; return si.call(this, typeof fn === 'function' ? (...a) => { counts.intervalFires++; return fn(...a) } : fn, ...r) }
  window.requestAnimationFrame = function (fn) { counts.raf++; return raf.call(this, fn) }
  new MutationObserver((_, o) => { if (document.querySelector('.kbn-desk .kbn-card')) { o.disconnect(); raf.call(window, () => { window.__deskPainted = performance.now() }) } }).observe(document, { subtree: true, childList: true })
  window.__frames = []
  const loop = t => { window.__frames.push(t); raf.call(window, loop) }
  raf.call(window, loop)
}

async function open(viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport })
  await context.addInitScript(probe)
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('Performance.enable')
  if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu })
  const reqs = []
  context.on('requestfinished', async r => {
    try { const s = await r.sizes(); reqs.push({ at: Date.now(), url: r.url(), bytes: s.responseBodySize + s.responseHeadersSize, api: r.url().includes('/api/') }) } catch {}
  })
  return { context, page, cdp, reqs }
}
const metrics = async cdp => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
const longSince = (page, since) => page.evaluate(s => { const t = window.__long.filter(x => x.s >= s); return { n: t.length, total: Math.round(t.reduce((a, x) => a + x.d, 0)), max: Math.round(Math.max(0, ...t.map(x => x.d))) } }, since)
const framesSince = (page, since) => page.evaluate(s => { const f = window.__frames.filter(t => t >= s); let dropped = 0, worst = 0; for (let i = 1; i < f.length; i++) { const d = f[i] - f[i - 1]; worst = Math.max(worst, d); if (d > 25) dropped += Math.round(d / 16.67) - 1 } return { frames: f.length, dropped, worst: Math.round(worst) } }, since)

async function waitDesk(page) {
  await page.waitForSelector('.kbn-desk .kbn-card', { timeout: 60000 })
  return page.evaluate(() => performance.now())
}
// Interactive: first 500 ms window after the Desk paints with no long task.
async function waitQuiet(page, from) {
  return page.evaluate(from => new Promise(res => {
    const check = () => {
      const now = performance.now()
      const last = Math.max(from, ...window.__long.map(x => x.s + x.d))
      if (now - last >= 500) res(last); else setTimeout(check, 100)
    }
    check()
  }), from)
}
async function openChannel(page) {
  const t = await page.evaluate(name => {
    const cards = [...document.querySelectorAll('.kbn-desk .kbn-card')]
    const c = (name && cards.find(x => x.querySelector('.kbn-card-name')?.textContent === name)) || cards[0]
    window.__openStart = performance.now(); c.click(); return c.querySelector('.kbn-card-name')?.textContent
  }, card)
  await page.waitForFunction(() => {
    const p = document.querySelector('.ws-page.ws-selected'); if (!p) return false
    const v = p.querySelector('.ws-document-viewer')
    const ready = v ? v.style.opacity !== '0' || !!p.querySelector('.ws-document-state') : !!p.querySelector('.ws-content > :not(.ws-placeholder)')
    const loading = [...document.querySelectorAll('.ws-selected .ws-body-status')].some(n => n.textContent.startsWith('Loading'))
    return ready && !loading
  }, null, { timeout: 60000, polling: 'raf' })
  return { name: t, ms: await page.evaluate(() => performance.now() - window.__openStart) }
}

const out = { mode, base, cpu }
if (mode === 'cold') {
  const bases = base.split(',')
  const per = Object.fromEntries(bases.map(b => [b, []]))
  for (let i = 0; i < runs; i++) for (const b of bases) {
    const s = await open()
    await s.page.goto(b)
    await waitDesk(s.page)
    await s.page.waitForFunction(() => window.__deskPainted, null, { timeout: 60000 })
    const desk = await s.page.evaluate(() => window.__deskPainted)
    const fcp = await s.page.evaluate(() => performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null)
    const quiet = await waitQuiet(s.page, desk)
    const ch = await openChannel(s.page)
    const lt = await longSince(s.page, 0)
    const m = await metrics(s.cdp)
    const res = await s.page.evaluate(() => Object.fromEntries(performance.getEntriesByType('resource').filter(e => /fibers\/composite|index-.*\.(js|css)$|googleapis/.test(e.name)).map(e => [e.name.replace(/.*\/(api\/v1\/)?/, '').slice(0, 24), Math.round(e.responseEnd)])))
    const js = s.reqs.filter(r => /\.js$/.test(r.url)).reduce((a, r) => a + r.bytes, 0)
    per[b].push({ fcp: Math.round(fcp), desk: Math.round(desk), interactive: Math.round(quiet), channel: Math.round(ch.ms), longTasks: lt, scriptMs: Math.round(m.ScriptDuration * 1000), heapMB: +(m.JSHeapUsedSize / 1e6).toFixed(1), jsBytes: js, res })
    await s.context.close()
  }
  out.runs = per
  out.median = Object.fromEntries(bases.map(b => [b, Object.fromEntries(['fcp', 'desk', 'interactive', 'channel', 'scriptMs', 'heapMB', 'jsBytes'].map(k => [k, med(per[b].map(r => r[k]))]))]))
} else if (mode === 'idle-desk' || mode === 'idle-channel') {
  const s = await open()
  await s.page.goto(base)
  const desk = await waitDesk(s.page)
  await waitQuiet(s.page, desk)
  if (mode === 'idle-channel') { await openChannel(s.page); await s.page.waitForTimeout(3000) }
  await s.page.evaluate(() => { window.gc?.() })
  const m0 = await metrics(s.cdp); const t0 = Date.now(); const p0 = await s.page.evaluate(() => performance.now())
  const tm0 = await s.page.evaluate(() => ({ ...window.__timers }))
  const n0 = s.reqs.length
  await s.page.waitForTimeout(secs * 1000)
  const m1 = await metrics(s.cdp); const tm1 = await s.page.evaluate(() => ({ ...window.__timers }))
  const rq = s.reqs.slice(n0).filter(r => r.at >= t0)
  const byPath = {}
  for (const r of rq) { const k = new URL(r.url).pathname.replace(/\/[0-9A-Z]{26}/g, '/:id'); byPath[k] ??= { n: 0, bytes: 0 }; byPath[k].n++; byPath[k].bytes += r.bytes }
  const d = k => m1[k] - m0[k]
  out.secs = secs
  out.cpuPct = +((d('TaskDuration') / secs) * 100).toFixed(2)
  out.scriptMs = Math.round(d('ScriptDuration') * 1000)
  out.layoutMs = Math.round(d('LayoutDuration') * 1000)
  out.styleMs = Math.round(d('RecalcStyleDuration') * 1000)
  out.layouts = d('LayoutCount'); out.styleRecalcs = d('RecalcStyleCount')
  out.heapMB0 = +(m0.JSHeapUsedSize / 1e6).toFixed(1); out.heapMB1 = +(m1.JSHeapUsedSize / 1e6).toFixed(1)
  out.nodes = [m0.Nodes, m1.Nodes]
  out.requests = rq.length; out.kB = Math.round(rq.reduce((a, r) => a + r.bytes, 0) / 1024)
  out.byPath = byPath
  out.timers = Object.fromEntries(Object.keys(tm1).map(k => [k, tm1[k] - tm0[k]]))
  out.longTasks = await longSince(s.page, p0)
  await s.context.close()
} else if (mode === 'interact') {
  const s = await open(); const p = s.page
  await p.goto(base); const desk = await waitDesk(p); await waitQuiet(p, desk)
  const res = {}
  const span = async (name, fn) => { await p.waitForTimeout(500); const t = await p.evaluate(() => performance.now()); await fn(); await p.waitForTimeout(300); res[name] = { ...(await longSince(p, t)), ...(await framesSince(p, t)) } }
  await span('hoverCards', async () => { const cs = await p.locator('.kbn-desk .kbn-card').all(); for (const c of cs.slice(0, 20)) { await c.hover(); await p.waitForTimeout(40) } })
  await span('scrollColumn', async () => { await p.mouse.move(300, 500); for (let i = 0; i < 20; i++) { await p.mouse.wheel(0, 120); await p.waitForTimeout(16) } for (let i = 0; i < 20; i++) { await p.mouse.wheel(0, -120); await p.waitForTimeout(16) } })
  await span('openChannel', async () => { await openChannel(p) })
  await span('stepPages', async () => { for (let i = 0; i < 5; i++) { await p.keyboard.press('ArrowRight'); await p.waitForTimeout(400) } })
  await span('sidebar', async () => { await p.keyboard.press('Tab'); await p.waitForTimeout(300); const b = p.locator('[aria-label*="sidebar" i]').first(); if (await b.count()) { await b.click(); await p.waitForTimeout(500); await b.click(); await p.waitForTimeout(500) } })
  await span('deskReaderSwitch', async () => { for (let i = 0; i < 3; i++) { await p.keyboard.press('Escape'); await p.waitForSelector('.kbn-desk .kbn-card'); await p.waitForTimeout(300); await openChannel(p); await p.waitForTimeout(300) } })
  out.spans = res
  await s.context.close()
}
await browser.close()
console.log(JSON.stringify(out.median ?? out, null, 1))
if (jsonOut) await writeFile(jsonOut, JSON.stringify(out, null, 1))
