// Headless WebKit typing probe. Build with npm run harness:board, then run
// node e2e/typing.mjs. Only the file:// mocked daemon is used.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { webkit } from 'playwright-core'

const existingPids = new Set(execFileSync('ps', ['-axo', 'pid='], { encoding: 'utf8' }).trim().split(/\s+/).map(Number))
const server = await webkit.launchServer({ headless: true })
const browser = await webkit.connect(server.wsEndpoint())
const result = { engine: 'Playwright WebKit', viewport: '1440x900', samples: {}, snapshots: [] }
const base = pathToFileURL(resolve('harness-board-dist/index.html')).href
const output = process.env.TYPING_OUTPUT || '/tmp/shuttle-typing.json'
function rss() {
  // Only descendants of this probe's browser, never the operator's browsers.
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' }).trim().split('\n').map(line => {
    const [pid, parent, kb, ...command] = line.trim().split(/\s+/)
    return { pid: +pid, parent: +parent, kb: +kb, command: command.join(' ') }
  })
  const owned = new Set([server.process().pid])
  for (let i = 0; i < rows.length; i++) for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid)
  return rows.filter(row => owned.has(row.pid) || !existingPids.has(row.pid) && row.command.includes('/ms-playwright/webkit-') && row.command.includes('.xpc/')).map(({ parent, ...row }) => row)
}
const percentile = (values, p) => [...values].sort((a,b)=>a-b)[Math.min(values.length-1, Math.floor(values.length*p))]
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    const stats = window.__typing = { styles: 0, walks: 0, keys: [], mutations: 0 }
    const listeners = window.__typingListeners = new Map()
    const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener
    const track = (target, type, listener, adding) => {
      if ((target !== window && target !== document) || !['resize', 'visibilitychange'].includes(type)) return
      const key = `${target === window ? 'window' : 'document'}:${type}`
      if (!listeners.has(key)) listeners.set(key, new Set())
      if (adding) listeners.get(key).add(listener); else listeners.get(key).delete(listener)
    }
    EventTarget.prototype.addEventListener = function (type, listener, options) { track(this, type, listener, true); return add.call(this, type, listener, options) }
    EventTarget.prototype.removeEventListener = function (type, listener, options) { track(this, type, listener, false); return remove.call(this, type, listener, options) }
    const style = window.getComputedStyle
    window.getComputedStyle = function (...args) { stats.styles++; return style.apply(this, args) }
    const walker = document.createTreeWalker
    document.createTreeWalker = function (...args) { stats.walks++; return walker.apply(this, args) }
    document.addEventListener('keydown', event => {
      if (!event.target.matches?.('input,textarea')) return
      const sample = { key: event.key, start: performance.now(), paint: null, task: null }
      stats.keys.push(sample)
      setTimeout(() => { sample.task = performance.now() - sample.start }, 0)
      // rAF is pre-paint; the task queued from it runs after that rendering turn.
      requestAnimationFrame(() => setTimeout(() => { sample.paint = performance.now() - sample.start }, 0))
    }, true)
    new MutationObserver(records => { stats.mutations += records.length }).observe(document, { childList: true, subtree: true })
  })
  await page.goto(`${base}?example=workspace&transcript=large`)
  await page.waitForFunction(() => window.__harness)
  const stageFleet = () => page.evaluate(async () => {
    const feed = window.__harness.MOCK_FEED
    const source = feed.fibers.find(row => row.fiber.name === 'Calibrate the shear response') ?? feed.fibers[0]
    for (let i = 0; i < 400; i++) {
      const row = structuredClone(source)
      row.origin = `perf-host-${i % 8}`
      row.fiber.id = `perf/task-${i}`; row.fiber.uid = `perf-${i}`; row.fiber.name = `Fleet task ${i}`
      feed.origins[row.origin] = { state: 'ok' }
      feed.fibers.push(row)
    }
    await window.__harness.modal.fetchAndRender()
    return { cards: feed.fibers.length, hosts: Object.keys(feed.origins).length }
  })
  result.fixture = { ...await stageFleet(), transcriptTurns: 3000 }
  await page.locator('.kbn-desk .kbn-card').filter({ hasText: 'Calibrate the shear response' }).click()
  await page.getByText('Fixture bin 3000 is within the review tolerance; retain the measured value and continue.', { exact: true }).waitFor()
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0))))
  async function type(name, field, text, { snapshots = false, transcript = false, noScans = false } = {}) {
    await field.focus(); await settle()
    await page.evaluate(() => { Object.assign(window.__typing, { styles: 0, walks: 0, keys: [], mutations: 0 }) })
    for (const char of text) {
      await page.keyboard.type(char)
      if (snapshots) await page.evaluate(async () => {
        const feed = window.__harness.MOCK_FEED
        feed.fibers.at(-1).fiber.outcome = `Worker progress ${feed.generated_at}`
        feed.generated_at = new Date().toISOString()
        await window.__harness.modal.fetchAndRender()
      })
      if (transcript) await page.evaluate(async () => {
        const workspace = window.__harness.modal.workspace
        await workspace.controls(workspace.current).transcriptBand.readNow()
      })
      await settle()
    }
    const stats = await page.evaluate(() => window.__typing)
    result.samples[name] = { ...stats, p50Paint: percentile(stats.keys.map(k => k.paint), .5), p95Paint: percentile(stats.keys.map(k => k.paint), .95), p95Task: percentile(stats.keys.map(k => k.task), .95) }
    if (process.env.TYPING_GATE === '1' && noScans) {
      assert.equal(stats.styles, 0, `${name}: typing must not read computed styles`)
      assert.equal(stats.walks, 0, `${name}: typing must not rescan transcripts`)
      assert.equal(stats.mutations, 0, `${name}: typing must preserve control DOM`)
    }
  }
  const composer = page.locator('.ws-page.ws-selected textarea.kbn-detail-directive')
  await type('composer-fresh', composer, 'hello world this is typing', { noScans: true })
  await composer.fill(('Please examine the shear response across sky patches.\n').repeat(200))
  await type('composer-long', composer, 'and compare null tests', { noScans: true })
  result.longDraftHeight = await composer.evaluate(el => el.clientHeight)
  assert.ok(result.longDraftHeight > 60, 'a multiline draft grows beyond one line')
  await page.screenshot({ path: '/tmp/shuttle-typing-long.png' })
  await composer.fill(''); await settle()
  result.emptyDraftHeight = await composer.evaluate(el => el.clientHeight)
  assert.ok(result.emptyDraftHeight < 60, 'the emptied composer returns to one line')
  await type('composer-during-snapshots', composer, 'worker updates while typing', { snapshots: true })
  async function state() {
    return page.evaluate(() => {
      const { modal } = window.__harness
      return { nodes: document.querySelectorAll('*').length, turns: document.querySelectorAll('.ws-transcript-turn').length,
        channels: modal.workspace.channels.size, bands: modal.workspace.opts.dock?.bands?.size ?? modal.dock?.bands?.size,
        frames: modal.workspace.reader.host.frames.size, live: modal.workspace.reader.host.live.size,
        revisionBytes: modal.workspace.lastUpdateRevision?.length,
        listeners: Object.fromEntries([...window.__typingListeners].map(([key, values]) => [key, values.size])) }
    })
  }
  result.snapshots.push({ ticks: 0, state: await state(), rss: rss() })
  for (let batch = 1; batch <= 3; batch++) {
    const tick = await page.evaluate(async () => {
      const start = performance.now(); let maxMs = 0
      for (let i = 0; i < 240; i++) {
        const startTick = performance.now()
        const feed = window.__harness.MOCK_FEED
        // A changing worker as well as unchanged polls; no accumulation of mock requests.
        if (i % 10 === 0) feed.fibers.at(-1).fiber.outcome = `Batch progress ${i}`
        await window.__harness.modal.fetchAndRender()
        maxMs = Math.max(maxMs, performance.now() - startTick)
        window.__harness.requests.length = 0; window.__harness.handlers.length = 0
      }
      return { elapsedMs: performance.now() - start, maxMs }
    })
    await settle()
    result.snapshots.push({ ticks: batch * 240, ...tick, state: await state(), rss: rss() })
  }
  if (process.env.TYPING_GATE === '1') for (const sample of result.snapshots.slice(1)) {
    for (const key of ['nodes', 'turns', 'bands', 'frames', 'live', 'listeners'])
      assert.deepEqual(sample.state[key], result.snapshots[0].state[key], `${key}: snapshot updates must not accumulate resources`)
  }
  await type('composer-aged', composer, ' more typing after three hours', { noScans: true })
  await composer.fill('')
  result.navigation = []
  for (let i = 0; i < 16; i++) {
    await page.evaluate(i => {
      const workspace = window.__harness.modal.workspace
      const card = workspace.opts.cards().find(card => card.id === `perf/task-${i}`)
      workspace.open(card, 'Desk')
    }, i)
    await page.locator('.ws-page.ws-selected textarea.kbn-detail-directive').waitFor()
    await settle()
    result.navigation.push({ opened: i + 2, state: await state(), rss: rss() })
  }
  if (process.env.TYPING_GATE === '1') assert.ok(result.navigation.at(-1).state.bands <= 6, 'chat models follow the live-document budget')
  const search = page.locator('.kbn-find')
  // The bar find input belongs to the real board, not a synthetic probe field.
  const find = await search.count() ? search : page.locator('input[type="search"]').first()
  await type('find-aged', find, 'calibration')
  await page.keyboard.press('Escape')
  await page.screenshot({ path: '/tmp/shuttle-typing.png' })
  await page.goto(`${base}?example=workspace&transcript=live`)
  await page.waitForFunction(() => window.__harness)
  result.liveFixture = await stageFleet()
  await page.locator('.kbn-desk .kbn-card').filter({ hasText: 'Calibrate the shear response' }).click()
  await page.locator('.ws-page.ws-selected textarea.kbn-detail-directive').waitFor()
  await type('composer-during-transcript', page.locator('.ws-page.ws-selected textarea.kbn-detail-directive'), 'typing beside live worker output', { transcript: true })
  await page.goto(base)
  await page.waitForFunction(() => window.__harness)
  result.editorFixture = await stageFleet()
  await page.locator('.kbn-viewtab').filter({ hasText: 'Chronicle' }).click()
  await page.getByText('summer-school block', { exact: true }).click()
  const intention = page.locator('.chr-face-intent').first()
  if (await intention.evaluate(el => el.classList.contains('chr-face-intent-empty'))) await intention.click()
  else await intention.dblclick()
  await type('fiber-editor', page.locator('textarea.chr-face-intent-edit'), 'writing a fiber body')
  await page.screenshot({ path: '/tmp/shuttle-typing-editor.png' })
  await page.keyboard.press('Escape')
  result.errors = errors
  assert.deepEqual(errors, [])
  console.log(JSON.stringify(result, null, 2))
} finally {
  await writeFile(output, JSON.stringify(result, null, 2))
  await browser.close(); await server.close()
}
