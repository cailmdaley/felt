// The board's idle cost in WebKit: CPU seconds burned by the WebKit processes
// over a window while the board sits on the Desk (or a channel), plus what the
// page keeps alive — running animations, rAF callbacks, timers fired.
//   node scripts/perf/webkit-idle.mjs [base] [desk|channel] [secs] [noanim]
// `noanim` stops every CSS animation and transition, to isolate their share.
import { execSync } from 'node:child_process'
import { webkit } from 'playwright-core'

const [, , base = 'http://localhost:5186/', view = 'desk', secsArg = '120', variant = ''] = process.argv
const secs = Number(secsArg)
const before = new Set(execSync('ps -A -o pid=').toString().split(/\s+/).filter(Boolean))
const browser = await webkit.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.addInitScript(() => {
  const counts = window.__counts = { raf: 0, timeoutFires: 0, intervalFires: 0 }
  const raf = window.requestAnimationFrame, st = window.setTimeout, si = window.setInterval
  window.requestAnimationFrame = function (fn) { counts.raf++; return raf.call(this, fn) }
  window.setTimeout = function (fn, ...r) { return st.call(this, typeof fn === 'function' ? (...a) => { counts.timeoutFires++; return fn(...a) } : fn, ...r) }
  window.setInterval = function (fn, ...r) { return si.call(this, typeof fn === 'function' ? (...a) => { counts.intervalFires++; return fn(...a) } : fn, ...r) }
})
const page = await ctx.newPage()
let bytes = 0, requests = 0
ctx.on('requestfinished', async r => { requests++; try { bytes += (await r.sizes()).responseBodySize } catch {} })
await page.goto(base)
await page.waitForSelector('.kbn-desk .kbn-card', { timeout: 60000 })
if (view === 'channel') await page.evaluate(() => document.querySelector('.kbn-desk .kbn-card').click())
if (variant === 'noanim') await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important }' })
await page.waitForTimeout(15000)
const pids = execSync('ps -A -o pid=,command=').toString().split('\n')
  .map(l => l.trim().match(/^(\d+)\s+(.*)$/)).filter(m => m && !before.has(m[1]) && /WebKit|webkit/i.test(m[2])).map(m => m[1])
const cpu = () => Object.fromEntries(execSync(`ps -o pid=,time=,rss=,command= -p ${pids.join(',')}`).toString().trim().split('\n').map(l => {
  const [pid, time, rss, ...cmd] = l.trim().split(/\s+/)
  const [m, s] = time.split(':'); return [pid, { cpu: Number(m) * 60 + Number(s), rssMB: Math.round(Number(rss) / 1024), cmd: cmd.join(' ').split('/').pop().slice(0, 40) }]
}))
const c0 = cpu(); const k0 = await page.evaluate(() => ({ ...window.__counts })); const r0 = requests, b0 = bytes
await page.waitForTimeout(secs * 1000)
const c1 = cpu(); const k1 = await page.evaluate(() => ({ ...window.__counts }))
const anims = await page.evaluate(() => document.getAnimations().map(a => `${a.animationName ?? a.constructor.name} on ${a.effect?.target?.className?.toString().slice(0, 50)}`))
const procs = Object.entries(c1).map(([pid, p]) => ({ pid, proc: p.cmd, cpuPct: +((p.cpu - (c0[pid]?.cpu ?? 0)) / secs * 100).toFixed(2), rssMB: p.rssMB }))
console.log(JSON.stringify({ base, view, secs, procs, perSecond: Object.fromEntries(Object.keys(k1).map(k => [k, +((k1[k] - k0[k]) / secs).toFixed(2)])), requests: requests - r0, kB: Math.round((bytes - b0) / 1024), runningAnimations: anims }, null, 1))
await browser.close()
