// Read-only probe: does the live board's chat change a painted frame when it refreshes?
// Records, per animation frame, where the visible chat sits, which subtrees each refresh replaces, and a CDP screencast diffed frame to frame.
// TRANSCRIPT_UID + TRANSCRIPT_OWNER route to a fiber; TRANSCRIPT_PARK is 'middle' or 'bottom'; TRANSCRIPT_PROBE_SECONDS sets the duration.
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { getBrowser } from './browser.mjs'

const url = process.env.WORKSPACE_LIVE_URL || 'http://127.0.0.1:4000/'
const uid = process.env.TRANSCRIPT_UID
const owner = process.env.TRANSCRIPT_OWNER
const park = process.env.TRANSCRIPT_PARK || 'middle'
const seconds = Number(process.env.TRANSCRIPT_PROBE_SECONDS || 60)
const outDir = process.env.TRANSCRIPT_PROBE_OUT || 'transcript-frames'
if (!uid || !owner) throw new Error('Set TRANSCRIPT_UID and TRANSCRIPT_OWNER')
await mkdir(outDir, { recursive: true })

const browser = await getBrowser({})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
await page.route('**/api/**', route => ['GET', 'HEAD'].includes(route.request().method()) ? route.continue() : route.abort())
await page.goto(`${url}#/board/${encodeURIComponent(uid)}@${encodeURIComponent(owner)}`)
await page.locator('.ws-transcript-scroll').first().waitFor()
await page.waitForFunction(() => document.querySelector('.ws-transcript-scroll')?.querySelectorAll('.ws-transcript-msg').length > 5, null, { timeout: 30000 })
await page.waitForTimeout(4000)

await page.evaluate(({ park }) => {
  const s = document.querySelector('.ws-transcript-scroll')
  s.scrollTop = park === 'bottom' ? s.scrollHeight : Math.round((s.scrollHeight - s.clientHeight) / 2)
}, { park })
await page.waitForTimeout(800)

const cdp = await page.context().newCDPSession(page)
const frames = []
cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
  frames.push({ ts: metadata.timestamp, data })
  await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
})

// The page clock and the screencast clock differ; log both at start to align them.
const t0wall = await page.evaluate(() => { window.__t0 = performance.now(); return Date.now() / 1000 })
await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 })

const log = await page.evaluate(async ({ seconds }) => {
  const t0 = window.__t0
  const s = document.querySelector('.ws-transcript-scroll')
  const now = () => Math.round((performance.now() - t0) * 10) / 10
  const ids = new WeakMap(); let nextId = 1
  const id = n => { if (!ids.has(n)) ids.set(n, nextId++); return ids.get(n) }
  const describe = n => {
    if (!(n instanceof Element)) n = n?.parentElement
    if (!n) return '?'
    const parts = []
    for (let e = n; e && parts.length < 4; e = e.parentElement) parts.push(e.className && typeof e.className === 'string' ? `${e.tagName.toLowerCase()}.${e.className.split(' ')[0]}` : e.tagName.toLowerCase())
    return parts.join('<')
  }
  const mutations = []
  const observer = new MutationObserver(records => {
    const t = now()
    for (const r of records) {
      if (r.type === 'childList') mutations.push({ t, kind: 'child', at: describe(r.target), added: [...r.addedNodes].map(describe).slice(0, 3), removed: [...r.removedNodes].map(n => n instanceof Element ? `${n.tagName.toLowerCase()}.${String(n.className).split(' ')[0]}#${id(n)}` : n.nodeName).slice(0, 3), a: r.addedNodes.length, r: r.removedNodes.length })
      else if (r.type === 'attributes') mutations.push({ t, kind: 'attr', at: describe(r.target), name: r.attributeName })
      else mutations.push({ t, kind: 'text', at: describe(r.target) })
    }
  })
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
  const writes = []
  const native = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
  Object.defineProperty(s, 'scrollTop', { configurable: true, get() { return native.get.call(this) }, set(v) { writes.push({ t: now(), from: native.get.call(this), to: v, sTop: this.getBoundingClientRect().top, sh: this.scrollHeight, ch: this.clientHeight, stack: new Error().stack.split('\n').slice(2, 9).map(l => l.trim().replace(/https?:\/\/[^ ]*\/assets\//, '')) }); native.set.call(this, v) } })

  // Per frame: the screen position of every message intersecting the viewport, keyed by node identity.
  const visible = s => {
    const box = s.getBoundingClientRect()
    const out = []
    for (const m of s.querySelectorAll('.ws-transcript-msg, .ws-transcript-turn, .ws-transcript-row')) {
      const r = m.getBoundingClientRect()
      if (r.bottom < box.top || r.top > box.bottom || r.height === 0) continue
      out.push([id(m), Math.round(r.top * 10) / 10, Math.round(r.height * 10) / 10])
    }
    return out
  }
  const samples = []
  const sample = phase => {
    const cur = document.querySelector('.ws-transcript-scroll')
    const all = document.querySelectorAll('.ws-transcript-scroll').length
    const el = cur ?? s
    samples.push({ t: now(), phase, sid: cur ? id(cur) : null, n: all, st: Math.round(native.get.call(el) * 10) / 10, sh: el.scrollHeight, ch: el.clientHeight, sTop: Math.round(el.getBoundingClientRect().top * 10) / 10, vis: cur ? visible(cur) : [] })
  }
  const ro = new ResizeObserver(() => sample('resize'))
  ro.observe(s); for (const c of s.children) ro.observe(c)
  await new Promise(resolve => {
    const tick = () => { sample('raf'); if (performance.now() - t0 < seconds * 1000) requestAnimationFrame(tick); else resolve() }
    requestAnimationFrame(tick)
  })
  observer.disconnect(); ro.disconnect()
  return { samples, mutations, writes }
}, { seconds })

await cdp.send('Page.stopScreencast')

// Frame-to-frame: a message that stays the same node and moves on screen while scrollTop did not move it, or a replaced node.
const jumps = []
for (let i = 1; i < log.samples.length; i++) {
  const a = log.samples[i - 1], b = log.samples[i]
  const before = new Map(a.vis.map(([k, top, h]) => [k, { top, h }]))
  let moved = null, replaced = 0
  for (const [k, top] of b.vis) {
    const p = before.get(k)
    if (!p) { replaced++; continue }
    if (Math.abs(top - p.top) > 1 && (!moved || Math.abs(top - p.top) > Math.abs(moved.dy))) moved = { key: k, dy: Math.round((top - p.top) * 10) / 10 }
  }
  if (b.sid !== a.sid || (b.st === 0 && a.st > 0)) jumps.push({ t: b.t, phase: b.phase, scroller: [a.sid, b.sid], n: b.n, st: [a.st, b.st], sh: [a.sh, b.sh] })
  if (moved || (replaced && b.vis.length && replaced >= b.vis.length / 2)) jumps.push({ t: b.t, phase: b.phase, moved, replaced, of: b.vis.length, dst: Math.round((b.st - a.st) * 10) / 10, dsh: b.sh - a.sh, dsTop: b.sTop - a.sTop })
}

// Screencast: hash each frame; save frames around each change.
const hashed = frames.map(f => ({ ts: f.ts, hash: createHash('md5').update(f.data).digest('hex'), data: f.data }))
const changes = []
for (let i = 1; i < hashed.length; i++) if (hashed[i].hash !== hashed[i - 1].hash) changes.push({ i, t: Math.round((hashed[i].ts - t0wall) * 1000) })
// Save the painted frame pair nearest each jump: the frame before it and the first frame after.
for (const c of changes.filter(c => jumps.some(j => c.t >= j.t - 20 && c.t <= j.t + 80)).slice(0, 20)) {
  await writeFile(`${outDir}/frame-${String(c.i).padStart(5, '0')}-t${c.t}.png`, Buffer.from(hashed[c.i].data, 'base64'))
  await writeFile(`${outDir}/frame-${String(c.i - 1).padStart(5, '0')}-prev.png`, Buffer.from(hashed[c.i - 1].data, 'base64'))
}
const mutationBursts = []
for (const m of log.mutations) {
  const last = mutationBursts.at(-1)
  if (last && m.t - last.t1 < 50) { last.t1 = m.t; last.n++; if (last.kinds.size < 12) last.kinds.add(`${m.kind}:${m.at}${m.kind === 'child' ? ` +${m.a}-${m.r}` : m.name ? `@${m.name}` : ''}`) }
  else mutationBursts.push({ t0: m.t, t1: m.t, n: 1, kinds: new Set([`${m.kind}:${m.at}`]) })
}
const summary = {
  uid, park, seconds, rafSamples: log.samples.filter(x => x.phase === 'raf').length,
  frames: frames.length, frameChanges: changes.length, frameChangeTimes: changes.map(c => c.t).slice(0, 60),
  jumps: jumps.slice(0, 40), scrollers: [...new Set(log.samples.map(x => x.sid))], zeroFrames: log.samples.filter(x => x.st === 0).length, writes: log.writes,
  bursts: mutationBursts.map(b => ({ t: b.t0, n: b.n, kinds: [...b.kinds] })).slice(0, 60),
  errors,
}
await writeFile(`${outDir}/log.json`, JSON.stringify({ summary, samples: log.samples, mutations: log.mutations }, null, 1))
console.log(JSON.stringify(summary, null, 1))
await page.close()
await browser.close()
