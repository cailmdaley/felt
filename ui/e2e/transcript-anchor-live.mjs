// Read-only probe: does the live board's transcript move under a reader parked mid-scroll?
// TRANSCRIPT_CARD names a Desk card to open, or TRANSCRIPT_UID with its owning host TRANSCRIPT_OWNER a fiber to route to; TRANSCRIPT_PROBE_SECONDS sets the duration.
import { writeFile } from 'node:fs/promises'
import { getBrowser } from './browser.mjs'

const url = process.env.WORKSPACE_LIVE_URL || 'http://127.0.0.1:4000/'
const card = process.env.TRANSCRIPT_CARD
const uid = process.env.TRANSCRIPT_UID
const owner = process.env.TRANSCRIPT_OWNER
const seconds = Number(process.env.TRANSCRIPT_PROBE_SECONDS || 180)
const out = process.env.TRANSCRIPT_PROBE_OUT || 'transcript-anchor-live.json'
if (!card && !uid) throw new Error('Set TRANSCRIPT_CARD to a card name or TRANSCRIPT_UID to a fiber id')
if (uid && !owner) throw new Error('Set TRANSCRIPT_OWNER to the host id that owns TRANSCRIPT_UID')

const browser = await getBrowser({})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
await page.route('**/api/**', route => ['GET', 'HEAD'].includes(route.request().method()) ? route.continue() : route.abort())
if (uid) await page.goto(`${url}#/board/${encodeURIComponent(uid)}@${encodeURIComponent(owner)}`)
else {
  await page.goto(url)
  await page.locator('.kbn-card').filter({ hasText: card }).first().click()
}
const scroller = page.locator('.ws-transcript-scroll').first()
await scroller.waitFor()
await page.waitForFunction(() => document.querySelector('.ws-transcript-scroll')?.querySelectorAll('.ws-transcript-msg').length > 5, null, { timeout: 30000 })
await page.waitForTimeout(3000)

const log = await page.evaluate(async ({ seconds }) => {
  const s = document.querySelector('.ws-transcript-scroll')
  s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) / 2)
  await new Promise(r => setTimeout(r, 500))
  const edge = () => s.getBoundingClientRect().top
  const anchor = [...s.querySelectorAll('.ws-transcript-msg')].find(n => n.getBoundingClientRect().bottom > edge() + 40)
  const key = anchor?.dataset.readingKey
  const t0 = performance.now()
  const describe = n => {
    if (!(n instanceof Element)) n = n?.parentElement
    if (!n) return '?'
    const parts = []
    for (let e = n; e && parts.length < 4; e = e.parentElement) parts.push(e.className ? `${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]}` : e.tagName.toLowerCase())
    return parts.join('<')
  }
  let mutations = []
  const observer = new MutationObserver(records => {
    for (const r of records) mutations.push(`${r.type}:${describe(r.target)}${r.type === 'childList' ? ` +${r.addedNodes.length}-${r.removedNodes.length}` : r.attributeName ? `@${r.attributeName}` : ''}`)
  })
  observer.observe(document.querySelector('.ws-transcript') ?? s, { subtree: true, childList: true, attributes: true, characterData: true })
  // Any write of the position, even of its current value, stops a scroll in flight.
  const writes = []
  const native = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
  Object.defineProperty(s, 'scrollTop', { configurable: true, get() { return native.get.call(this) }, set(value) {
    writes.push({ t: Math.round(performance.now() - t0), from: native.get.call(this), to: value })
    native.set.call(this, value)
  } })
  let scrollEvents = 0
  s.addEventListener('scroll', () => scrollEvents++, { passive: true })
  const samples = []
  let first = null
  while (performance.now() - t0 < seconds * 1000) {
    const live = key ? s.querySelector(`[data-reading-key="${CSS.escape(key)}"]`) : anchor
    const top = live ? live.getBoundingClientRect().top - edge() : null
    if (first === null) first = top
    samples.push({
      t: Math.round(performance.now() - t0),
      scrollTop: Math.round(s.scrollTop), scrollHeight: s.scrollHeight, clientHeight: s.clientHeight,
      anchorTop: top === null ? null : Math.round(top * 10) / 10,
      screenTop: live ? Math.round(live.getBoundingClientRect().top * 10) / 10 : null,
      scrollerTop: Math.round(edge() * 10) / 10,
      sameNode: live === anchor, connected: anchor?.isConnected, scroller: s.isConnected,
      scrollEvents, mutations: [...new Set(mutations)].slice(0, 12), mutationCount: mutations.length,
    })
    mutations = []; scrollEvents = 0
    await new Promise(r => setTimeout(r, 250))
  }
  observer.disconnect()
  return { key, first, samples, writes }
}, { seconds })

const moved = (x, y) => x !== null && y !== null && Math.abs(x - y) > 1
const moves = log.samples.filter((x, i, a) => i && (moved(x.anchorTop, a[i - 1].anchorTop) || moved(x.screenTop, a[i - 1].screenTop)))
const summary = {
  card: card ?? uid, key: log.key, samples: log.samples.length,
  maxDrift: Math.max(...log.samples.map(x => x.anchorTop === null ? Infinity : Math.abs(x.anchorTop - log.first))),
  moves: moves.map(m => ({ t: m.t, anchorTop: m.anchorTop, screenTop: m.screenTop, scrollerTop: m.scrollerTop, scrollTop: m.scrollTop, scrollHeight: m.scrollHeight, mutations: m.mutations })),
  writes: log.writes.length,
  idleWrites: log.writes.filter(w => Math.abs(w.to - w.from) < 0.5).length,
  lost: log.samples.filter(x => x.anchorTop === null).length,
  errors,
}
await writeFile(out, JSON.stringify({ summary, samples: log.samples, writes: log.writes }, null, 2))
console.log(JSON.stringify(summary, null, 2))
await page.close()
await browser.close()
