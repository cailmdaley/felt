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
  await page.goto(`${base}?example=workspace`)
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
  result.fixture = await stageFleet()
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0))))
  async function type(name, field, text) {
    await field.focus(); await settle()
    await page.evaluate(() => { Object.assign(window.__typing, { styles: 0, walks: 0, keys: [], mutations: 0 }) })
    for (const char of text) {
      await page.keyboard.type(char)
      await settle()
    }
    const stats = await page.evaluate(() => window.__typing)
    result.samples[name] = { ...stats, p50Paint: percentile(stats.keys.map(k => k.paint), .5), p95Paint: percentile(stats.keys.map(k => k.paint), .95), p95Task: percentile(stats.keys.map(k => k.task), .95) }
  }
  const find = page.locator('.kbn-viewtabs-find input')
  await type('find', find, 'calibration')
  await page.keyboard.press('Escape')
  await page.screenshot({ path: '/tmp/shuttle-typing.png' })
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
