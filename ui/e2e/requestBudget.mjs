// The document cache's request budget, measured on the harness's Music channel:
// a report and nineteen recordings. Opening it fetches each document's bytes at
// most once, and an idle minute on it costs only validator checks.
//
//   node e2e/requestBudget.mjs           measure and assert
//   node e2e/requestBudget.mjs --report  measure and print, without asserting
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
await access(chrome)
const reportOnly = process.argv.includes('--report')
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required'] })
const url = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=music`

/** Requests for document routes, grouped by the document they read. */
function tally(requests, rewrites) {
  const docs = new Map()
  const doc = path => {
    if (!docs.has(path)) docs.set(path, { bytes: 0, peeks: 0, notModified: 0, missing: 0, heads: 0, info: 0, native: 0 })
    return docs.get(path)
  }
  for (const request of requests) {
    const parsed = new URL(request.url, 'http://harness.invalid')
    if (!/\/api\/v1\/file(-info)?$/.test(parsed.pathname)) continue
    const path = parsed.searchParams.get('path')
    const entry = doc(path)
    if (parsed.pathname.endsWith('/file-info')) entry.info++
    else if (request.method === 'HEAD') entry.heads++
    else if (request.status === 304) entry.notModified++
    else if (request.status === 404) entry.missing++
    else if (request.headers.range) entry.peeks++
    else entry.bytes++
  }
  for (const rewrite of rewrites) doc(rewrite.path).native++
  return docs
}
const sum = (docs, field) => [...docs.values()].reduce((total, entry) => total + entry[field], 0)
function print(label, docs) {
  const fields = ['bytes', 'peeks', 'notModified', 'missing', 'heads', 'info', 'native']
  console.log(`\n${label}: ${fields.map(f => `${f} ${sum(docs, f)}`).join(', ')}`)
  for (const [path, entry] of docs) console.log(`  ${path.split('/').slice(-2).join('/').padEnd(28)} ${fields.map(f => `${f}=${entry[f]}`).join(' ')}`)
}

const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
const p = await context.newPage()
const errors = []
p.on('pageerror', error => errors.push(error.message))
try {
  await p.clock.install()
  await p.goto(url)
  await p.locator('.kbn-desk .kbn-card').filter({ hasText: 'Music' }).first().click()
  await p.waitForFunction(() => document.querySelector('.ws-tab[aria-selected="true"]')?.getAttribute('aria-label') === 'Listening notes', null, { timeout: 10_000 })
  // Let titles, neighbours and durations settle.
  await p.clock.runFor(8_000)
  await p.waitForTimeout(500)
  const snapshot = () => p.evaluate(() => ({
    requests: window.__harness.requests.map(r => ({ url: r.url, method: r.method, status: r.status, headers: r.headers })),
    rewrites: window.__harness.nativeFiles.rewrites.map(r => ({ path: r.path })),
  }))
  const opened = await snapshot()
  const open = tally(opened.requests, opened.rewrites)
  print('open', open)
  // An idle minute on the selected page.
  await p.clock.runFor(60_000)
  await p.waitForTimeout(500)
  const later = await snapshot()
  const idle = tally(later.requests.slice(opened.requests.length), later.rewrites.slice(opened.rewrites.length))
  print('idle minute', idle)
  if (!reportOnly) {
    for (const [path, entry] of open) assert.ok(entry.bytes <= 1, `${path} read whole ${entry.bytes} times on open`)
    assert.equal(sum(idle, 'bytes'), 0, 'an idle minute reads no document bodies')
    assert.equal(sum(idle, 'peeks'), 0, 'an idle minute reads no peeks')
    assert.equal(sum(idle, 'native'), 0, 'an idle minute mounts no media')
    assert.deepEqual(errors, [])
    console.log('\nrequest budget: ok')
  }
} finally {
  await browser.close()
}
