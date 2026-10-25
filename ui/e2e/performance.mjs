// Repeatable cold Desk/chat budgets against the file:// board harness.
// Run after `npm run harness:board` with `node e2e/performance.mjs`.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readdir, stat } from 'node:fs/promises'
import net from 'node:net'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getBrowser } from './browser.mjs'

const browser = await getBrowser({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required'] })
const base = pathToFileURL(resolve('harness-board-dist/index.html')).href
const screenshotDir = '/private/tmp/felt-board-perf-screenshots'
await mkdir(screenshotDir, { recursive: true })
const result = { environment: 'Chrome, file:// harness, 1440x900, mocked daemon', scenarios: {} }
async function inventory(directory) {
  return (await readdir(directory)).filter(name => /\.(?:js|mjs|css)$/.test(name)).map(async name => ({ name, bytes: (await stat(join(directory, name))).size }))
}
result.assets = {
  app: await Promise.all(await inventory(resolve('dist/assets'))),
  harness: await Promise.all(await inventory(resolve('harness-board-dist'))),
}

async function openScenario(name, query, selectChat) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  await page.addInitScript(() => {
    window.__perfNavigationStart = performance.now()
    const parse = JSON.parse
    window.__perfParse = { count: 0, elapsedMs: 0 }
    JSON.parse = function (...args) {
      const start = performance.now()
      try { return parse.apply(this, args) }
      finally { window.__perfParse.count++; window.__perfParse.elapsedMs += performance.now() - start }
    }
  })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${base}${query}`)
  await page.locator('.kbn-desk').waitFor()
  const harnessReadyMs = await page.evaluate(() => performance.now() - window.__perfNavigationStart)
  if (selectChat) {
    await page.locator('.kbn-desk .kbn-card').filter({ hasText: 'Calibrate the shear response' }).click()
    await page.locator('.ws-page.ws-selected .ws-transcript-turn').last().waitFor()
    await page.locator('.ws-page.ws-selected textarea').waitFor()
    if (query.includes('transcript=large')) {
      await page.getByText('Fixture bin 3000 is within the review tolerance; retain the measured value and continue.', { exact: true }).waitFor()
    }
  }
  await page.screenshot({ path: join(screenshotDir, `${name}.png`) })
  const initial = await page.evaluate(() => {
    const resources = performance.getEntriesByType('resource').map(entry => ({
      name: new URL(entry.name).pathname.split('/').at(-1),
      transferBytes: entry.transferSize,
      encodedBytes: entry.encodedBodySize,
      durationMs: entry.duration,
    }))
    const requests = window.__harness.requests
    return {
      resources,
      requests: requests.length,
      apiJsonResponseBytes: requests.reduce((total, request) => total + (request.responseBytes ?? 0), 0),
      fiberIndexResponseBytes: requests.filter(request => request.url.includes('/api/v1/fibers?fields=index')).reduce((total, request) => total + (request.responseBytes ?? 0), 0),
      apiRequests: requests.reduce((counts, request) => {
        const path = new URL(request.url, location.href).pathname
        counts[path] = (counts[path] ?? 0) + 1
        return counts
      }, {}),
      fiberIndexRequests: requests.filter(request => request.url.includes('/api/v1/fibers?fields=index')).length,
      cards: document.querySelectorAll('.kbn-desk .kbn-card').length,
      turns: document.querySelectorAll('.ws-page.ws-selected .ws-transcript-turn').length,
      heapBytes: performance.memory?.usedJSHeapSize ?? null,
    }
  })
  initial.harnessReadyMs = harnessReadyMs
  result.scenarios[name] = { screenshot: join(screenshotDir, `${name}.png`), initial, parseInstrumentation: null, snapshotTick: null, errors }

  await page.evaluate(() => window.__harness.modal.fetchAndRender())
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const parseInstrumentation = await page.evaluate(() => {
    window.__perfParse = { count: 0, elapsedMs: 0 }
    JSON.parse('{}')
    const count = window.__perfParse.count
    window.__perfParse = { count: 0, elapsedMs: 0 }
    return count
  })
  assert.equal(parseInstrumentation, 1, `${name}: JSON.parse timing instrumentation is active`)
  result.scenarios[name].parseInstrumentation = parseInstrumentation
  await page.evaluate(() => {
    window.__harness.requests.splice(0)
    window.__harness.handlers.splice(0)
  })
  const before = await page.evaluate(() => ({
    cardIdentity: (() => {
      const card = document.querySelector('.kbn-desk .kbn-card')
      if (card) card.setAttribute('data-perf-identity', 'tracked')
      return card !== null
    })(),
    turns: document.querySelectorAll('.ws-page.ws-selected .ws-transcript-turn').length,
    revision: window.__harness.modal.workspace.lastUpdateRevision,
  }))
  const cdp = await context.newCDPSession(page)
  await cdp.send('HeapProfiler.collectGarbage')
  const heapBefore = (await cdp.send('Runtime.getHeapUsage')).usedSize
  await page.evaluate(() => { window.__perfParse = { count: 0, elapsedMs: 0 } })
  const tick = await page.evaluate(async () => {
    const root = document.body
    let mutations = 0
    let meetingControlMutations = 0
    let revisionChanges = 0
    const mutationTargets = new Map()
    const observer = new MutationObserver(records => {
      for (const record of records) {
        mutations++
        if (record.target instanceof Element && record.target.closest('.kbn-ctl-meet-switch')) {
          meetingControlMutations++
        }
        const key = `${record.target.nodeName}.${record.target.className ?? ''}`
        const existing = mutationTargets.get(key)
        mutationTargets.set(key, { count: (existing?.count ?? 0) + 1, sample: existing?.sample ?? record.target.parentElement?.outerHTML.slice(0, 180) })
      }
    })
    observer.observe(root, { childList: true, subtree: true })
    const start = performance.now()
    // The board polls every 15s. 240 identical snapshots represent one hour
    // of poll cadence while keeping this budget quick and deterministic.
    let revision = window.__harness.modal.workspace.lastUpdateRevision
    for (let i = 0; i < 239; i++) {
      await window.__harness.modal.fetchAndRender()
      const next = window.__harness.modal.workspace.lastUpdateRevision
      if (next !== revision) { revisionChanges++; revision = next }
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const elapsedMs = performance.now() - start
    observer.disconnect()
    return {
      elapsedMs,
      mutations,
      meetingControlMutations,
      revisionChanges,
      mutationTargets: [...mutationTargets.entries()].map(([key, value]) => [key, value]).sort((a, b) => b[1].count - a[1].count).slice(0, 8),
      cardCount: document.querySelectorAll('.kbn-desk .kbn-card').length,
      turnCount: document.querySelectorAll('.ws-page.ws-selected .ws-transcript-turn').length,
      heapBytes: performance.memory?.usedJSHeapSize ?? null,
      requests: window.__harness.requests.length,
      selectedCardIdentityPreserved: document.querySelector('.kbn-desk .kbn-card[data-perf-identity="tracked"]') !== null,
      parseCount: window.__perfParse.count,
      parseElapsedMs: window.__perfParse.elapsedMs,
    }
  })
  if (selectChat) {
    result.scenarios[name].transcriptPoll = await page.evaluate(async () => {
      const feed = [...window.__harness.modal.workspace.dock.bands.values()].find(dock => dock.transcriptBand).transcriptBand.feed
      const beforeOffset = feed.offset
      const beforeRequests = window.__harness.requests.filter(request => request.url.includes('/api/v1/transcript/raw')).length
      window.__perfParse = { count: 0, elapsedMs: 0 }
      const start = performance.now()
      for (let i = 0; i < 239; i++) await feed.read()
      return {
        reads: 239,
        representedMinutes: 60,
        cadence: 'accelerated direct TranscriptFeed.read calls; no wall-clock interval waits',
        elapsedMs: performance.now() - start,
        unchangedOffset: feed.offset === beforeOffset,
        addedRequests: window.__harness.requests.filter(request => request.url.includes('/api/v1/transcript/raw')).length - beforeRequests,
        jsonParseCount: window.__perfParse.count,
        jsonParseElapsedMs: window.__perfParse.elapsedMs,
      }
    })
  }
  await page.evaluate(() => {
    window.__harness.requests.splice(0)
    window.__harness.handlers.splice(0)
  })
  await cdp.send('HeapProfiler.collectGarbage')
  const heapAfterGc = (await cdp.send('Runtime.getHeapUsage')).usedSize
  const parseMetrics = { count: tick.parseCount, elapsedMs: tick.parseElapsedMs }
  result.scenarios[name].snapshotTick = {
    polls: 240,
    transcriptPolls: 0,
    representedMinutes: 60,
    elapsedMs: tick.elapsedMs,
    mutationRecords: tick.mutations,
    meetingControlMutations: tick.meetingControlMutations,
    mutationTargets: tick.mutationTargets,
    cards: tick.cardCount,
    turns: tick.turnCount,
    retainedHeapGrowthBytes: heapAfterGc - heapBefore,
    heapBeforeGcBytes: heapBefore,
    heapAfterGcBytes: heapAfterGc,
    jsonParseCount: parseMetrics.count,
    jsonParseElapsedMs: parseMetrics.elapsedMs,
    revisionChanges: tick.revisionChanges,
    addedRequests: tick.requests,
    selectedCardIdentityPreserved: tick.selectedCardIdentityPreserved,
  }
  if (selectChat) {
    result.scenarios[name].changedCardRefresh = await page.evaluate(async (previousRevision) => {
      const row = window.__harness.MOCK_FEED.fibers.find(entry => entry.fiber.id === 'research/workspace/calibration-report')
      const previous = row.fiber.name
      row.fiber.name = `${previous} — live update`
      await window.__harness.modal.fetchAndRender()
      return {
        revisionChanged: window.__harness.modal.workspace.lastUpdateRevision !== previousRevision,
        titleUpdated: document.querySelector('.ws-chat-title')?.textContent?.includes('live update') ?? false,
      }
    }, before.revision)
  }
  result.scenarios[name].errors.push(...errors)
  await context.close()
}

async function measureChangedTranscriptPoll() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  await page.addInitScript(() => {
    const parse = JSON.parse
    window.__perfParse = { count: 0, elapsedMs: 0 }
    JSON.parse = function (...args) {
      const start = performance.now()
      try { return parse.apply(this, args) }
      finally { window.__perfParse.count++; window.__perfParse.elapsedMs += performance.now() - start }
    }
  })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${base}?example=workspace&transcript=live`)
  await page.locator('.kbn-desk .kbn-card').filter({ hasText: 'Calibrate the shear response' }).click()
  for (let i = 0; i < 32 && !(await page.locator('.ws-page.ws-selected[data-key^="chat:"]').count()); i++) {
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press('Escape')
    await page.waitForTimeout(30)
  }
  await page.locator('.ws-page.ws-selected[data-key^="chat:"]').waitFor()
  await page.locator('.ws-page.ws-selected .ws-transcript-turn').last().waitFor()
  await page.locator('.ws-page.ws-selected .ws-transcript-working-inline').waitFor()
  const feed = '() => [...window.__harness.modal.workspace.dock.bands.values()].find(dock => dock.transcriptBand)?.transcriptBand?.feed'
  await page.waitForFunction(feed)
  await page.evaluate(() => [...window.__harness.modal.workspace.dock.bands.values()].find(dock => dock.transcriptBand).transcriptBand.feed.read())
  await page.waitForFunction(() => [...window.__harness.modal.workspace.dock.bands.values()].find(dock => dock.transcriptBand)?.transcriptBand?.feed?.offset > 0)
  await page.evaluate(() => { window.__perfParse = { count: 0, elapsedMs: 0 } })
  const before = await page.evaluate(() => [...window.__harness.modal.workspace.dock.bands.values()].find(dock => dock.transcriptBand).transcriptBand.feed.offset)
  const changed = await page.evaluate(async () => {
    const feed = [...window.__harness.modal.workspace.dock.bands.values()].find(dock => dock.transcriptBand).transcriptBand.feed
    let renderMutations = 0
    const observer = new MutationObserver(records => { renderMutations += records.length })
    observer.observe(document.body, { childList: true, subtree: true })
    window.__perfStart = performance.now()
    await feed.read()
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    observer.disconnect()
    return {
      bytes: feed.offset,
      parseCount: window.__perfParse.count,
      parseElapsedMs: window.__perfParse.elapsedMs,
      elapsedMs: performance.now() - window.__perfStart,
      renderMutations,
      liveTextRendered: document.body.textContent?.includes('Live worker update 1: the next fictional validation batch is in progress.') ?? false,
    }
  })
  await page.getByText('Live worker update 1: the next fictional validation batch is in progress.', { exact: true }).waitFor()
  changed.bytes -= before
  changed.elapsedMs = Math.max(0, changed.elapsedMs)
  assert.ok(changed.bytes > 0, 'the live transcript poll receives appended JSONL bytes')
  assert.ok(changed.parseCount > 0, 'the changed JSONL records are parsed')
  assert.ok(changed.renderMutations > 0 && changed.liveTextRendered, 'the changed transcript poll renders its appended content')
  assert.equal(errors.length, 0, 'the changed transcript poll has no browser errors')
  result.changedTranscriptPoll = changed
  await context.close()
}

async function measureColdApp() {
  const portProbe = net.createServer()
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve))
  const address = portProbe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise(resolve => portProbe.close(resolve))
  const vite = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore' })
  let ready = false
  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch(`http://127.0.0.1:${port}/`); ready = true; break }
      catch { await new Promise(resolve => setTimeout(resolve, 100)) }
    }
    assert.equal(ready, true, 'Vite preview starts for cold app measurement')
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    await page.route('**/api/v1/**', route => {
      const path = new URL(route.request().url()).pathname
      const fiber = { id: 'work/math-note', uid: 'math-note', name: 'Math note', status: 'closed',
        created_at: '2026-10-01T00:00:00Z', outcome: 'The checked result is $x^2$.',
        shuttle: { kind: 'oneshot', agent: 'codex-sol', host: 'perf', project_dir: '/perf' } }
      const entry = { origin: 'perf', felt_store: '/perf/.felt', path: 'work/math-note/math-note.md', dir: 'work/math-note', fiber }
      const body = path.endsWith('/fibers/composite')
        ? { host: 'perf', fibers: [entry], origins: {} }
        : path.endsWith('/fibers') ? { fibers: [{ fiber: { id: 'work/math-note', name: 'Math note' } }] }
        : path.startsWith('/api/v1/fibers/') ? { host: 'perf', fibers: [{ ...entry, fiber: { ...fiber, body: 'A body containing the formula $x^2$.' } }] }
        : path.endsWith('/meeting') ? { meeting: null } : { fibers: [], files: [], agents: [] }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' })
    await page.locator('.kbn-desk').waitFor()
    await page.waitForTimeout(6_000)
    const initialTiming = await page.evaluate(() => {
      const navigation = performance.getEntriesByType('navigation')[0]
      const paints = performance.getEntriesByType('paint')
      return {
        domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? null,
        loadEventMs: navigation?.loadEventEnd ?? null,
        firstContentfulPaintMs: paints.find(entry => entry.name === 'first-contentful-paint')?.startTime ?? null,
      }
    })
    const initial = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => ({
      name: new URL(entry.name).pathname.split('/').at(-1),
      transferBytes: entry.transferSize,
      encodedBytes: entry.encodedBodySize,
    })).filter(entry => entry.name.startsWith('index-') || /mountForms|katex|pdfViewer|pdf\.worker/.test(entry.name)))
    const initialTransferBytes = initial.reduce((total, entry) => total + entry.transferBytes, 0)
    if (process.env.REPORT_ONLY !== '1') {
      assert.equal(initial.some(entry => /mountForms|katex|pdfViewer|pdf\.worker/.test(entry.name)), false,
        'idle first paint does not download forms, KaTeX, or PDF-viewer chunks')
    }
    const main = initial.find(entry => /^index-.*\.js$/.test(entry.name))
    if (process.env.REPORT_ONLY !== '1') assert.ok(main && main.transferBytes < 260_000, 'cold main script stays below 260 KB transferred')
    await page.locator('.kbn-desk .kbn-card').filter({ hasText: 'Math note' }).click()
    await page.waitForFunction(() => performance.getEntriesByType('resource').some(entry => /katex/.test(new URL(entry.name).pathname)))
    const afterMathUse = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => ({
      name: new URL(entry.name).pathname.split('/').at(-1), transferBytes: entry.transferSize, encodedBytes: entry.encodedBodySize,
    })).filter(entry => entry.name.startsWith('index-') || /mountForms|katex|pdfViewer|pdf\.worker/.test(entry.name)))
    assert.ok(afterMathUse.some(entry => /katex/.test(entry.name)), 'first formula use downloads the KaTeX chunk')
    if (process.env.REPORT_ONLY !== '1') assert.equal(afterMathUse.some(entry => /mountForms/.test(entry.name)), false,
      'rendering a formula loads KaTeX without loading the forms chunk')
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press('Escape')
    const stash = page.getByRole('button', { name: 'Stash a new fiber', exact: true })
    await stash.click()
    await page.waitForFunction(() => performance.getEntriesByType('resource').some(entry => /mountForms/.test(new URL(entry.name).pathname)))
    const afterFirstUse = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => ({
      name: new URL(entry.name).pathname.split('/').at(-1),
      transferBytes: entry.transferSize,
      encodedBytes: entry.encodedBodySize,
    })).filter(entry => entry.name.startsWith('index-') || /mountForms|katex|pdfViewer|pdf\.worker/.test(entry.name)))
    assert.ok(afterFirstUse.some(entry => /mountForms/.test(entry.name)), 'first stash use downloads the forms chunk')
    result.coldApp = { initialTiming, initialTransferBytes, initialAssets: initial, afterMathUseAssets: afterMathUse, afterFirstUseAssets: afterFirstUse,
      delayedChunks: { formula: 'katex', stash: 'mountForms' } }
    if (process.env.REPORT_ONLY !== '1') assert.ok(initialTransferBytes < 300_000, 'cold Desk initial resources stay below 300 KB transferred')
    await page.close()
  } finally {
    vite.kill('SIGTERM')
    await new Promise(resolve => vite.once('exit', resolve))
  }
}

try {
  await openScenario('desk', '?', false)
  await openScenario('chat-long-transcript', '?example=workspace&transcript=large', true)
  await measureChangedTranscriptPoll()
  await measureColdApp()
} finally {
  await browser.close()
}
assert.ok(result.changedTranscriptPoll.parseElapsedMs >= 0)
assert.ok(result.changedTranscriptPoll.elapsedMs >= 0)

for (const [name, scenario] of Object.entries(result.scenarios)) {
  const tick = scenario.snapshotTick
  if (process.env.REPORT_ONLY === '1') continue
  assert.equal(scenario.errors.length, 0, `${name}: no browser errors`)
  assert.equal(tick.mutationRecords, 0, `${name}: identical snapshots do not mutate the DOM`)
  assert.equal(tick.selectedCardIdentityPreserved, true, `${name}: card identity survives identical snapshots`)
  assert.equal(tick.cards, scenario.initial.cards, `${name}: card count stays constant`)
  assert.equal(tick.turns, scenario.initial.turns, `${name}: transcript window stays constant`)
  if (scenario.changedCardRefresh) {
    assert.equal(scenario.changedCardRefresh.revisionChanged, true, `${name}: changed card payload reaches the workspace`)
    assert.equal(scenario.changedCardRefresh.titleUpdated, true, `${name}: changed title appears in the chat`)
  }
  assert.ok(tick.retainedHeapGrowthBytes < 12 * 1024 * 1024, `${name}: one simulated hour retains less than 12 MiB after GC`)
  assert.equal(tick.jsonParseCount, 0, `${name}: unchanged board snapshots do not parse transcript JSONL`)
  if (scenario.transcriptPoll) {
    assert.equal(scenario.transcriptPoll.unchangedOffset, true, `${name}: unchanged transcript reads retain the byte offset`)
    assert.equal(scenario.transcriptPoll.addedRequests, 239, `${name}: the accelerated hour issues 239 transcript reads`)
    assert.equal(scenario.transcriptPoll.jsonParseCount, 0, `${name}: unchanged transcript reads do not parse JSONL again`)
  }
}
if (process.env.REPORT_ONLY !== '1') {
  assert.equal(result.scenarios.desk.initial.fiberIndexRequests, 0, 'cold Desk does not fetch the full fiber index')
  assert.ok(result.scenarios.desk.initial.apiJsonResponseBytes < 40_000, 'cold Desk mocked API JSON stays below 40 KB')
}
console.log(JSON.stringify(result, null, 2))
