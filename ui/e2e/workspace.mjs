import assert from 'node:assert/strict'
import { access, mkdir, writeFile, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
await access(chrome)
const browser = await chromium.launch({ executablePath: chrome, headless: true,
  args: ['--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required'] })
const url = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=workspace`
const name = 'Calibrate the shear response'
const tests = []
const test = (name, run, viewport, sidebarChoice = 'false', reducedMotion = 'reduce', touch = false) => tests.push({ name, run, viewport, sidebarChoice, reducedMotion, touch })
const selected = p => p.locator('.ws-page.ws-selected')
const plainThemeLabel = "Plain (drop this constitution's theme)"
async function openPlainThemeMenu(p) {
  const trigger = await p.locator('.ws-thumbbar').isVisible()
    ? p.locator('.ws-thumbbar [aria-label="Document menu"]')
    : selected(p).locator('.ws-menu-button')
  await trigger.click()
  return p.getByRole('button', { name: plainThemeLabel, exact: true })
}
const displayLabel = label => ({ 'calibration-report': 'Calibration report', 'brief.md': 'Field note' })[label] ?? label
const tab = (p, label) => p.getByRole('tab', { name: displayLabel(label), exact: true, includeHidden: true })
async function open(p, expected = 'calibration-report') {
  await p.locator('.kbn-desk .kbn-card').filter({ hasText: name }).click()
  await tab(p, 'calibration-report').waitFor({ state: 'attached' })
  await p.waitForFunction(label => document.querySelector('.ws-tab[aria-selected="true"]')?.getAttribute('aria-label') === label, displayLabel(expected))
}
async function choose(p, label) {
  if (await p.locator('.ws-page-choice').isVisible()) {
    await p.locator('.ws-page-choice').click()
    const row = p.locator('.ws-page-sheet-row').filter({ has: p.locator('.ws-page-sheet-title', { hasText: displayLabel(label) }) })
    if (await p.evaluate(() => navigator.maxTouchPoints > 0)) await row.tap()
    else await row.click()
    await poll(p, () => !document.querySelector('.ws-page-sheet')?.open)
  } else await tab(p, label).or(p.getByRole('tab', { name: label, exact: true })).click()
  await p.waitForFunction(label => document.querySelector('.ws-tab[aria-selected="true"]')?.getAttribute('aria-label') === label, displayLabel(label))
}
async function poll(p, fn, arg) { await p.waitForFunction(fn, arg, { timeout: 2500, polling: 40 }) }
async function chooseDeskColumn(p, index) {
  const segment = p.locator(`.kbn-folio-seg[data-folio="${index}"]`)
  if (!await segment.isVisible()) return
  await segment.click()
  await poll(p, index => document.querySelector(`.kbn-folio-seg[data-folio="${index}"]`)?.getAttribute('aria-selected') === 'true', index)
}
async function revealLatestFiles(p) {
  const latest = p.locator('.ws-overview-latest')
  await latest.waitFor()
  const summary = latest.locator('summary')
  await summary.getByText('Latest files', { exact: true }).waitFor()
  assert.equal(await latest.evaluate(details => details.open), false, 'Latest files starts folded')
  await summary.click()
  const ribbon = latest.locator('.ws-overview-ribbon')
  await ribbon.waitFor({ state: 'visible' })
  return ribbon
}
const reportPage = p => p.locator('.ws-page[data-key="umber-workstation:/fixture-store/workspace/.felt/research/workspace/calibration-report/report.html"]')
const report = p => reportPage(p).locator('iframe')
async function reportReady(p) {
  await report(p).contentFrame().locator('#report-sentinel').waitFor()
  await poll(p, () => { const viewer = document.querySelector('.ws-selected .ws-document-viewer'); return viewer && getComputedStyle(viewer).opacity === '1' })
  return report(p)
}
async function reportDocument(p) { return (await report(p).elementHandle()).contentFrame() }
async function reportY(p) { return (await reportDocument(p)).evaluate(() => document.scrollingElement.scrollTop) }
async function pollReport(p, fn, arg) { await (await reportDocument(p)).waitForFunction(fn, arg, { timeout: 2500, polling: 40 }) }
async function records(p) { return p.evaluate(() => window.__harness.requests) }

test('Fresh Desk leaves focus alone; the first j selects awaiting review and Enter opens first', async p => {
  assert.ok(await p.evaluate(() => document.activeElement !== document.querySelector('.kbn-col-head')), 'load must not focus a column head')
  assert.equal(await p.locator('.kbn-key-selected').count(), 0)
  await p.keyboard.press('j')
  assert.match(await p.locator('.kbn-card.kbn-key-selected').innerText(), /Calibrate the shear response/)
  await p.keyboard.press('Enter')
  await reportReady(p)
  assert.equal(await tab(p, 'calibration-report').getAttribute('aria-selected'), 'true')
  assert.ok(await p.evaluate(() => document.activeElement?.tagName !== 'IFRAME' && !document.activeElement?.closest('.ws-content')), 'keyboard entry must keep app-level focus')
})

for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) test(`Workspace type distinguishes names, verbs and data (${device})`, async p => {
  const type = async (selector, size, family) => {
    const actual = await p.locator(selector).first().evaluate(el => {
      const style = getComputedStyle(el)
      return { size: style.fontSize, family: style.fontFamily }
    })
    assert.equal(actual.size, `${size}px`, selector)
    assert.ok(actual.family.includes(family), `${selector}: ${actual.family}`)
  }
  await open(p); await reportReady(p)
  await type('.ws-channel-title', 15, 'EB Garamond')
  await type('.ws-nav-verdicts .ws-review-plate .kbn-ctl-btn', 15, 'EB Garamond')
  if (device === 'desktop') {
    for (const selector of ['.ws-return', '.ws-selected .ws-label-title']) await type(selector, 15, 'EB Garamond')
    // The index sits a step below the head's names.
    await type('.ws-tab:not(.ws-tab-anchor) .ws-tab-label', 14, 'EB Garamond')
    await type('.ws-selected .ws-provenance', 11, 'IBM Plex Mono')
    await type('.ws-head-position', 11, 'IBM Plex Mono')
  } else {
    await type('.ws-thumb-title', 15, 'EB Garamond')
    await type('.ws-thumb-arrival', 11, 'IBM Plex Mono')
  }
  await choose(p, 'Constitution')
  await type('.ws-selected .ws-prose-status', 15, 'EB Garamond')
  if (device === 'desktop') await type('.ws-selected .ws-fiber-prose h1', 34, 'EB Garamond')
  await type('.ws-selected .kbn-detail-lede', 24, 'EB Garamond')
  await type('.ws-selected .kbn-ctl-send', 15, 'EB Garamond')
  await type('.ws-selected .kbn-ctl-strip', 11, 'IBM Plex Mono')
  await choose(p, 'tone.mp3')
  await p.waitForFunction(() => document.querySelector('.ws-selected audio')?.readyState >= 1)
  await type('.ws-selected .ws-audio-play', 15, 'EB Garamond')
  await type('.ws-selected .ws-audio-clock', 11, 'IBM Plex Mono')
  await type('.ws-selected .ws-audio-compare button > span:first-child', 15, 'EB Garamond')
  await p.keyboard.press('?')
  assert.equal(await p.locator('.kbn-keymap-dialog header button').textContent(), '×')
  await p.keyboard.press('Escape')
  assert.equal(await p.locator('.kbn-keymap-overlay').count(), 0)
}, viewport)

test('Awaiting-review actions reveal without shifting and remain thumb-sized on touch', async p => {
  const drafts = p.locator('[data-column="drafts"]')
  const flight = p.locator('[data-column="inFlight"]')
  const review = p.locator('[data-column="awaitingReview"] .kbn-card').first()
  const actions = review.locator('.kbn-card-review-meta-actions')
  assert.equal(await drafts.locator('.kbn-card-review-meta-actions').count(), 0)
  assert.equal(await flight.locator('.kbn-card-review-meta-actions').count(), 0)
  assert.equal(await actions.locator('button').count(), 2)
  assert.equal(await actions.evaluate(el => getComputedStyle(el).opacity), '0')
  const before = await actions.evaluate(el => {
    const { width, height } = el.getBoundingClientRect()
    return { width, height }
  })
  const box = await review.boundingBox()
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  assert.equal(await actions.evaluate(el => getComputedStyle(el).opacity), '1')
  assert.deepEqual(await actions.evaluate(el => {
    const { width, height } = el.getBoundingClientRect()
    return { width, height }
  }), before)
  await p.mouse.move(0, 0)
  assert.equal(await actions.evaluate(el => getComputedStyle(el).opacity), '0')
  await actions.locator('button').first().focus()
  assert.equal(await actions.evaluate(el => getComputedStyle(el).opacity), '1')
  await p.evaluate(() => document.activeElement?.blur())
  assert.equal(await actions.evaluate(el => getComputedStyle(el).opacity), '0')
  await p.keyboard.press('j')
  assert.ok(await review.evaluate(el => el.classList.contains('kbn-key-selected')))
  assert.equal(await actions.evaluate(el => getComputedStyle(el).opacity), '1')
  await p.keyboard.press('Escape')
  await p.evaluate(() => document.activeElement?.blur())
  assert.equal(await actions.evaluate(el => getComputedStyle(el).opacity), '0')
}, undefined, undefined, 'reduce')

test('Awaiting-review actions stay visible and thumb-sized without hover', async p => {
  const actions = p.locator('[data-column="awaitingReview"] .kbn-card-review-meta-actions').first()
  assert.equal(await actions.evaluate(el => getComputedStyle(el).opacity), '1')
  for (const button of await actions.locator('button').all()) {
    assert.ok((await button.boundingBox()).height >= 44)
  }
}, { width: 390, height: 844 }, undefined, 'reduce', true)

test('Pointer, stepping, HTML scrolling, persistent iframe, expansion and resize', async p => {
  await open(p)
  const iframe = await reportReady(p)
  await mkdir(shots, { recursive: true })
  await p.screenshot({ path: resolve(shots, 'sandbox-report-desktop.png') })
  await iframe.evaluate(f => { window.__reportFrame = f; window.__reportWindow = f.contentWindow })
  const inner = await reportDocument(p)
  const identity = await inner.evaluate(() => { window.__sentinel = 'kept'; return document.querySelector('#report-identity').textContent })
  for (const [forward, backward] of [['l', 'h'], ['ArrowRight', 'ArrowLeft']]) {
    await p.keyboard.press(forward)
    assert.equal(await tab(p, 'calibration-report').getAttribute('aria-selected'), 'false')
    await p.keyboard.press(backward)
    assert.equal(await tab(p, 'calibration-report').getAttribute('aria-selected'), 'true')
  }
  await choose(p, 'brief.md')
  await choose(p, 'calibration-report')
  await inner.evaluate(() => {
    const querySelectorAll = document.querySelectorAll.bind(document)
    window.__workspaceBodyWalks = 0
    document.querySelectorAll = selector => {
      if (selector === 'body *') window.__workspaceBodyWalks++
      return querySelectorAll(selector)
    }
  })
  for (const [down, up] of [['ArrowDown', 'ArrowUp'], ['d', 'u'], ['Space', 'Shift+Space']]) {
    await inner.evaluate(() => window.scrollTo(0, 0))
    await p.keyboard.press(down)
    await pollReport(p, () => document.scrollingElement.scrollTop > 0)
    const before = await reportY(p)
    await p.keyboard.press(up)
    await pollReport(p, before => document.scrollingElement.scrollTop < before, before)
  }
  await p.keyboard.down('ArrowDown')
  await p.keyboard.press('ArrowDown')
  await p.keyboard.up('ArrowDown')
  assert.ok(await reportY(p) > 0, 'held arrow scrolling repeats')
  assert.ok(await inner.evaluate(() => window.__workspaceBodyWalks) <= 1, 'report scroller is cached')
  const readingY = await reportY(p)
  await choose(p, 'brief.md'); await choose(p, 'calibration-report')
  assert.equal(await reportY(p), readingY, 'reading position survives tab selection')
  await tab(p, 'calibration-report').dblclick()
  assert.ok(await p.locator('.ws-page.ws-expanded').count())
  await p.locator('.ws-page.ws-expanded .ws-labelbar').dblclick()
  assert.equal(await p.locator('.ws-page.ws-expanded').count(), 0)
  const edge = reportPage(p).locator('.ws-edge-right')
  const box = await edge.boundingBox()
  const width = await iframe.evaluate(f => f.closest('.ws-page').getBoundingClientRect().width)
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await p.mouse.down(); await p.mouse.move(box.x - 120, box.y + box.height / 2); await p.mouse.up()
  assert.notEqual(await iframe.evaluate(f => f.closest('.ws-page').getBoundingClientRect().width), width)
  await p.setViewportSize({ width: 1250, height: 760 })
  assert.ok(await iframe.evaluate(f => f === window.__reportFrame && f.contentWindow === window.__reportWindow), 'browser resize must retain the iframe')
  assert.equal(await inner.evaluate(() => window.__sentinel), 'kept')
  await p.getByRole('button', { name: 'Return to Desk', exact: true }).click()
  await open(p)
  assert.ok(await iframe.evaluate(f => f === window.__reportFrame && f.contentWindow === window.__reportWindow))
  assert.equal(await inner.evaluate(() => document.querySelector('#report-identity').textContent), identity)
  assert.equal(await reportY(p), readingY)
})

test('Hostile report keys cannot queue verdicts or open controls; trusted and posted navigation still work', async p => {
  await open(p); await reportReady(p)
  const inner = await reportDocument(p)
  const key = await selected(p).getAttribute('data-key')
  const before = (await records(p)).filter(r => r.method === 'POST').length
  await inner.evaluate(() => {
    for (const key of ['x', 't', 'z', '.', 'c', 'r', 'p', ',', '>', 'Enter', 'o']) {
      parent.postMessage({ protocol: 'shuttle-document', version: 1, type: 'key', payload: { key } }, '*')
    }
  })
  await p.waitForTimeout(150)
  assert.equal(await p.locator('.ws-verdict-toast').count(), 0)
  assert.equal(await selected(p).getAttribute('data-key'), key)
  assert.equal(await p.locator('.ws-expanded').count(), 0)
  assert.equal((await records(p)).filter(r => r.method === 'POST').length, before)
  assert.equal(await p.evaluate(() => window.__harness.events.filter(e => e.type === 'open-worker').length), 0)
  await inner.evaluate(() => {
    document.body.tabIndex = -1; document.body.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true }))
  })
  await p.waitForTimeout(100)
  assert.equal(await selected(p).getAttribute('data-key'), key, 'untrusted report key events are ignored')
  await p.keyboard.press('ArrowDown')
  await pollReport(p, () => document.scrollingElement.scrollTop > 0)
  await p.keyboard.press('Alt+ArrowRight')
  assert.notEqual(await selected(p).getAttribute('data-key'), key)
  await choose(p, 'calibration-report')
  await inner.evaluate(() => parent.postMessage({ protocol: 'shuttle-document', version: 1, type: 'key', payload: { key: 'ArrowRight', altKey: true } }, '*'))
  await poll(p, key => document.querySelector('.ws-selected')?.dataset.key !== key, key)
})

test('Report reference batches are size-capped and limited to four responses a second', async p => {
  await open(p); await reportReady(p)
  const inner = await reportDocument(p)
  // Keep ordinary scanner decoration out of the malicious sender's rate budget.
  await inner.evaluate(() => document.querySelectorAll('code,a[href]').forEach(element => element.remove()))
  // The parent defers an over-budget batch until its window reopens, so the
  // scanner's last batch can hold a slot for up to two windows.
  await p.waitForTimeout(2100)
  await inner.evaluate(() => {
    window.__referenceResponses = 0
    window.addEventListener('message', event => { if (event.data?.type === 'references:resolved') window.__referenceResponses++ })
    for (let i = 0; i < 20; i++) parent.postMessage({ protocol: 'shuttle-document', version: 1, type: 'references', payload: { candidates: ['brief.md'] } }, '*')
  })
  await p.waitForTimeout(100)
  assert.equal(await inner.evaluate(() => window.__referenceResponses), 4)
  await p.waitForTimeout(1100)
  await inner.evaluate(() => {
    window.__referenceResponses = 0
    for (const candidates of [Array(501).fill('brief.md'), ['a'.repeat(257)]]) parent.postMessage({ protocol: 'shuttle-document', version: 1, type: 'references', payload: { candidates } }, '*')
  })
  await p.waitForTimeout(100)
  assert.equal(await inner.evaluate(() => window.__referenceResponses), 0)
})

test('Channel references select from HTML, markdown, plain text and the fiber with coherent history', async p => {
  await open(p); await reportReady(p)
  const key = await selected(p).getAttribute('data-key')
  const inner = await reportDocument(p)
  await inner.locator('a.ws-channel-reference').filter({ hasText: 'brief.md' }).waitFor()
  await inner.evaluate(() => {
    parent.postMessage({ protocol: 'shuttle-document', version: 1, type: 'select', payload: { candidate: 'unresolved.html' } }, '*')
    parent.postMessage({ protocol: 'shuttle-document', version: 1, type: 'select', payload: { candidate: 'umber-workstation:/fixture-store/workspace/deliverables/brief.md' } }, '*')
  })
  await p.waitForTimeout(150)
  assert.equal(await selected(p).getAttribute('data-key'), key, 'unresolved strings and document keys cannot select')
  await inner.getByRole('link', { name: 'the field note', exact: true }).click()
  await poll(p, () => document.querySelector('.ws-tab[aria-selected="true"]')?.getAttribute('aria-label') === 'Field note')
  assert.ok(await selected(p).locator('.ws-label-title').innerText() === 'Field note')
  await selected(p).getByRole('link', { name: 'the report', exact: true }).click()
  await reportReady(p)
  assert.equal(await selected(p).getAttribute('data-key'), key)
  await p.goBack()
  await poll(p, () => document.querySelector('.ws-reader')?.classList.contains('ws-dormant'))
  await open(p)
  await choose(p, 'readme.txt')
  await selected(p).getByRole('link', { name: 'tone.mp3', exact: true }).click()
  assert.equal(await tab(p, 'tone.mp3').getAttribute('aria-selected'), 'true')
  await choose(p, 'Constitution')
  await selected(p).getByRole('link', { name: 'brief.md', exact: true }).click()
  assert.equal(await tab(p, 'brief.md').getAttribute('aria-selected'), 'true')
})

for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) test(`Inline channel audio plays and pauses in HTML and markdown without selecting (${device})`, async p => {
  await open(p); await reportReady(p)
  const inner = await reportDocument(p)
  const initial = await selected(p).getAttribute('data-key')
  const play = inner.getByRole('button', { name: 'Play tone.mp3', exact: true })
  const audio = p.locator('.ws-page[data-key="umber-workstation:/fixture-store/workspace/deliverables/tone.mp3"] audio')
  assert.equal(await inner.locator('button[aria-pressed="true"]').count(), 0, 'references never autoplay')
  if (device === 'desktop') { await play.focus(); await p.keyboard.press('Enter') }
  else await play.tap()
  await poll(p, () => { const audio = document.querySelector('.ws-page[data-key$="/tone.mp3"] audio'); return audio && !audio.paused && audio.currentTime > 0 })
  assert.equal(await selected(p).getAttribute('data-key'), initial)
  await inner.getByRole('button', { name: 'Pause tone.mp3', exact: true }).waitFor()
  await inner.waitForFunction(() => parseFloat(document.querySelector('.ws-reference-play').style.getPropertyValue('--ws-reference-progress')) > 0)
  await audio.evaluate(audio => { window.__inlineAudio = audio })
  await mkdir(shots, { recursive: true }); await p.screenshot({ path: resolve(shots, `links-${device}-inline-playing.png`) })
  await inner.getByRole('button', { name: 'Play tone.wav', exact: true }).click()
  await poll(p, () => document.querySelector('.ws-page[data-key$="/tone.mp3"] audio').paused && !document.querySelector('.ws-page[data-key$="/tone.wav"] audio').paused)
  await inner.getByRole('button', { name: 'Pause tone.wav', exact: true }).click()
  await poll(p, () => document.querySelector('.ws-page[data-key$="/tone.wav"] audio').paused)
  assert.equal(await selected(p).getAttribute('data-key'), initial)
  await choose(p, 'brief.md')
  await selected(p).getByRole('button', { name: 'Play tone.mp3', exact: true }).click()
  await poll(p, () => !document.querySelector('.ws-page[data-key$="/tone.mp3"] audio').paused)
  assert.equal(await tab(p, 'brief.md').getAttribute('aria-selected'), 'true')
  await selected(p).getByRole('button', { name: 'Pause tone.mp3', exact: true }).click()
  await poll(p, () => document.querySelector('.ws-page[data-key$="/tone.mp3"] audio').paused)
  await selected(p).getByRole('button', { name: 'Play tone.mp3', exact: true }).click()
  await choose(p, 'tone.mp3')
  assert.ok(await audio.evaluate(audio => audio === window.__inlineAudio && audio.paused), 'selection uses the same audio page element and pauses inline playback')
  await choose(p, 'calibration-report')
  await inner.getByRole('button', { name: 'Play tone.mp3', exact: true }).click()
  await p.getByRole('button', { name: 'Return to Desk', exact: true }).click()
  await poll(p, () => document.querySelector('.ws-page[data-key$="/tone.mp3"] audio').paused)
}, viewport)

test('Ambiguous code basenames stay unlinked while an explicit path still selects', async p => {
  await open(p); await reportReady(p)
  await p.evaluate(() => {
    const original = window.fetch
    window.fetch = async (...args) => {
      const response = await original(...args)
      if (!String(args[0]).includes('/api/v1/sent-files?')) return response
      const data = await response.json()
      data.files.push({ ...data.files.find(file => file.basename === 'tone.mp3'), fullPath: '/other/tone.mp3' })
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
    }
  })
  await p.getByRole('button', { name: 'Return to Desk', exact: true }).click()
  await open(p); await reportReady(p)
  const inner = await reportDocument(p)
  await inner.waitForFunction(() => ![...document.querySelectorAll('a.ws-channel-reference')].some(link => link.textContent === 'tone.mp3'))
  const ambiguous = inner.locator('code').filter({ hasText: /^tone\.mp3$/ })
  assert.equal(await ambiguous.evaluate(code => code.parentElement.tagName), 'P')
  await inner.evaluate(() => {
    const code = document.createElement('code'); code.textContent = '/fixture-store/workspace/deliverables/tone.mp3'; document.body.prepend(code)
  })
  await inner.getByRole('link', { name: '/fixture-store/workspace/deliverables/tone.mp3', exact: true }).click()
  await poll(p, () => document.querySelector('.ws-selected')?.dataset.key === 'umber-workstation:/fixture-store/workspace/deliverables/tone.mp3')
})

test('Opaque report denies parent DOM and same-origin API reads; links open outside the frame', async p => {
  const requests = []
  const html = await readFile(resolve('harness-board-dist/index.html'))
  const server = createServer(async (req, res) => {
    const rawPath = new URL(req.url, 'http://file.test').searchParams.get('path')
    if ((req.url.startsWith('/api/v1/file-assets/') && req.url.endsWith('/opaque-popup.html')) || (req.url.startsWith('/api/v1/file?') && rawPath?.endsWith('.html'))) {
      res.setHeader('Content-Type', 'text/html')
      if (!process.env.WORKSPACE_UNSAFE_FILES) res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-forms')
      res.end('<!doctype html><html><body>Hostile file probe<script>(async()=>{let storageDenied=false,apiDenied=false;try{window.sentinel=localStorage.getItem("opaque-board-sentinel")}catch{storageDenied=true}try{await fetch("' + base + '/api/v1/version")}catch{apiDenied=true}window.__access={storageDenied,apiDenied,sentinel:window.sentinel??null}})()</script></body></html>')
    } else if (req.url.startsWith('/api/v1/file-assets/') && /opaque-probe\.(css|js|svg)$/.test(req.url)) {
      const ext = req.url.split('.').at(-1)
      res.setHeader('Content-Type', { css: 'text/css', js: 'application/javascript', svg: 'image/svg+xml' }[ext])
      res.end({ css: 'body { --opaque-asset: loaded; }', js: 'window.__opaqueAsset = true', svg: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>' }[ext])
    } else if (req.url.startsWith('/api/v1/')) {
      requests.push({ url: req.url, origin: req.headers.origin })
      res.setHeader('Content-Type', 'application/json')
      res.end('{"private":true}')
    } else if (['/harness-board.js', '/shuttle-ui.css'].includes(req.url)) {
      res.setHeader('Content-Type', req.url.endsWith('.js') ? 'application/javascript' : 'text/css')
      res.end(await readFile(resolve('harness-board-dist' + req.url)))
    } else { res.setHeader('Content-Type', 'text/html'); res.end(html) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    await p.goto(base + '/?example=workspace')
    await open(p); const iframe = await reportReady(p)
    assert.equal(await iframe.getAttribute('sandbox'), 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-forms')
    assert.equal(await iframe.evaluate(f => f.contentDocument), null, 'parent cannot access opaque frame DOM')
    const inner = await reportDocument(p)
    const access = await inner.evaluate(async base => {
      let parentDenied = false, apiDenied = false
      try { void parent.document.body } catch { parentDenied = true }
      try { await fetch(base + '/api/v1/version') } catch { apiDenied = true }
      return { parentDenied, apiDenied }
    }, base)
    assert.deepEqual(access, { parentDenied: true, apiDenied: true })
    assert.ok(requests.some(request => request.url === '/api/v1/version' && request.origin === 'null'), 'opaque fetch sends Origin: null, never parent origin')
    const assets = await inner.evaluate(async () => {
      const load = element => new Promise((resolve, reject) => { element.onload = resolve; element.onerror = reject; document.head.append(element) })
      const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'opaque-probe.css'
      const script = document.createElement('script'); script.src = 'opaque-probe.js'
      const image = document.createElement('img'); image.src = 'opaque-probe.svg'
      await Promise.all([load(css), load(script), load(image)])
      return { css: getComputedStyle(document.body).getPropertyValue('--opaque-asset').trim(), script: window.__opaqueAsset, image: image.naturalWidth, url: script.src }
    })
    assert.equal(assets.css, 'loaded')
    assert.equal(assets.script, true)
    assert.equal(assets.image, 8)
    assert.match(assets.url, /\/api\/v1\/file-assets\/umber-workstation\/.*\/opaque-probe.js$/, 'relative assets retain the owning host')
    const link = await inner.evaluate(() => {
      const link = document.createElement('a'); link.href = 'https://example.com/paper'; link.textContent = 'External paper'
      document.body.prepend(link)
      link.addEventListener('click', event => event.preventDefault())
      link.click()
      return { target: link.target, rel: link.rel }
    })
    assert.deepEqual(link, { target: '_blank', rel: 'noopener noreferrer' })
    const local = await inner.evaluate(() => {
      localStorage.setItem('plot-theme', 'dark')
      sessionStorage.setItem('slide', '1')
      history.replaceState({ slide: 1 }, '', document.baseURI + '#/slide-1')
      return { theme: localStorage.getItem('plot-theme'), slide: sessionStorage.getItem('slide'), state: history.state }
    })
    assert.deepEqual(local, { theme: 'dark', slide: '1', state: { slide: 1 } })
    const key = await selected(p).getAttribute('data-key')
    await inner.evaluate(() => {
      document.addEventListener('keydown', event => {
        if (event.key !== 'ArrowRight') return
        // Deck navigation must reach preventDefault even with an opaque URL.
        history.replaceState({ slide: 2 }, '', document.baseURI + '#/slide-2')
        sessionStorage.setItem('slide', '2')
        event.preventDefault()
      })
      document.body.tabIndex = -1
    })
    // A real click activates the opaque document; DOM focus alone need not
    // make it Chrome's keyboard target.
    await inner.locator('#report-sentinel').click()
    await inner.locator('body').press('ArrowRight')
    await inner.waitForFunction(() => sessionStorage.getItem('slide') === '2', undefined, { polling: 40 })
    assert.equal(await inner.evaluate(() => sessionStorage.getItem('slide')), '2')
    assert.equal(await selected(p).getAttribute('data-key'), key, 'deck-owned arrows never step workspace documents')
    assert.equal(await p.evaluate(() => localStorage.getItem('plot-theme')), null, 'report preferences cannot leak to board storage')
    await p.evaluate(() => localStorage.setItem('opaque-board-sentinel', 'private-board-state'))
    await inner.evaluate(() => {
      const link = document.createElement('a'); link.href = 'opaque-popup.html'; link.textContent = 'Sibling hostile HTML'; document.body.prepend(link)
    })
    const checkPopup = async (click, expectedURL) => {
      const opened = p.context().waitForEvent('page')
      await click()
      const popup = await opened
      try {
        // The page event can precede navigation, and noopener popups need not
        // paint. Wait for the intended document, then poll its network result
        // without depending on animation frames.
        await popup.waitForURL(expectedURL, { waitUntil: 'domcontentloaded' })
        await popup.waitForFunction(() => window.__access, undefined, { polling: 40 })
        const access = await popup.evaluate(() => window.__access)
        assert.deepEqual(access, { storageDenied: true, apiDenied: true, sentinel: null }, 'raw HTML popups cannot regain the board origin')
        return access
      } finally { await popup.close() }
    }
    const siblingURL = await inner.getByRole('link', { name: 'Sibling hostile HTML', exact: true }).evaluate(link => link.href)
    const siblingPopup = await checkPopup(() => inner.getByRole('link', { name: 'Sibling hostile HTML', exact: true }).click(), siblingURL)
    await selected(p).getByRole('button', { name: 'Document menu', exact: true }).click()
    const rawFile = p.getByRole('link', { name: 'Open in new tab', exact: true })
    const rawFilePopup = await checkPopup(() => rawFile.click(), await rawFile.evaluate(link => link.href))
    await mkdir(shots, { recursive: true })
    await writeFile(resolve(shots, 'security-probes.json'), JSON.stringify({ iframe: access, relativeAssets: assets, siblingPopup, rawFilePopup, requests }, null, 2))
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('Embedded HTML media pauses on recede and park without reloading or auto-resuming', async p => {
  await open(p); await reportReady(p)
  const inner = await reportDocument(p)
  const audio = `data:audio/wav;base64,${(await readFile(resolve('harness/fixtures/sine.wav'))).toString('base64')}`
  await inner.evaluate(async src => {
    const media = document.createElement('audio'); media.id = 'embedded-audio'; media.controls = true; media.src = src
    document.body.prepend(media); window.__mediaIdentity = media
    await media.play()
  }, audio)
  await pollReport(p, () => !document.querySelector('audio').paused && document.querySelector('audio').currentTime > 0)
  await choose(p, 'brief.md')
  await pollReport(p, () => document.querySelector('audio').paused)
  const position = await inner.evaluate(() => document.querySelector('audio').currentTime)
  await choose(p, 'calibration-report')
  assert.ok(await inner.evaluate(position => document.querySelector('audio') === window.__mediaIdentity && document.querySelector('audio').paused && document.querySelector('audio').currentTime === position, position))
  await inner.evaluate(() => document.querySelector('audio').play())
  await p.getByRole('button', { name: 'Return to Desk', exact: true }).click()
  await pollReport(p, () => document.querySelector('audio').paused)
  await open(p)
  assert.ok(await inner.evaluate(() => document.querySelector('audio') === window.__mediaIdentity && document.querySelector('audio').paused))
})

test('Late nested report layout retains its restore and then accepts reader scrolling', async p => {
  // The bridge clamps an unsatisfied restore after 3 s. Model layout arriving
  // before that deadline explicitly, independently of CPU scheduling.
  await p.clock.pauseAt(new Date('2026-10-04T14:00:30Z'))
  await open(p); await reportReady(p)
  await report(p).evaluate(frame => new Promise(resolve => {
    const bridge = new DOMParser().parseFromString(frame.srcdoc, 'text/html').querySelector('[data-shuttle-workspace-bridge]').outerHTML
    frame.addEventListener('load', resolve, { once: true })
    frame.srcdoc = `<!doctype html><html><head>${bridge}</head><body>
      <p id="early">Short initial layout</p>
      <script>
        window.addEventListener('message', event => {
          if (event.source === parent && event.data?.protocol === 'shuttle-document' && event.data.type === 'active') {
            window.__active = event.data.payload.active
          }
        })
        window.addEventListener('load', () => setTimeout(() => window.__shortReady = true, 0))
      </script>
    </body></html>`
  }))
  const inner = await reportDocument(p)
  await p.clock.runFor(1)
  await inner.waitForFunction(() => window.__shortReady, undefined, { polling: 40 })
  const command = async (type, payload) => report(p).evaluate((frame, data) => frame.contentWindow.postMessage(data, '*'), { protocol: 'shuttle-document', version: 1, type, payload })
  await command('restore', { x: 0, y: 160 })
  await command('active', { active: false })
  await inner.waitForFunction(() => window.__active === false, undefined, { polling: 40 })
  const saved = () => p.evaluate(() => JSON.parse(sessionStorage.getItem('shuttle:workspace:scroll:' + document.querySelector('.ws-selected').dataset.key))?.y)
  await p.waitForFunction(() => JSON.parse(sessionStorage.getItem('shuttle:workspace:scroll:' + document.querySelector('.ws-selected').dataset.key))?.y === 160, undefined, { polling: 40 })
  await p.clock.runFor(1000)
  assert.equal(await inner.evaluate(() => document.scrollingElement.scrollTop), 0, 'short layout cannot yet hold the restore')
  assert.equal(await saved(), 160, 'pending restore is not overwritten by a clamped zero')
  await inner.evaluate(() => {
    document.querySelector('#early').remove()
    const main = document.createElement('main'); main.id = 'late'; main.tabIndex = 0; main.style.cssText = 'height:280px;overflow:auto;line-height:20px'
    main.innerHTML = '<div style="height:6000px">Late asynchronous report content</div>'
    document.body.append(main)
  })
  await inner.waitForFunction(() => document.querySelector('#late').scrollTop === 160, undefined, { polling: 40 })
  await command('active', { active: true })
  // postMessage returns before the bridge processes activation. The fixture's
  // listener runs after the bridge's listener, acknowledging delivery.
  await inner.waitForFunction(() => window.__active === true, undefined, { polling: 40 })
  const scroller = inner.locator('#late')
  await scroller.click()
  await inner.waitForFunction(() => document.hasFocus(), undefined, { polling: 40 })
  await scroller.press('ArrowDown')
  // Reader ArrowDown advances three 20 px lines; native scrolling alone is
  // not enough to satisfy this assertion.
  await inner.waitForFunction(() => document.querySelector('#late').scrollTop === 220, undefined, { polling: 40 })
  await p.waitForFunction(() => JSON.parse(sessionStorage.getItem('shuttle:workspace:scroll:' + document.querySelector('.ws-selected').dataset.key))?.y === 220, undefined, { polling: 40 })
  assert.equal(await saved(), 220)
})

test('Desk-opened channel reload and Back restore its Desk return control', async p => {
  await open(p); await reportReady(p)
  await choose(p, 'brief.md')
  await p.reload()
  await tab(p, 'brief.md').waitFor()
  await p.getByRole('button', { name: 'Return to Desk', exact: true }).waitFor()
  assert.ok(await p.locator('.kbn-modal').count(), 'Desk stays behind the reader')
  await p.locator('.ws-channel-title').focus()
  await p.keyboard.press('j')
  await p.goBack()
  await poll(p, () => document.querySelector('.ws-channel-title')?.textContent === 'Calibrate the shear response')
  await p.getByRole('button', { name: 'Return to Desk', exact: true }).waitFor()
  await p.getByRole('button', { name: 'Return to Desk', exact: true }).click()
  assert.equal(await p.locator('.ws-page.ws-selected:visible').count(), 0)
})

test('The running head indexes pages in words, previews on hover within the shared budget, and keeps selection through a fresh re-send', async p => {
  await open(p); await reportReady(p)
  const film = p.locator('.ws-tabs')
  const head = await p.locator('.ws-navbar').boundingBox()
  assert.ok(head.height <= 48, `the head is one row: ${head.height}`)
  assert.ok((await selected(p).boundingBox()).y <= 80, 'the page starts within 80 px of the top')
  assert.equal(await p.locator('[data-part="chrome-plate"]').count(), 0, 'no chrome plates')
  assert.equal(await film.locator('[data-part="thumbnail"]').count(), 0, 'the index carries no thumbnails')
  const selectedTab = film.locator('.ws-tab[aria-selected="true"]')
  const look = await selectedTab.evaluate(el => ({ background: getComputedStyle(el).backgroundColor, shadow: getComputedStyle(el).boxShadow, rule: getComputedStyle(el.querySelector('.ws-tab-label')).textDecorationLine }))
  assert.deepEqual(look, { background: 'rgba(0, 0, 0, 0)', shadow: 'none', rule: 'underline' })
  assert.equal(await tab(p, 'Constitution').textContent(), '§')
  assert.ok(await tab(p, 'calibration-report').locator('.ws-tab-label').evaluate(el => el.classList.contains('ws-tab-title')))
  assert.equal(await tab(p, 'calibration-report').getAttribute('title'), null, 'the preview, not a native tooltip, names a hovered page')
  assert.equal(await p.locator('.ws-tab-fresh').count(), 0, 'first visits are quiet')
  const preview = p.locator('.ws-tab-preview')
  await p.mouse.move(700, 500)
  await tab(p, 'response.pdf').hover()
  await p.waitForTimeout(200)
  assert.ok(await preview.isHidden(), 'a first hover waits')
  await preview.waitFor({ state: 'visible' })
  assert.match(await preview.locator('.ws-tab-preview-meta').textContent(), /sent/)
  const anchor = await tab(p, 'response.pdf').boundingBox(), card = await preview.boundingBox()
  assert.ok(Math.abs(card.x + card.width / 2 - (anchor.x + anchor.width / 2)) < 2 && card.y >= anchor.y + anchor.height, 'the preview hangs beneath its label')
  assert.equal(await p.evaluate(() => document.activeElement?.closest('.ws-tab-preview')), null, 'the preview never takes focus')
  await tab(p, 'calibration-report').hover()
  assert.ok(await preview.isVisible(), 'a neighbour swaps in at once')
  await poll(p, () => document.querySelectorAll('.ws-tab-preview iframe').length > 0)
  for (const frame of await preview.locator('iframe').all()) {
    assert.equal(await frame.getAttribute('sandbox'), '')
    assert.equal(await frame.getAttribute('tabindex'), '-1')
  }
  assert.ok(await p.locator('.ws-thumbnail-body').count() <= 16)
  await poll(p, () => document.querySelector('.ws-tab-preview .ws-tab-kind-html.ws-thumbnail-ready'))
  assert.equal(await preview.locator('.ws-thumbnail-face').evaluate(el => getComputedStyle(el).visibility), 'hidden')
  await p.keyboard.press('Escape')
  assert.ok(await preview.isHidden(), 'Escape dismisses the preview')
  assert.ok(await selected(p).isVisible(), 'and stops there')
  await tab(p, 'brief.md').hover()
  await preview.waitFor({ state: 'visible' })
  // Straight into the report: its frame must not swallow the leave.
  await p.mouse.move(700, 500)
  await poll(p, () => document.querySelector('.ws-tab-preview').hidden)
  if (process.env.WORKSPACE_SHOTS) {
    await mkdir(process.env.WORKSPACE_SHOTS, { recursive: true })
    await tab(p, 'calibration-report').hover(); await preview.waitFor({ state: 'visible' })
    await p.screenshot({ path: `${process.env.WORKSPACE_SHOTS}/harness-preview-desktop.png` })
    await p.mouse.move(700, 500)
  }
  await report(p).evaluate(f => { window.__filmReport = f.contentWindow })
  const before = await film.boundingBox()
  await p.locator('.ws-selected .ws-expand-button').click()
  assert.deepEqual(await film.boundingBox(), before, 'expanding leaves the head as it is')
  await p.locator('.ws-selected .ws-expand-button').click()
  await p.evaluate(() => {
    const original = window.fetch
    window.fetch = async (...args) => {
      const response = await original(...args)
      if (String(args[0]).includes('/api/v1/sent-files?')) {
        const payload = await response.json()
        const receipt = payload.files.find(file => file.fullPath.endsWith('/brief.md'))
        payload.files.push({ ...receipt, timestamp: Date.now() + 1000, sessionId: 'fresh-filmstrip-receipt' })
        return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } })
      }
      return response
    }
  })
  const sendOrder = await film.locator('.ws-tab').evaluateAll(tabs => tabs.map(t => t.getAttribute('aria-label')))
  await p.getByRole('button', { name: 'Return to Desk', exact: true }).click()
  await open(p)
  await poll(p, () => document.querySelector('.ws-tab-fresh')?.getAttribute('aria-label') === 'Field note')
  assert.equal(await tab(p, 'calibration-report').getAttribute('aria-selected'), 'true')
  assert.ok(await report(p).evaluate(f => f.contentWindow === window.__filmReport))
  assert.deepEqual(await film.locator('.ws-tab').evaluateAll(tabs => tabs.map(t => t.getAttribute('aria-label'))), sendOrder, 'a re-send marks its tab fresh without moving it')
  if (process.env.WORKSPACE_SHOTS) {
    await mkdir(process.env.WORKSPACE_SHOTS, { recursive: true })
    await p.screenshot({ path: `${process.env.WORKSPACE_SHOTS}/harness-fresh-desktop.png` })
  }
  await p.setViewportSize({ width: 390, height: 844 })
  await poll(p, () => !document.querySelector('.ws-tabs').checkVisibility())
  if (process.env.WORKSPACE_SHOTS) {
    await p.locator('.ws-page-choice').click()
    await p.screenshot({ path: `${process.env.WORKSPACE_SHOTS}/harness-fresh-phone.png` })
    await p.keyboard.press('Escape')
    await poll(p, () => !document.querySelector('.ws-page-sheet')?.open)
  }
  await choose(p, 'brief.md')
  assert.equal(await p.locator('.ws-tab-fresh').count(), 0)
})

for (const reducedMotion of ['reduce', 'no-preference']) test(`Receipt arrivals move only their tab and folio (${reducedMotion})`, async p => {
  await open(p); await reportReady(p)
  await report(p).evaluate(f => { window.__arrivalReport = f.contentWindow })
  const sendOrder = await p.locator('.ws-tabs .ws-tab').evaluateAll(tabs => tabs.map(t => t.getAttribute('aria-label')))
  await p.evaluate(() => {
    window.__receiptAnimations = []
    const animate = Element.prototype.animate
    Element.prototype.animate = function(frames, options) {
      if (this.matches('.ws-tab,.ws-overview-folio')) window.__receiptAnimations.push({ tab: this.matches('.ws-tab'), frames, options })
      return animate.call(this, frames, options)
    }
    const fetch = window.fetch
    const delivery = Date.now() + 1000
    window.fetch = async (...args) => {
      const response = await fetch(...args)
      if (!String(args[0]).includes('/api/v1/sent-files')) return response
      const payload = await response.json()
      const receipt = payload.files.find(file => file.fullPath.endsWith('/brief.md'))
      if (receipt) payload.files.push({ ...receipt, timestamp: delivery, sessionId: 'arrival-receipt' })
      return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } })
    }
  })
  await p.clock.fastForward(15001)
  await poll(p, () => document.querySelector('.ws-tab-fresh')?.getAttribute('aria-label') === 'Field note')
  assert.deepEqual(await p.locator('.ws-tabs .ws-tab').evaluateAll(tabs => tabs.map(t => t.getAttribute('aria-label'))), sendOrder, 'tabs keep send order through a re-send')
  assert.equal(await tab(p, 'calibration-report').getAttribute('aria-selected'), 'true')
  assert.ok(await report(p).evaluate(f => f.contentWindow === window.__arrivalReport))
  const tabs = await p.evaluate(() => window.__receiptAnimations.filter(a => a.tab))
  assert.equal(tabs.length, reducedMotion === 'reduce' ? 0 : 1)
  if (tabs.length) { assert.equal(tabs[0].options.duration, 280); assert.equal(tabs[0].options.easing, 'ease') }
  await p.locator('.ws-return').click()
  await p.locator('[data-view="shelf"]').click()
  await poll(p, () => document.querySelector('.ws-overview-ribbon [title*="brief.md"]'))
  if (reducedMotion !== 'reduce') await poll(p, () => window.__receiptAnimations.some(a => !a.tab))
  const folios = await p.evaluate(() => window.__receiptAnimations.filter(a => !a.tab))
  assert.equal(folios.length, reducedMotion === 'reduce' ? 0 : 1)
  if (folios.length) {
    assert.equal(folios[0].options.duration, 400)
    assert.equal(folios[0].frames[1].transform, 'translateY(-4px)')
    assert.notEqual(folios[0].frames[1].boxShadow, 'none')
  }
}, undefined, 'false', reducedMotion)

test('j/k step constitutions in Board folio order', async p => {
  await p.locator('[data-view="shelf"]').click()
  await p.locator('.ws-overview-folio').filter({ hasText: name }).click()
  await reportReady(p)
  await p.locator('.ws-channel-title').click()
  const rows = p.locator('.ws-switcher .ws-channel-row')
  const names = await rows.locator('.ws-channel-name').allTextContents()
  assert.ok(names.length >= 2)
  await rows.first().click()
  await poll(p, name => document.querySelector('.ws-channel-title')?.textContent === name, names[0])
  await p.keyboard.press('j')
  await poll(p, name => document.querySelector('.ws-channel-title')?.textContent === name, names[1])
  await p.keyboard.press('k')
  await poll(p, name => document.querySelector('.ws-channel-title')?.textContent === name, names[0])
})

test('Wide reader takes the Desk column as cards, steps visibly, and returns selection to the current card', async p => {
  const column = p.locator('[data-column="awaitingReview"]')
  const names = await column.locator('.kbn-card > .kbn-card-header .kbn-card-name').allTextContents()
  await open(p)
  const sidebar = p.locator('.ws-sidebar').first()
  assert.ok(await sidebar.isVisible(), 'wide desktop defaults open')
  assert.deepEqual(await sidebar.locator('.ws-channel-name').allTextContents(), names)
  assert.equal(await sidebar.locator('.kbn-card').count(), names.length, 'sidebar uses the Desk paper renderer')
  assert.equal(await column.locator('.ws-sidebar-source').count(), names.length)
  const raised = await p.locator('.kbn-desk').evaluate(e => ({ transform: getComputedStyle(e).transform, filter: getComputedStyle(e).filter }))
  assert.match(raised.transform, /0\.94/)
  assert.match(raised.filter, /saturate\(0\.25\)/)
  await p.keyboard.press('j')
  await poll(p, name => document.querySelector('.ws-channel-title')?.textContent === name, names[1])
  const current = sidebar.locator('.ws-channel-row[aria-current="true"]')
  assert.equal(await current.locator('.ws-channel-name').innerText(), names[1])
  assert.ok(await current.evaluate(e => e.getBoundingClientRect().right > e.closest('.ws-sidebar').getBoundingClientRect().right), 'selected card reaches beyond the column')
  await p.keyboard.press('Escape')
  assert.equal(await p.locator('.ws-sidebar-source').count(), 0)
  assert.equal(await p.locator('.kbn-key-selected .kbn-card-name').innerText(), names[1])
}, undefined, null)

test('Card FLIP opens, interrupts and returns on the 280 ms crossing', async p => {
  const entering = await p.evaluate(name => {
    const card = [...document.querySelectorAll('.kbn-desk .kbn-card')].find(card => card.textContent.includes(name))
    const rect = card.getBoundingClientRect()
    card.click()
    const ghost = document.querySelector('.ws-sidebar-flight .ws-channel-row')
    const animation = ghost?.getAnimations()[0]
    return { source: { left: rect.left, top: rect.top }, frames: animation?.effect.getKeyframes(), duration: animation?.effect.getTiming().duration }
  }, name)
  assert.equal(entering.duration, 280)
  assert.ok(entering.frames.every(frame => 'transform' in frame && 'opacity' in frame && !('filter' in frame)))
  await p.waitForTimeout(70)
  await p.locator('.ws-sidebar-toggle').click()
  await poll(p, () => !document.querySelector('.ws-sidebar-flight'))
  assert.equal(await p.locator('.ws-sidebar-flight').count(), 0)
  assert.equal(await p.locator('.ws-sidebar-source').count(), 0)
  await p.locator('.ws-sidebar-toggle').click()
  await p.waitForTimeout(330)
  assert.ok(await p.locator('.ws-sidebar-source').count())
  await p.locator('.ws-return').click()
  await p.waitForTimeout(330)
  assert.equal(await p.locator('.ws-sidebar-source,.ws-card-travelling,.ws-sidebar-flight').count(), 0)
}, undefined, null, 'no-preference')

test('Review plate reaches verdicts from a delivery and leaves the fiber page its own row', async p => {
  await open(p)
  const plate = p.locator('.ws-nav-verdicts .ws-review-plate')
  await plate.waitFor()
  assert.equal(await plate.getAttribute('aria-label'), 'Awaiting review')
  await choose(p, 'Constitution')
  assert.ok(!await plate.isVisible(), 'the fiber page carries its own pair')
  assert.ok(await selected(p).locator('.kbn-ctl-verdict').isVisible())
  await choose(p, 'calibration-report')
  await p.clock.pauseAt(new Date('2026-10-04T14:00:30Z'))
  await plate.getByRole('button', { name: 'Temper', exact: true }).click()
  assert.equal(await p.locator('.ws-verdict-toast').count(), 1)
  assert.equal((await records(p)).filter(r => r.method === 'POST' && r.url.includes('/transition')).length, 0)
  await p.clock.runFor(6000)
  await poll(p, () => window.__harness.requests.some(r => r.method === 'POST' && r.url.includes('/transition')))
})

async function verdictLook(locator) {
  return locator.evaluate(el => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')
    const rgb = color => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3) }
    const luminance = color => rgb(color).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0)
    const style = getComputedStyle(el)
    // A bare verb in the head stands on the veil, whose opaque floor is the ground.
    const fillColor = style.backgroundColor !== 'rgba(0, 0, 0, 0)' ? style.backgroundColor
      : el.closest('.ws-verdict-toast') ? getComputedStyle(el.closest('.ws-verdict-toast')).backgroundColor
      : getComputedStyle(el.closest('.ws-reader')?.querySelector('[data-part="veil"]') ?? document.body).getPropertyValue('--ws-ground').trim() || getComputedStyle(document.body).backgroundColor
    const ink = luminance(style.color), fill = luminance(fillColor)
    return { color: rgb(style.color), fill: rgb(fillColor), ratio: (Math.max(ink, fill) + .05) / (Math.min(ink, fill) + .05) }
  })
}
const tealish = ([r, g, b]) => g > r && b > r
const reddish = ([r, g, b]) => r > g + 30 && r > b + 30
for (const theme of [null, 'night-chart']) test(`Verdict verbs wear one pigment on every surface${theme ? `: ${theme}` : ''}`, async p => {
  if (theme) { const themed = new URL(url); themed.searchParams.set('theme-preview', `01KVBR1F9BWBVKF97473PV67K8:${theme}`); await p.goto(themed.href) }
  await open(p)
  const plate = p.locator('.ws-nav-verdicts .ws-review-plate')
  await plate.waitFor()
  const looks = { plate: [await verdictLook(plate.locator('.kbn-ctl-temper')), await verdictLook(plate.locator('.kbn-ctl-discard'))] }
  await choose(p, 'Constitution')
  looks.act = [await verdictLook(selected(p).locator('.kbn-ctl-verdict .kbn-ctl-temper')), await verdictLook(selected(p).locator('.kbn-ctl-verdict .kbn-ctl-discard'))]
  await p.clock.pauseAt(new Date('2026-10-04T14:00:30Z'))
  await selected(p).locator('.kbn-ctl-verdict .kbn-ctl-discard').click()
  looks.toast = [await verdictLook(p.locator('.ws-verdict-toast .ws-verdict-word'))]
  for (const [surface, [temper, discard]] of Object.entries(looks)) {
    if (temper && discard) { assert.ok(tealish(temper.color), `${surface} Temper ink is verdigris: ${temper.color}`); assert.ok(reddish(discard.color), `${surface} Discard ink is red: ${discard.color}`) }
    for (const look of [temper, discard].filter(Boolean)) assert.ok(look.ratio >= 4.5, `${surface} verdict ink ${look.color} on ${look.fill}: ${look.ratio.toFixed(2)}:1`)
  }
  assert.ok(reddish(looks.toast[0].color), 'the toast names a discard in red')
  if (!theme) {
    assert.deepEqual(looks.plate.map(l => l.color), looks.act.map(l => l.color), 'the plate and the act zone share one verdict ink')
    await p.keyboard.press('z')
    await p.goto(url)
    const card = p.locator('.kbn-desk .kbn-card').filter({ hasText: name })
    await card.hover()
    const desk = [await verdictLook(card.locator('.kbn-action-tempered')), await verdictLook(card.locator('.kbn-action-discard'))]
    assert.ok(tealish(desk[0].color) && reddish(desk[1].color), `Desk verdicts ${JSON.stringify(desk.map(d => d.color))}`)
  }
})

async function anchoredInView(p, panel, trigger, label) {
  await poll(p, () => true)
  const [box, anchor, floor, open, hit] = await Promise.all([panel.boundingBox(), trigger.boundingBox(),
    p.evaluate(() => { const bar = document.querySelector('[data-part="phone-bottom-bar"]'); const r = bar?.getBoundingClientRect(); return r && r.height && r.top > 0 ? r.top : innerHeight }),
    panel.evaluate(el => el.matches(':popover-open')),
    panel.evaluate(el => { const item = el.querySelector('button'); const r = item.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) })])
  const vw = p.viewportSize().width
  assert.ok(open, `${label} rides the top layer`)
  assert.ok(box.x >= 0 && box.x + box.width <= vw && box.y >= 0 && box.y + box.height <= floor + 0.5, `${label} stays inside the viewport: ${JSON.stringify(box)} floor ${floor}`)
  assert.ok(hit, `${label} items are visible, not clipped`)
  const touching = Math.abs(box.y - (anchor.y + anchor.height)) <= 8 || Math.abs(box.y + box.height - anchor.y) <= 8
  assert.ok(touching, `${label} opens against its trigger: ${JSON.stringify({ box, anchor })}`)
  return { box, anchor }
}
for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) test(`Fiber page popovers open anchored and inside the viewport: ${device}`, async p => {
  await open(p); await choose(p, 'Constitution')
  const mic = selected(p).locator('.kbn-ctl-meet-btn')
  if (await mic.count()) {
    await mic.click()
    await anchoredInView(p, selected(p).locator('.kbn-ctl-meet .kbn-ctl-menu'), mic, 'Meeting menu')
    await p.keyboard.press('Escape')
  }
  await selected(p).locator('.kbn-detail-controls-toggle').click()
  for (const name of ['Effort', 'Agent']) {
    const control = selected(p).locator(`select[aria-label="${name}"]`)
    await control.scrollIntoViewIfNeeded()
    if (device === 'phone') continue
    await control.click()
    const picker = selected(p).locator('.ws-select-picker')
    const { box, anchor } = await anchoredInView(p, picker, control, `${name} list`)
    assert.ok(Math.abs(box.x - anchor.x) <= 1, `${name} list aligns with its select`)
    await p.keyboard.press('Escape')
    assert.equal(await picker.count(), 0)
  }
  if (device === 'desktop') {
    await p.locator('.ws-selected .ws-expand-button').click()
    await poll(p, () => !!document.querySelector('.ws-page.ws-expanded'))
    await p.waitForTimeout(400)
    const effort = selected(p).locator('select[aria-label="Effort"]')
    await effort.scrollIntoViewIfNeeded()
    await effort.click()
    const picker = selected(p).locator('.ws-select-picker')
    const first = await anchoredInView(p, picker, effort, 'Effort list (expanded)')
    await selected(p).locator('.ws-prose, .ws-content').first().evaluate(el => { const s = [el, ...el.querySelectorAll('*')].find(n => n.scrollHeight > n.clientHeight + 20 && getComputedStyle(n).overflowY !== 'visible'); if (s) s.scrollTop += 40 })
    await p.waitForTimeout(100)
    const after = await anchoredInView(p, picker, effort, 'Effort list (scrolled)')
    assert.ok(Math.abs((after.box.y - after.anchor.y) - (first.box.y - first.anchor.y)) <= 1, 'the list follows its select through a scroll')
    await p.keyboard.press('Escape')
  }
})

test('Phone fiber page: the folded settings line ends in an ellipsis and counts wrap without orphan separators', async p => {
  await open(p); await choose(p, 'Constitution')
  const toggle = selected(p).locator('.kbn-detail-controls-toggle')
  const history = selected(p).locator('.kbn-ctl-history-toggle')
  const [t, h] = await Promise.all([toggle.boundingBox(), history.boundingBox()])
  assert.ok(t.x + t.width <= h.x + 0.5 || t.y + t.height <= h.y + 0.5, `settings ${JSON.stringify(t)} and History ${JSON.stringify(h)} do not collide`)
  assert.ok(await selected(p).locator('.kbn-ctl-place').evaluate(el => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === 'ellipsis'), 'the path yields and ends in an ellipsis')
  const lines = await selected(p).locator('.ws-prose-contents').evaluate(nav => {
    const clip = nav.getBoundingClientRect().left + parseFloat(getComputedStyle(nav).getPropertyValue('--ws-contents-sep'))
    const items = [...nav.children].map(el => el.getBoundingClientRect())
    const starts = items.filter(r => Math.abs(r.left - items[0].left) < 1)
    return { clip, starts: starts.map(r => r.left), tops: new Set(items.map(r => Math.round(r.top))).size }
  })
  assert.ok(lines.tops > 1, 'the fixture counts wrap at this width')
  for (const left of lines.starts) assert.ok(left + parseFloat('18') <= lines.clip + 0.5, 'a line-leading separator is clipped')
}, { width: 402, height: 874 })

test('Landscape phone keeps a one-row top bar while the fiber awaits review', async p => {
  await open(p)
  assert.ok(!await p.locator('.ws-nav-verdicts').isVisible(), 'the verdict pair moves to the page sheet')
  const bar = await p.locator('.ws-navbar').boundingBox()
  const title = await p.locator('.ws-channel-title').boundingBox()
  assert.ok(bar.height <= title.height + 12, `one row: navbar ${bar.height}px for a ${title.height}px title`)
  await p.locator('.ws-page-choice').click()
  await p.locator('.ws-page-sheet-actions .kbn-ctl-temper').waitFor()
}, { width: 844, height: 390 }, 'false', 'reduce', true)

for (const reducedMotion of ['no-preference', 'reduce']) test(`Sidebar toggle is one transform slide (${reducedMotion})`, async p => {
  await open(p); await reportReady(p)
  await p.waitForTimeout(500) // the reader's own arrival settles first
  for (const opening of [true, false]) {
    await p.evaluate(() => {
      window.__before = new Set(document.getAnimations())
      window.__slide = []
      const t0 = performance.now()
      const tick = () => {
        const page = document.querySelector('.ws-page.ws-selected').getBoundingClientRect()
        window.__slide.push({ t: performance.now() - t0, page: page.left, width: page.width })
        if (performance.now() - t0 < 500) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await p.locator('.ws-sidebar-toggle').click()
    const all = await p.evaluate(() => document.getAnimations().filter(a => !window.__before.has(a) && a.effect?.target?.closest?.('.ws-reader')).map(a => ({
      target: String(a.effect.target.className), kind: a.constructor.name, duration: a.effect.getTiming().duration, properties: [...new Set(a.effect.getKeyframes().flatMap(k => Object.keys(k).filter(key => !['offset', 'easing', 'composite', 'computedOffset'].includes(key))))],
    })))
    const animations = all.filter(a => a.kind === 'Animation')
    assert.deepEqual(all.filter(a => a.kind !== 'Animation' && a.properties.some(name => ['left', 'width', 'transform'].includes(name))), [], 'no layout property transitions run')
    if (reducedMotion === 'reduce') assert.deepEqual(animations, [], 'reduced motion lands instantly')
    else {
      assert.ok(animations.length >= 2, 'the sidebar and the stage move together')
      for (const a of animations) {
        assert.ok(a.duration >= 200 && a.duration <= 240, `slide lasts ${a.duration} ms: ${JSON.stringify(a)}`)
        assert.ok(a.properties.every(name => ['translate', 'opacity', 'clipPath'].includes(name)), `only compositor properties animate: ${a.properties}`)
      }
    }
    await p.waitForTimeout(600)
    const samples = await p.evaluate(() => window.__slide)
    assert.ok(samples.every(s => Math.abs(s.width - samples[0].width) < 1), `the page never changes width: ${samples.map(s => Math.round(s.width)).join(',')}`)
    const lefts = samples.map(s => s.page)
    const steps = lefts.slice(1).map((x, i) => Math.sign(Math.round(x - lefts[i])))
    assert.ok(!(steps.includes(1) && steps.includes(-1)), `the page moves one way, without a double jump: ${lefts.map(Math.round).join(',')}`)
    assert.equal(await p.locator('.ws-sidebar-toggle').getAttribute('aria-expanded'), String(opening))
  }
}, undefined, 'false', reducedMotion)

test('Key discard then plate Temper replaces the pending verdict with one delayed write', async p => {
  await open(p); await reportReady(p)
  await p.clock.pauseAt(new Date('2026-10-04T14:00:30Z'))
  await p.locator('.ws-channel-title').focus(); await p.keyboard.press('x')
  await p.clock.runFor(3000)
  await p.locator('.ws-nav-verdicts .ws-review-plate').getByRole('button', { name: 'Temper', exact: true }).click()
  assert.equal(await p.locator('.ws-verdict-toast').count(), 1)
  assert.match(await p.locator('.ws-verdict-toast').innerText(), /^Tempered/)
  await p.clock.runFor(5999)
  assert.equal((await records(p)).filter(r => r.method === 'POST' && r.url.includes('/transition')).length, 0)
  await p.clock.runFor(1)
  await poll(p, () => window.__harness.requests.some(r => r.method === 'POST' && r.url.includes('/transition')))
  const writes = (await records(p)).filter(r => r.method === 'POST' && r.url.includes('/transition'))
  assert.equal(writes.length, 1)
  assert.equal(JSON.parse(writes[0].body).target, 'tempered')
})

for (const surface of ['Desk', 'fiber']) test(`${surface} verdict buttons delay and undo through the same queue`, async p => {
  await p.clock.pauseAt(new Date('2026-10-04T14:00:30Z'))
  if (surface === 'fiber') { await open(p); await choose(p, 'Constitution') }
  const controls = surface === 'Desk'
    ? p.locator('.kbn-desk .kbn-card').filter({ hasText: name }).locator('.kbn-card-review-meta-actions')
    : selected(p).locator('.kbn-ctl-verdict')
  await controls.getByRole('button', { name: /Discard/ }).click({ force: true })
  assert.equal(await p.locator('.ws-verdict-toast').count(), 1)
  assert.equal((await records(p)).filter(r => r.method === 'POST' && r.url.includes('/transition')).length, 0)
  await p.getByRole('button', { name: `Undo verdict on ${name}`, exact: true }).click()
  await p.clock.runFor(6000)
  assert.equal((await records(p)).filter(r => r.method === 'POST' && r.url.includes('/transition')).length, 0)
})

test('Verdict keys delay writes, guard typing, undo, and commit after leaving the reader', async p => {
  await open(p)
  await p.clock.pauseAt(new Date('2026-10-04T14:00:30Z'))
  const posts = async () => (await records(p)).filter(r => r.method === 'POST' && r.url.includes('/transition'))
  await p.keyboard.press('r')
  assert.equal(await tab(p, 'Constitution').getAttribute('aria-selected'), 'true')
  const composer = selected(p).locator('textarea.kbn-detail-directive')
  assert.ok(await composer.evaluate(el => el === document.activeElement))
  await composer.press('t'); await composer.press('x')
  assert.equal(await p.locator('.ws-verdict-toast').count(), 0)
  await p.locator('.ws-channel-title').focus()
  for (const init of [{ isComposing: true }, { keyCode: 229 }, { metaKey: true }, { ctrlKey: true }]) {
    await p.evaluate(init => document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true, ...init })), init)
  }
  assert.equal(await p.locator('.ws-verdict-toast').count(), 0)
  await p.keyboard.press('t')
  assert.match(await p.locator('.ws-verdict-toast').innerText(), /Tempered Calibrate the shear response · Undo z/)
  assert.equal((await posts()).length, 0)
  await p.clock.runFor(5999)
  assert.equal((await posts()).length, 0)
  await p.keyboard.press('z')
  await p.clock.runFor(1)
  assert.equal((await posts()).length, 0)
  await p.keyboard.press('x')
  await p.getByRole('button', { name: `Undo verdict on ${name}`, exact: true }).click()
  await p.clock.runFor(6000)
  assert.equal((await posts()).length, 0)
  await p.keyboard.press('x')
  await p.locator('.ws-return').click()
  await p.clock.runFor(5999)
  assert.equal((await posts()).length, 0)
  await p.clock.runFor(1)
  await poll(p, () => window.__harness.requests.some(r => r.method === 'POST' && r.url.includes('/transition')))
  assert.equal((await posts()).length, 1)
})

test('Pending verdicts on two fibers commit independently', async p => {
  await open(p)
  await p.clock.pauseAt(new Date('2026-10-04T14:00:30Z'))
  await p.keyboard.press('t')
  await p.locator('.ws-return').click()
  await p.locator('.kbn-desk .kbn-card').filter({ hasText: 'Mask validation notes' }).click()
  await p.locator('.ws-channel-title').waitFor()
  await p.keyboard.press('x')
  assert.equal(await p.locator('.ws-verdict-toast').count(), 2)
  await p.clock.runFor(6000)
  await poll(p, () => window.__harness.requests.filter(r => r.method === 'POST' && r.url.includes('/transition')).length === 2)
})

test('Conversation c (and its dot alias) uses the pill destination in reader and selected Desk card', async p => {
  const remote = p.locator('.kbn-desk .kbn-card').filter({ hasText: 'Remote covariance review' })
  await remote.click()
  const opened = n => poll(p, n => window.__harness.events.filter(e => e.type === 'open-worker').length === n, n)
  await p.keyboard.press('c'); await opened(1)
  assert.ok(!await p.locator('.ws-sidebar').isVisible(), 'c no longer toggles the sidebar')
  await p.keyboard.press('.'); await opened(2)
  await p.locator('.ws-return').click()
  await p.keyboard.press('c'); await opened(3)
  await p.keyboard.press('.'); await opened(4)
})

test('Fiber composer isolates keys; settings and history use mocked daemon', async p => {
  await open(p); await choose(p, 'Constitution')
  const input = p.getByRole('textbox', { name: 'Message for the next worker' })
  await input.fill('hjkl'); await input.press('ArrowLeft'); await input.press('ArrowRight'); await input.press('ArrowUp'); await input.press('ArrowDown')
  await input.press('Alt+ArrowRight')
  assert.equal(await tab(p, 'Constitution').getAttribute('aria-selected'), 'true', 'Alt+Right in the composer must not switch documents')
  await input.press('Alt+ArrowDown')
  assert.equal(await input.inputValue(), 'hjkl')
  assert.equal(await tab(p, 'Constitution').getAttribute('aria-selected'), 'true')
  await p.locator('.ws-selected .kbn-detail-controls-toggle').click()
  assert.ok(await p.getByRole('combobox', { name: 'Agent', exact: true }).isVisible())
  await p.locator('.ws-selected .kbn-detail-controls-toggle').click()
  assert.equal(await p.getByRole('combobox', { name: 'Agent', exact: true }).isVisible(), false)
  await p.getByText('History', { exact: true }).click()
  await poll(p, () => window.__harness.requests.some(r => r.url.includes('/sessions') && r.url.includes('01KVBR1F9BWBVKF97473PV67K8')))
  await selected(p).locator('.kbn-ctl-session-list > li').last().waitFor()
  assert.equal(await selected(p).locator('.kbn-ctl-session-list > li').count(), 2)
  await p.getByText('History', { exact: true }).click()
})

test('Fiber contents replace the duplicate file list and select the newest report', async p => {
  await open(p); await choose(p, 'Constitution')
  assert.equal(await selected(p).locator('.ws-prose-documents').count(), 0)
  await selected(p).locator('.ws-prose-contents button').filter({ hasText: /report/ }).click()
  await poll(p, () => document.querySelector('.ws-tab[aria-selected="true"]')?.getAttribute('aria-label') === 'Calibration report')
  assert.equal(await tab(p, 'calibration-report').getAttribute('aria-selected'), 'true')
})

test('Body file link opens a linked document', async p => {
  await open(p); await choose(p, 'Constitution')
  await selected(p).getByRole('link', { name: 'mask table' }).click()
  await poll(p, () => document.querySelector('.ws-tab[aria-selected="true"]')?.getAttribute('aria-label') === 'mask.csv')
  assert.equal(await tab(p, 'mask.csv').getAttribute('aria-selected'), 'true')
})

test('Body wikilink opens a fiber absent from the card index', async p => {
  await open(p); await choose(p, 'Constitution')
  await selected(p).locator('.kbn-wikilink-live[data-fiber="research/workspace/method-note"]').click()
  await selected(p).getByText('The response correction uses independent simulations and leaves the measured shear unchanged in the null tests.', { exact: true }).waitFor()
})

test('Overview first visit names its window and a numeric stored visit survives reload', async p => {
  await p.locator('[data-view="shelf"]').click()
  await poll(p, () => document.querySelector('.ws-overview-masthead')?.textContent?.includes('The last 30 days'))
  const key = 'shuttle.workspace.overview.seen'
  const seen = Date.parse('2026-10-03T14:00:00Z')
  await p.evaluate(({ key, seen }) => localStorage.setItem(key, JSON.stringify(seen)), { key, seen })
  const readSeen = () => p.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null'), key)
  assert.equal(typeof await readSeen(), 'number', 'the visit is stored as a JSON number')
  assert.equal(await readSeen(), seen)
  await p.reload()
  await p.locator('.kbn-card').filter({ hasText: name }).waitFor()
  assert.equal(await readSeen(), seen, 'reload retains the seeded visit timestamp')
})

test('Overview g selects the first change before folios and its main button opens the fiber', async p => {
  await p.locator('[data-view="shelf"]').click()
  const changes = p.locator('.ws-overview-change[data-uid]')
  await changes.first().waitFor()
  const first = changes.first()
  const uid = await first.getAttribute('data-uid')
  assert.equal(uid, '01KVBR1F9BWBVKF97473PV67K8')
  assert.ok(await first.locator('.ws-overview-change-open').count(), 'the row has a main open button')
  assert.ok(await first.locator('.ws-overview-change-doc').count(), 'the row has document thumbnails')
  await p.locator('.ws-overview-masthead').click()
  await p.keyboard.press('g')
  await poll(p, uid => {
    const selected = document.querySelector('.ws-overview .ws-key-selected')
    return !!selected && (selected.closest('.ws-overview-change')?.getAttribute('data-uid') ?? selected.getAttribute('data-uid')) === uid
  }, uid)
  assert.equal(await p.locator('.ws-overview-folio.ws-key-selected').count(), 0, 'g selects a change ahead of the folios')
  await first.locator('.ws-overview-change-open').click()
  await poll(p, expected => document.querySelector('.ws-channel-title')?.textContent === expected, name)
})

test('Overview document thumbnails open the exact receipt, and seen constitutions recede', async p => {
  await p.locator('[data-view="shelf"]').click()
  const row = p.locator('.ws-overview-change[data-uid="01KVBR1F9BWBVKF97473PV67K8"]')
  const thumbnail = row.locator('.ws-overview-change-doc').nth(1)
  await thumbnail.waitFor()
  const key = await thumbnail.getAttribute('data-key')
  await thumbnail.click()
  await poll(p, key => document.querySelector('.ws-page.ws-selected')?.getAttribute('data-key') === key, key)
  await p.getByRole('button', { name: 'Return to Board', exact: true }).click()
  assert.equal(await row.count(), 0, 'opening the constitution acknowledges its change row')
  const folio = p.locator('.ws-overview-folio[data-uid="01KVBR1F9BWBVKF97473PV67K8"]')
  assert.ok(await folio.evaluate(el => el.classList.contains('ws-overview-seen')))
})

test('Overview lenses, declared-title Find, exact receipt ribbon route and scroll restoration', async p => {
  await p.locator('[data-view="shelf"]').click()
  for (const lens of ['Recent', 'Projects', 'Hosts']) {
    const radio = p.getByRole('radio', { name: lens, exact: true }); await radio.click()
    assert.equal(await radio.getAttribute('aria-checked'), 'true')
  }
  const ribbon = await revealLatestFiles(p)
  const find = p.getByRole('searchbox', { name: 'Find work or files', exact: true })
  await find.fill('Calibrate')
  assert.equal(await p.locator('.ws-overview-folio:visible').count(), 1)
  await poll(p, () => document.querySelector('.ws-overview-ribbon')?.textContent?.includes('Calibration report'))
  await find.fill('Calibration report')
  await poll(p, () => [...document.querySelectorAll('.ws-overview-change[data-uid]')].some(row => row.dataset.uid === '01KVBR1F9BWBVKF97473PV67K8' && row.getClientRects().length > 0))
  assert.ok(await p.locator('.ws-overview-change[data-uid="01KVBR1F9BWBVKF97473PV67K8"] .ws-overview-change-doc').count(), 'Find includes the report’s declared title')
  await find.fill('')
  const receipt = ribbon.locator('button[title*="brief.md"]')
  await receipt.scrollIntoViewIfNeeded()
  await p.locator('.ws-overview').evaluate(e => { window.__overviewScroll = e.scrollTop })
  assert.ok(await p.evaluate(() => window.__overviewScroll > 0), 'overview must actually scroll')
  await receipt.click()
  assert.equal(await tab(p, 'brief.md').getAttribute('aria-selected'), 'true')
  await p.getByRole('button', { name: 'Return to Board', exact: true }).click()
  assert.ok(await p.locator('.ws-overview').evaluate(e => e.scrollTop === window.__overviewScroll))
}, { width: 1440, height: 600 })

test('Overview media thumbnails show duration and a paused first video frame', async p => {
  await p.locator('[data-view="shelf"]').click()
  const ribbon = await revealLatestFiles(p)
  const audioCard = ribbon.locator('button').filter({ has: p.locator('.ws-overview-rib-label').getByText('tone.mp3', { exact: true }) })
  await audioCard.scrollIntoViewIfNeeded()
  await poll(p, () => [...document.querySelectorAll('.kbn-thumbnail-audio')].some(t => /\d+:\d\d/.test(t.textContent)))
  assert.match(await audioCard.innerText(), /\d+:\d\d/)
  assert.doesNotMatch(await audioCard.locator('.ws-overview-thumb').innerText(), /tone\.mp3/, 'ribbon caption owns the filename')
  const videoCard = ribbon.locator('button').filter({ hasText: 'test.mp4' })
  await videoCard.scrollIntoViewIfNeeded()
  await poll(p, () => [...document.querySelectorAll('.kbn-thumbnail-video video')].some(v => v.readyState >= 2 && v.videoWidth > 0 && v.paused))
  assert.ok(await videoCard.locator('video').evaluate(v => v.muted && !v.controls && v.paused && v.currentTime === 0 && v.closest('[inert]')))
})

test('Resent report is one document with three receipts', async p => {
  await open(p)
  assert.equal(await tab(p, 'calibration-report').count(), 1)
  await selected(p).getByRole('button', { name: 'Document menu', exact: true }).click()
  await p.getByText('Receipts (3)', { exact: true }).click()
  assert.equal(await p.locator('.ws-receipts > div').count(), 3)
})

test('Text, markdown, code, image, archive and missing-file cause', async p => {
  await open(p)
  for (const [label, text] of [['readme.txt', 'Fixture text document.'], ['brief.md', 'The transfer ratio is consistent with unity'], ['response.py', 'def response(ell, transfer):']]) {
    await choose(p, label)
    await selected(p).getByText(text, { exact: false }).waitFor()
  }
  await choose(p, 'figure.png')
  await poll(p, () => [...document.querySelectorAll('.ws-page img')].some(i => i.complete && i.naturalWidth > 0))
  await choose(p, 'archive.zip')
  await selected(p).getByRole('link', { name: 'Download', exact: true }).waitFor()
  assert.match(await selected(p).innerText(), /\d+\s*(B|bytes|KB)/i)
  await choose(p, 'not-produced.csv')
  await selected(p).getByText('Not found on umber-workstation', { exact: true }).waitFor()
  assert.match(await selected(p).locator('.ws-document-path').innerText(), /\/deliverables\/not-produced.csv$/)
})

for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) test(`Receded media posters show cached audio peaks and the first video frame (${device})`, async p => {
  await open(p); await choose(p, 'tone.mp3')
  await poll(p, () => document.querySelector('.ws-selected .ws-audio-page')?.dataset.waveform === 'decoded')
  const geometry = await selected(p).locator('.ws-audio-page').evaluate(el => {
    const page = el.parentElement.getBoundingClientRect(), audio = el.getBoundingClientRect()
    return { paddingTop: getComputedStyle(el).paddingTop, topGap: audio.top - page.top, bottomGap: page.bottom - audio.bottom }
  })
  assert.equal(geometry.paddingTop, device === 'phone' ? '24px' : '44px', 'audio shares prose top inset')
  assert.ok(Math.abs(geometry.topGap - geometry.bottomGap) <= 2, `short audio comparison is vertically centered: ${JSON.stringify(geometry)}`)
  await choose(p, 'tone.wav')
  const audioPage = p.locator('.ws-page[data-key$="/tone.mp3"]')
  const audioPoster = audioPage.locator('.ws-media-poster')
  await poll(p, () => document.querySelector('.ws-page[data-key$="/tone.mp3"] .ws-media-poster-ready'))
  assert.equal(await audioPoster.locator('canvas').evaluate(canvas => canvas.width), 1000)
  assert.ok(await audioPoster.locator('canvas').evaluate(canvas => getComputedStyle(canvas).display === 'block'))
  const waveformWidth = await audioPoster.evaluate(el => el.querySelector('canvas').getBoundingClientRect().width / el.getBoundingClientRect().width)
  assert.ok(waveformWidth >= 0.88, `waveform covers most of the neighbour (${waveformWidth})`)
  await choose(p, 'test.mp4')
  await poll(p, () => [...document.querySelectorAll('.ws-selected video')].some(video => video.readyState >= 2 && video.videoWidth > 0))
  const labels = await p.locator('.ws-tab').evaluateAll(tabs => tabs.map(tab => tab.getAttribute('aria-label')))
  const videoIndex = labels.indexOf('test.mp4')
  const adjacent = labels[videoIndex === 0 ? 1 : videoIndex - 1]
  await choose(p, adjacent)
  const videoPoster = p.locator('.ws-page[data-key$="/test.mp4"] .ws-media-poster')
  await poll(p, () => document.querySelector('.ws-page[data-key$="/test.mp4"] .ws-media-poster-ready'))
  assert.ok(await videoPoster.locator('canvas').evaluate(canvas => canvas.width > 0 && canvas.height > 0))
}, viewport)

for (const format of ['mp3', 'wav']) test(`Audio ${format} plays, progresses, pauses away and parking without auto-resume`, async p => {
  await open(p); await choose(p, `tone.${format}`)
  const audio = p.getByRole('tabpanel', { name: `tone.${format}`, exact: true, includeHidden: true }).locator('audio')
  await audio.waitFor({ state: 'attached' })
  await audio.evaluate(a => { window.__audio = a })
  await p.evaluate(() => document.activeElement?.blur())
  await p.keyboard.press('Space')
  assert.ok(await audio.evaluate(a => a.paused), 'Space retains its reader meaning')
  await p.keyboard.press('p')
  await poll(p, () => window.__audio && !window.__audio.paused && window.__audio.currentTime > 0)
  await p.keyboard.press('p')
  assert.ok(await audio.evaluate(a => a.paused), 'p toggles native playback')
  await p.keyboard.press('p')
  await poll(p, () => !window.__audio.paused)
  assert.equal(await p.locator('audio').evaluateAll(as => as.filter(a => !a.paused).length), 1)
  await poll(p, () => [...document.querySelectorAll('audio')].some(e => !e.paused && e.currentTime > 0))
  const other = `tone.${format === 'mp3' ? 'wav' : 'mp3'}`
  await choose(p, other); assert.ok(await audio.evaluate(a => a.paused))
  assert.ok(await audio.evaluate(a => getComputedStyle(a.closest('.ws-content')).opacity === '0' && getComputedStyle(a.closest('.ws-sheet').querySelector('.ws-media-poster')).display === 'grid'), 'receded audio shows a poster, never live controls')
  await audio.evaluate(a => { window.__audioPausedTime = a.currentTime })
  await selected(p).locator('audio').evaluate(async a => { await a.play() })
  assert.equal(await p.locator('audio').evaluateAll(as => as.filter(a => !a.paused).length), 1)
  await choose(p, `tone.${format}`); assert.ok(await audio.evaluate(a => a.paused && a === window.__audio && a.currentTime === window.__audioPausedTime))
  assert.equal(await p.locator('audio').evaluateAll(as => as.filter(a => !a.paused).length), 0)
  await audio.evaluate(async a => { a.currentTime = 0; await a.play() })
  await p.getByRole('button', { name: 'Return to Desk', exact: true }).click()
  assert.ok(await audio.evaluate(a => a.paused))
  await audio.evaluate(a => { window.__audioParkedTime = a.currentTime })
  await open(p, `tone.${format}`)
  assert.ok(await audio.evaluate(a => a.paused && a === window.__audio && a.currentTime === window.__audioParkedTime))
})

test('Audio waveform, transport, comparison, keep-position and keyboard guards', async p => {
  await open(p); await choose(p, 'tone.mp3')
  await poll(p, () => document.querySelector('.ws-selected audio')?.readyState >= 1)
  await poll(p, () => document.querySelector('.ws-selected .ws-audio-page')?.dataset.waveform === 'decoded')
  const audio = selected(p).locator('audio')
  await audio.evaluate(a => { a.currentTime = 0.2 })
  await selected(p).getByRole('combobox', { name: 'Playback rate' }).selectOption('1.25')
  assert.equal(await audio.evaluate(a => a.playbackRate), 1.25)
  const waveform = selected(p).getByRole('slider', { name: 'Playback position' })
  const rect = await waveform.boundingBox()
  await p.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2)
  assert.ok(await audio.evaluate(a => Math.abs(a.currentTime - a.duration / 2) < 0.2))
  await p.mouse.move(rect.x + rect.width * 0.2, rect.y + rect.height / 2)
  assert.match(await selected(p).locator('.ws-audio-hover').innerText(), /\d+:\d\d/)
  const other = selected(p).locator('.ws-audio-compare button').filter({ hasText: 'tone.wav' })
  assert.ok(await other.count())
  await selected(p).getByRole('checkbox', { name: 'Keep position' }).check()
  const position = await audio.evaluate(a => a.currentTime)
  await other.click()
  await poll(p, () => document.querySelector('.ws-tab[aria-selected="true"]')?.getAttribute('aria-label') === 'tone.wav')
  await poll(p, position => Math.abs(document.querySelector('.ws-selected audio').currentTime - position) < 0.2, position)
  assert.ok(await selected(p).locator('audio').evaluate(a => a.paused))
  await selected(p).getByRole('checkbox', { name: 'Keep position' }).uncheck()
  await selected(p).getByRole('button', { name: 'Play', exact: true }).click()
  await poll(p, () => !document.querySelector('.ws-selected audio').paused)
  await selected(p).getByRole('button', { name: 'Pause', exact: true }).click()
  await selected(p).locator('audio').evaluate(a => { a.currentTime = 0 })
  await p.keyboard.press(']')
  assert.ok(await selected(p).locator('audio').evaluate(a => a.currentTime > 0))
  await p.keyboard.press('[')
  assert.equal(await selected(p).locator('audio').evaluate(a => a.currentTime), 0)
  await p.keyboard.press('?')
  await p.getByText('Audio: play / pause', { exact: true }).waitFor()
  await p.keyboard.press('Escape')
})

for (const format of ['mp4', 'webm']) test(`Video ${format} plays and seeks native fixture`, async p => {
  await open(p); await choose(p, `test.${format}`)
  const video = p.getByRole('tabpanel', { name: `test.${format}`, exact: true, includeHidden: true }).locator('video')
  await video.evaluate(async v => { await v.play() })
  await poll(p, () => [...document.querySelectorAll('video')].some(v => v.currentTime > 0 && v.videoWidth > 0))
  await video.evaluate(v => { v.pause(); v.currentTime = 0.5 })
  await poll(p, () => [...document.querySelectorAll('video')].some(v => !v.seeking && Math.abs(v.currentTime - 0.5) < 0.1))
  await video.evaluate(v => { window.__video = v })
  await choose(p, 'Constitution')
  assert.ok(await video.evaluate(v => v.paused && getComputedStyle(v.closest('.ws-content')).opacity === '0' && getComputedStyle(v.closest('.ws-sheet').querySelector('.ws-media-poster')).display === 'grid'))
  await choose(p, `test.${format}`)
  assert.ok(await video.evaluate(v => v === window.__video && Math.abs(v.currentTime - 0.5) < 0.1 && getComputedStyle(v.closest('.ws-content')).opacity === '1'))
})

test('Native PDF renderer loads fixture; owner route and first-page preview', async p => {
  await open(p); await choose(p, 'response.pdf')
  const pdf = selected(p).locator('iframe')
  await pdf.waitFor()
  const fixtureURL = await pdf.getAttribute('src')
  assert.ok(fixtureURL.startsWith('blob:'))
  await poll(p, () => [...document.querySelectorAll('.ws-page iframe')].some(f => f.src.startsWith('blob:') && f.contentDocument?.querySelector('link[href^="chrome-extension://"][href$="pdf_embedder.css"]')))
  const deadline = Date.now() + 2500
  let loaded = false
  while (!loaded && Date.now() < deadline) {
    for (const frame of p.frames().filter(f => f.url().startsWith('chrome-extension://'))) {
      loaded ||= await frame.evaluate(url => {
        const viewer = document.querySelector('pdf-viewer')
        const embed = viewer?.shadowRoot?.querySelector('embed')
        return !!embed && embed.getAttribute('original-url') === url && viewer.loadState_ === 'success' && viewer.documentDimensions?.pageDimensions?.length === 1
      }, fixtureURL)
    }
    if (!loaded) await new Promise(resolve => setTimeout(resolve, 40))
  }
  assert.ok(loaded, 'Chrome PDF extension must finish loading the exact one-page fixture')
  await choose(p, 'remote-summary.pdf')
  await poll(p, () => window.__harness.nativeFiles.rewrites.some(r => r.owner === 'basalt-login-02' && r.path.endsWith('remote-summary.pdf')))
  assert.ok((await records(p)).some(r => r.url.includes('origin=basalt-login-02') && r.url.includes('remote-summary.pdf')))
  await p.getByRole('button', { name: 'Return to Desk', exact: true }).click()
  await p.locator('[data-view="shelf"]').click()
  await revealLatestFiles(p)
  await poll(p, () => [...document.querySelectorAll('.ws-overview iframe')].some(f => f.src.includes('#page=1')))
})

test('Remote worker pill records attach handler without launching a terminal', async p => {
  await p.locator('.kbn-desk .kbn-card').filter({ hasText: 'Remote covariance review' }).click()
  await p.locator('.ws-selected .ws-dock .ws-worker-pill .kbn-card-worker').click()
  await poll(p, () => window.__harness.events.some(e => e.type === 'open-worker') || window.__harness.handlers.some(h => h.path === '/api/v1/attach'))
  const event = await p.evaluate(() => window.__harness.events.find(e => e.type === 'open-worker'))
  assert.equal(event.host, 'basalt-login-02')
  assert.match(event.session, /remote-review-01KVBR3H8DYFXNH96683RX89N0-shuttle/)
})

test('The head worker control opens the same remote worker as the pill', async p => {
  await p.locator('.kbn-desk .kbn-card').filter({ hasText: 'Remote covariance review' }).click()
  await p.locator('.ws-navbar .ws-head-worker .kbn-card-worker').click()
  await poll(p, () => window.__harness.events.some(e => e.type === 'open-worker') || window.__harness.handlers.some(h => h.path === '/api/v1/attach'))
  const event = await p.evaluate(() => window.__harness.events.find(e => e.type === 'open-worker'))
  assert.equal(event.host, 'basalt-login-02')
})

test('Phone overview single column, reader sheet, footer stepping and Back', async p => {
  const switcher = await p.locator('.kbn-viewtabs').boundingBox()
  assert.equal(Math.round(switcher.y + switcher.height), 844, 'view switcher sits at the bottom')
  for (const view of ['desk', 'chronicle', 'shelf']) assert.ok((await p.locator(`[data-view="${view}"]`).boundingBox()).height >= 44)
  const seasons = p.locator('.kbn-viewtabs-lens')
  if (await seasons.locator('.kbn-lens-chip').count()) {
    const gear = await p.locator('.kbn-viewtabs-settings').boundingBox(), lane = await seasons.boundingBox()
    assert.ok(lane.x + lane.width <= gear.x, 'season scrollport ends before Settings')
    await seasons.evaluate(el => { el.scrollLeft = el.scrollWidth })
    assert.ok(await seasons.evaluate(el => el.scrollLeft > 0))
  }
  await p.locator('[data-view="shelf"]').click()
  await poll(p, () => document.querySelector('.ws-overview-change[data-uid]')?.getClientRects().length > 0)
  const firstChange = p.locator('.ws-overview-change[data-uid]').first()
  const firstBounds = await firstChange.evaluate(row => {
    const root = row.closest('.ws-overview')
    const rowBounds = row.getBoundingClientRect(), rootBounds = root.getBoundingClientRect()
    return { scrollTop: root.scrollTop, top: rowBounds.top, bottom: rowBounds.bottom, viewTop: rootBounds.top, viewBottom: rootBounds.bottom }
  })
  assert.equal(firstBounds.scrollTop, 0, 'the phone overview has not scrolled')
  assert.ok(firstBounds.top >= firstBounds.viewTop && firstBounds.bottom <= firstBounds.viewBottom, 'the first changed row is visible on entry')
  assert.equal((await p.locator('.ws-overview').boundingBox()).y, 0, 'overview starts above the bottom switcher')
  await poll(p, () => document.querySelectorAll('.ws-overview-folio:not([hidden])').length >= 2)
  const folios = await p.locator('.ws-overview-folio:visible').evaluateAll(es => es.map(e => e.getBoundingClientRect().x))
  assert.ok(folios.length > 1 && folios.every(x => Math.abs(x - folios[0]) < 2))
  await p.locator('.ws-overview-folio').filter({ hasText: name }).click()
  await tab(p, 'calibration-report').waitFor({ state: 'attached' })
  assert.ok(await p.locator('.ws-thumbbar').isVisible())
  await p.getByRole('button', { name: 'Next document', exact: true }).click()
  assert.equal(await tab(p, 'calibration-report').getAttribute('aria-selected'), 'false')
  await p.getByRole('button', { name: 'Previous document', exact: true }).click()
  assert.equal(await tab(p, 'calibration-report').getAttribute('aria-selected'), 'true')
  await p.getByRole('button', { name: 'Return to Board', exact: true }).click()
  assert.ok(await p.getByRole('searchbox', { name: 'Find work or files', exact: true }).isVisible())
}, { width: 390, height: 844 })

test('Phone HTML reader retains its opaque frame and reading position', async p => {
  await open(p); const frame = await reportReady(p)
  const inner = await reportDocument(p)
  assert.equal(await frame.evaluate(f => f.contentDocument), null)
  await inner.evaluate(() => window.scrollTo(0, 160))
  await pollReport(p, () => document.scrollingElement.scrollTop === 160)
  await p.getByRole('button', { name: 'Next document', exact: true }).click()
  await p.getByRole('button', { name: 'Previous document', exact: true }).click()
  assert.equal(await reportY(p), 160)
  const box = await selected(p).boundingBox()
  assert.equal(box.x, 0, 'HTML page starts at the phone edge')
  assert.equal(box.width, p.viewportSize().width, 'HTML page fills the phone width')
  await mkdir(shots, { recursive: true })
  await p.screenshot({ path: resolve(shots, 'sandbox-report-phone.png') })
}, { width: 390, height: 844 })

for (const viewport of [{ width: 375, height: 667 }, { width: 390, height: 844 }, { width: 430, height: 932 }]) {
  test(`Phone ${viewport.width}: edge-to-edge page, modal sheet choice, focus and browser Back`, async p => {
    await open(p); await reportReady(p)
    const geometry = await selected(p).evaluate(el => {
      const rect = el.getBoundingClientRect(), sheet = getComputedStyle(el.querySelector('.ws-sheet'))
      return { x: rect.x, width: rect.width, border: sheet.borderTopWidth, radius: sheet.borderRadius, shadow: sheet.boxShadow }
    })
    assert.equal(geometry.x, 0); assert.equal(geometry.width, viewport.width)
    assert.equal(geometry.border, '0px'); assert.equal(geometry.radius, '0px'); assert.equal(geometry.shadow, 'none')
    assert.equal(await p.locator('.ws-nav-tabs').isVisible(), false)
    assert.equal(await selected(p).locator('.ws-labelbar').isVisible(), false)
    assert.equal((await p.locator('.ws-thumbbar').boundingBox()).height, 56)
    const url = p.url()
    const opener = p.getByRole('button', { name: 'Choose a page', exact: true })
    await opener.click()
    const sheet = p.getByRole('dialog', { name: 'Pages in this constitution' })
    await sheet.waitFor()
    assert.equal(p.url(), url, 'sheet is a same-address history layer')
    assert.equal(await sheet.locator('.ws-page-sheet-row').count(), await tab(p, 'Constitution').evaluate(t => t.parentElement.children.length))
    assert.equal(await sheet.locator('[aria-current="page"] .ws-page-sheet-title').innerText(), 'Calibration report')
    assert.match(await sheet.locator('[aria-current="page"] .ws-page-sheet-summary').innerText(), /sent 1m ago · 3 receipts/)
    for (let i = 0; i < 22; i++) {
      await p.keyboard.press('Tab')
      assert.ok(await sheet.evaluate(el => el.contains(document.activeElement)), 'native modal keeps focus inside the sheet')
    }
    await p.keyboard.press('l')
    assert.equal(await tab(p, 'calibration-report').getAttribute('aria-selected'), 'true', 'sheet keys cannot step reader')
    await p.goBack()
    await poll(p, () => !document.querySelector('.ws-page-sheet').open)
    assert.equal(p.url(), url); assert.ok(await opener.evaluate(el => el === document.activeElement))
    await opener.click()
    await sheet.getByRole('button', { name: 'Field note', exact: true }).click()
    await poll(p, () => !document.querySelector('.ws-page-sheet').open)
    assert.equal(await tab(p, 'brief.md').getAttribute('aria-selected'), 'true')
    await opener.click(); await p.mouse.click(10, 10)
    await poll(p, () => !document.querySelector('.ws-page-sheet').open)
    await opener.click()
    const grabber = await sheet.getByRole('button', { name: 'Close pages' }).boundingBox()
    await swipe(p, grabber.x + grabber.width / 2, grabber.y + 20, grabber.x + grabber.width / 2, grabber.y + 90)
    await poll(p, () => !document.querySelector('.ws-page-sheet').open)
    await p.getByRole('button', { name: 'Return to Desk', exact: true }).click()
    await poll(p, () => document.querySelector('.ws-reader')?.inert)
  }, viewport)
}

test('Phone page swipe steps from documents and the bar; edges, vertical pans and sideways content keep their touches', async p => {
  await open(p); await reportReady(p)
  const key = () => selected(p).getAttribute('data-key')
  const original = await key()
  await swipe(p, 300, 420, 120, 424)
  const next = await key()
  assert.notEqual(next, original, 'a swipe inside the sandboxed report steps to the next page')
  await poll(p, () => !document.querySelector('.ws-stage').classList.contains('ws-swiping'))
  await swipe(p, 100, 420, 300, 416)
  assert.equal(await key(), original, 'a swipe on a board-rendered page steps back')
  await swipe(p, 5, 420, 200, 420)
  assert.equal(await key(), original, 'Safari edge-back starts are not claimed')
  await swipe(p, p.viewportSize().width - 5, 420, 150, 420)
  assert.equal(await key(), original, 'right-edge starts are not claimed')
  await swipe(p, 200, 650, 204, 250)
  assert.equal(await key(), original, 'vertical report scroll is not a page gesture')
  await poll(p, () => document.querySelector('.ws-reader').classList.contains('ws-topbar-hidden'))
  await p.waitForTimeout(650) // Let the native touch fling settle before returning to the top.
  await (await reportDocument(p)).evaluate(() => window.scrollTo(0, 0))
  await poll(p, () => !document.querySelector('.ws-reader').classList.contains('ws-topbar-hidden'))
  const table = await report(p).contentFrame().locator('#wide-table').boundingBox()
  assert.ok(await (await reportDocument(p)).evaluate(() => { const el = document.getElementById('wide-table'); return el.scrollWidth > el.clientWidth }), 'the fixture table scrolls sideways')
  await swipe(p, 300, table.y + table.height / 2, 100, table.y + table.height / 2)
  assert.equal(await key(), original, 'a horizontally scrollable table keeps its swipe')
  for (const id of ['gesture-deck', 'gesture-carousel']) {
    await (await reportDocument(p)).evaluate(id => document.getElementById(id).scrollIntoView({ block: 'center' }), id)
    // Hiding the top bar moves the report under the finger; swipe once it has settled.
    await poll(p, () => document.querySelector('.ws-reader').classList.contains('ws-topbar-hidden'))
    await p.waitForTimeout(400)
    const gesture = await report(p).contentFrame().locator(`#${id}`).boundingBox()
    await swipe(p, 300, gesture.y + gesture.height / 2, 100, gesture.y + gesture.height / 2)
    assert.equal(await key(), original, `${id} keeps its own sideways gesture`)
  }
  await (await reportDocument(p)).evaluate(() => window.scrollTo(0, 0))
  const bar = await p.locator('.ws-thumbbar').boundingBox()
  await swipe(p, 220, bar.y + 22, 80, bar.y + 26)
  assert.equal(await key(), next, 'the bottom bar remains a swipe surface')
  await swipe(p, 120, 420, 300, 420, true)
  assert.equal(await key(), next, 'a cancelled swipe stays on its page')
  await poll(p, () => !document.querySelector('.ws-stage').classList.contains('ws-swiping'))
  await choose(p, 'brief.md')
  const brief = await key()
  const block = selected(p).locator('table')
  await block.waitFor()
  assert.equal(await selected(p).locator('.kbn-fileview-text').evaluate(el => el.scrollWidth <= el.clientWidth), true, 'a wide table does not widen the page')
  const box = await block.boundingBox()
  assert.ok(await block.evaluate(el => el.scrollWidth > el.clientWidth), 'the field note table scrolls sideways inside the page')
  await swipe(p, 300, box.y + box.height / 2, 100, box.y + box.height / 2)
  assert.equal(await key(), brief, 'a sideways-scrolling markdown table keeps its swipe')
  await swipe(p, 300, box.y + box.height + 60, 100, box.y + box.height + 64)
  assert.notEqual(await key(), brief, 'board-rendered prose below the table still pages')
}, { width: 390, height: 844 })

test('Phone page bar steps aside while a page field holds the keyboard', async p => {
  await open(p); await choose(p, 'Constitution')
  const field = selected(p).locator('textarea').first()
  await field.focus()
  assert.equal(await p.locator('.ws-thumbbar').isVisible(), false, 'the bar would sit under the keyboard accessory')
  await field.evaluate(el => el.blur())
  assert.ok(await p.locator('.ws-thumbbar').isVisible())
}, { width: 390, height: 844 })

test('Phone page swipe follows the finger, snaps back short of the threshold and commits past it', async p => {
  await open(p); await reportReady(p)
  const original = await selected(p).getAttribute('data-key')
  const rest = await p.locator('.ws-track').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).m41)
  const cdp = await p.context().newCDPSession(p)
  const touch = (type, x, y = 420) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 1, radiusY: 1 }] })
  await touch('touchStart', 300)
  for (const x of [292, 280, 260, 240]) { await touch('touchMove', x); await p.waitForTimeout(30) }
  await poll(p, () => document.querySelector('.ws-stage').classList.contains('ws-swiping'))
  const held = await p.locator('.ws-track').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).m41)
  assert.ok(Math.abs(held - (rest - 60)) <= 2, `the track follows the finger (${rest} → ${held})`)
  const neighbour = await p.locator('.ws-page.ws-after').first().boundingBox()
  assert.ok(neighbour.x < p.viewportSize().width, 'the next page peeks in')
  assert.deepEqual(await p.locator('.ws-page.ws-after').first().evaluate(el => { const s = getComputedStyle(el); return [s.maskImage, s.opacity, s.transform] }), ['none', '1', 'none'], 'the phone neighbour is a flat sheet, not a faded recession')
  await p.waitForTimeout(200)
  await touch('touchEnd')
  await poll(p, rest => Math.abs(new DOMMatrix(getComputedStyle(document.querySelector('.ws-track')).transform).m41 - rest) < 1, rest)
  assert.equal(await selected(p).getAttribute('data-key'), original, 'a short, slow release snaps back')
  await touch('touchStart', 320)
  for (const x of [310, 260, 200, 140, 90]) { await touch('touchMove', x); await p.waitForTimeout(16) }
  await touch('touchEnd')
  assert.notEqual(await selected(p).getAttribute('data-key'), original, 'a long release commits')
  assert.ok(await p.locator('.ws-stage').evaluate(el => el.classList.contains('ws-swipe-release')), 'the commit settles on the release curve')
  await cdp.detach()
}, { width: 390, height: 844 }, 'false', 'no-preference')

async function swipe(p, x, y, endX, endY, cancel = false) {
  const cdp = await p.context().newCDPSession(p)
  const point = (x, y) => [{ x, y, radiusX: 1, radiusY: 1 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(x, y) })
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(x + (endX - x) * i / 6, y + (endY - y) * i / 6) })
    await p.waitForTimeout(20)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] })
  await p.waitForTimeout(80)
  await cdp.detach()
}

test('Reader s and Cmd-Backslash toggle sidebar; slash focuses Find, filters filenames and Enter selects', async p => {
  await open(p)
  const title = p.locator('.ws-channel-title')
  const sidebar = p.locator('.ws-sidebar')
  await title.focus()
  await p.keyboard.press('s')
  assert.ok(await sidebar.isVisible())
  for (const page of await p.locator('.ws-page.ws-receded.ws-before').all()) {
    assert.equal(await page.evaluate(el => getComputedStyle(el).clipPath), 'inset(0px 100% 0px 0px)', 'left neighbours are masked behind the sidebar')
  }
  assert.notEqual(await p.locator('.ws-page.ws-receded.ws-after').first().evaluate(el => getComputedStyle(el).maskImage), 'none', 'right neighbour keeps its edge fade')
  assert.equal(await p.getByRole('button', { name: 'Hide constitutions', exact: true }).getAttribute('aria-expanded'), 'true')
  await title.focus()
  await p.keyboard.press('/')
  const find = sidebar.getByRole('searchbox', { name: 'Find a constitution', exact: true })
  assert.ok(await find.evaluate(e => e === document.activeElement))
  for (const query of ['Calibrate the shear response', 'research/workspace/calibration-report', 'TONE.MP3']) {
    await find.fill(query)
    if (!query.includes('/')) assert.equal(await sidebar.locator('.ws-channel-row').count(), 1, `sidebar matches ${query}`)
    assert.ok((await sidebar.locator('.ws-channel-name').allTextContents()).includes(name), `sidebar includes the constitution matching ${query}`)
  }
  await find.press('Enter')
  assert.equal(await p.locator('.ws-channel-title').innerText(), name)
  assert.ok(await sidebar.isVisible(), 'selection keeps the sidebar open')
  await title.focus(); await p.keyboard.press('/')
  assert.ok(await find.evaluate(e => e === document.activeElement))
  await find.press('Escape')
  assert.ok(await sidebar.isVisible(), 'Escape from sidebar Find does not return to Desk')
  assert.ok(await title.evaluate(e => e === document.activeElement), 'Escape restores Find opener focus')
  await p.keyboard.press('s')
  assert.equal(await sidebar.isVisible(), false)
  await p.keyboard.press('Meta+Backslash')
  assert.ok(await sidebar.isVisible(), 'Cmd-Backslash remains a sidebar alias')
  await p.keyboard.press('Meta+Backslash')
  assert.equal(await sidebar.isVisible(), false)
})

test('Reader slash opens constitution picker; Escape restores focus and Enter chooses file match', async p => {
  await open(p)
  const title = p.locator('.ws-channel-title')
  await title.focus(); await p.keyboard.press('/')
  const picker = p.locator('.ws-switcher')
  // Both search and text inputs are valid native Find fields; focus is the contract.
  const input = picker.locator('input[aria-label="Find a constitution"]')
  await input.waitFor()
  assert.ok(await input.evaluate(e => e === document.activeElement))
  await input.fill('remote-summary.pdf')
  assert.equal(await picker.locator('.ws-channel-row').count(), 1)
  assert.equal(await picker.locator('.ws-channel-name').innerText(), name)
  await input.press('Escape')
  assert.equal(await picker.count(), 0)
  assert.ok(await title.evaluate(e => e === document.activeElement))
  assert.equal(await p.locator('.ws-sidebar').isVisible(), false)
  await p.keyboard.press('/')
  await input.fill('transfer.txt')
  assert.equal(await picker.locator('.ws-channel-row').count(), 1)
  assert.equal(await picker.locator('.ws-channel-name').innerText(), 'Remote covariance review')
  await input.press('Enter')
  await poll(p, () => document.querySelector('.ws-channel-title')?.textContent === 'Remote covariance review')
  assert.equal(await picker.count(), 0)
})

test('Sidebar current card follows Board folio j/k, Alt navigation and browser Back immediately', async p => {
  await p.locator('[data-view="shelf"]').click()
  await p.locator('.ws-overview-folio').filter({ hasText: name }).click()
  await reportReady(p)
  await p.locator('.ws-channel-title').focus()
  await p.keyboard.press('s')
  const sidebar = p.locator('.ws-sidebar')
  const rows = sidebar.locator('.ws-channel-row')
  assert.ok(await sidebar.isVisible())
  const names = await rows.locator('.ws-channel-name').allTextContents()
  assert.ok(names.length >= 4, 'navigation exercises several constitutions')
  await rows.first().click()
  await poll(p, first => document.querySelector('.ws-channel-title')?.textContent === first, names[0])
  await assertCurrent(names[0])
  let index = 0
  for (const [key, delta] of [['j', 1], ['j', 1], ['j', 1], ['k', -1], ['k', -1], ['Alt+ArrowDown', 1], ['Alt+ArrowUp', -1]]) {
    await p.keyboard.press(key)
    index += delta
    await assertCurrent(names[index])
  }
  await p.goBack()
  await poll(p, previous => document.querySelector('.ws-channel-title')?.textContent === previous, names[index + 1])
  await assertCurrent(names[index + 1])

  async function assertCurrent(expected) {
    // One browser observation after each key: title and current row must agree
    // together, without polling away a stale selection marker.
    const state = await sidebar.evaluate(sidebar => {
      const current = [...sidebar.querySelectorAll('.ws-channel-row[aria-current="true"]')]
      const row = current[0]
      const list = sidebar.querySelector('.ws-channel-list')
      const bounds = row?.getBoundingClientRect()
      const viewport = list.getBoundingClientRect()
      const other = sidebar.querySelector('.ws-channel-row:not([aria-current="true"])')
      const material = el => {
        const css = getComputedStyle(el)
        return [css.backgroundColor, css.boxShadow, css.transform].join('|')
      }
      return {
        count: current.length,
        name: row?.querySelector('.ws-channel-name')?.textContent,
        reader: document.querySelector('.ws-channel-title')?.textContent,
        distinguished: !!row && !!other && material(row) !== material(other),
        inView: !!bounds && bounds.top >= viewport.top - 1 && bounds.bottom <= viewport.bottom + 1,
      }
    })
    assert.equal(state.count, 1)
    assert.equal(state.name, expected)
    assert.equal(state.reader, expected)
    assert.ok(state.distinguished, 'current row has a distinct selected surface')
    assert.ok(state.inView, 'reduced-motion nearest scrolling keeps the current row visible')
  }
}, { width: 1440, height: 460 })

test('Desk slash opens the same constitution picker without opening reader; Escape and Enter work', async p => {
  const opener = p.locator('[data-view="shelf"]')
  await opener.focus(); await p.keyboard.press('/')
  assert.equal(await p.locator('.ws-page.ws-selected:visible').count(), 0, 'Find does not enter the reader')
  const picker = p.locator('.ws-switcher')
  const input = picker.locator('input[aria-label="Find a constitution"]')
  await input.waitFor()
  assert.ok(await input.evaluate(e => e === document.activeElement))
  for (const query of ['Calibrate the shear response', 'research/workspace/calibration-report', 'tone.mp3']) {
    await input.fill(query)
    if (!query.includes('/')) assert.equal(await picker.locator('.ws-channel-row').count(), 1, `Desk picker matches ${query}`)
    assert.ok((await picker.locator('.ws-channel-name').allTextContents()).includes(name), `Desk picker includes the constitution matching ${query}`)
  }
  await input.press('Escape')
  assert.equal(await picker.count(), 0)
  assert.equal(await p.locator('.ws-page.ws-selected:visible').count(), 0)
  assert.ok(await opener.evaluate(e => e === document.activeElement), 'Desk Find restores opener focus')
  await p.keyboard.press('/')
  await input.fill('tone.mp3')
  await input.press('Enter')
  await reportReady(p)
  assert.equal(await p.locator('.ws-channel-title').innerText(), name)
  assert.equal(await tab(p, 'calibration-report').getAttribute('aria-selected'), 'true')
})

for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  test(`Worker plate and undo toast states: ${device}`, async p => {
    const shot = async state => {
      if (!process.env.WORKSPACE_SHOTS) return
      await mkdir(process.env.WORKSPACE_SHOTS, { recursive: true })
      await poll(p, () => !document.querySelector('.ws-selected .ws-body-status')?.textContent.includes('Loading'))
      await p.screenshot({ path: resolve(process.env.WORKSPACE_SHOTS, `verdict-${device}-${state}.png`) })
    }
    await open(p)
    assert.ok(await p.locator('.ws-navbar .ws-head-worker').isHidden(), 'a fiber with no worker leaves the head without a worker control')
    if (device === 'phone') {
      assert.ok(!await p.locator('.ws-nav-verdicts').isVisible(), 'the phone top bar stays the name alone')
      await p.locator('.ws-page-choice').click()
      const sheetPlate = p.locator('.ws-page-sheet-actions .ws-review-plate')
      await sheetPlate.waitFor()
      const buttons = await sheetPlate.locator('button').evaluateAll(es => es.map(e => {
        const rect = e.getBoundingClientRect()
        return { x: rect.x, right: rect.right, y: rect.y, bottom: rect.bottom, height: rect.height, text: e.textContent }
      }))
      assert.deepEqual(buttons.map(b => b.text), ['Temper', 'Discard'])
      assert.ok(buttons.every(rect => rect.height >= 44 && rect.x >= 0 && rect.right <= viewport.width && rect.y >= 0 && rect.bottom <= viewport.height), 'phone review buttons are thumb-sized in the page sheet')
      await shot('page-sheet-verdicts')
      await p.keyboard.press('Escape')
      await poll(p, () => !document.querySelector('.ws-page-sheet')?.open)
    } else {
      const plate = p.locator('.ws-nav-verdicts .ws-review-plate')
      await plate.waitFor()
      const [plateBox, lead] = await Promise.all([plate.boundingBox(), p.locator('.ws-nav-lead').boundingBox()])
      assert.ok(plateBox.x >= lead.x && plateBox.x + plateBox.width <= lead.x + lead.width + 0.5, 'the verdict pair sits beside the fiber name in the navbar')
    }
    await shot('awaiting-review')
    await p.keyboard.press('t')
    await p.locator('.ws-verdict-toast').waitFor()
    assert.equal(await p.locator('.ws-verdict-toasts').getAttribute('aria-live'), 'polite')
    assert.equal(await p.locator('.ws-verdict-toast').evaluate(e => getComputedStyle(e).animationName), 'none')
    const toastBox = await p.locator('.ws-verdict-toasts').boundingBox()
    const labelBox = await p.locator(device === 'phone' ? '.ws-thumbbar' : '.ws-selected .ws-labelbar').boundingBox()
    assert.ok(toastBox.y + toastBox.height <= labelBox.y - 12, 'undo toast clears the page label or phone bottom bar by 12 px')
    await shot('toast')
    await p.keyboard.press('z')
    await p.locator('.ws-return').click()
    await chooseDeskColumn(p, 1)
    await p.locator('.kbn-desk .kbn-card').filter({ hasText: 'Remote covariance review' }).click()
    // Opening the reader is navigation, not a state change: wait for it before the short poll.
    await p.locator('.ws-selected .ws-dock .ws-worker-control').waitFor()
    await poll(p, () => document.querySelector('.ws-selected .ws-dock .ws-worker-control')?.textContent.includes('12 m'))
    const dot = p.locator('.ws-selected .ws-dock .ws-worker-pill .ws-worker-dot')
    assert.ok(await dot.isVisible(), 'the act zone pill shows its worker dot')
    assert.equal(await dot.evaluate(el => getComputedStyle(el).animationName), 'none', 'reduced motion suppresses breathing')
    assert.ok(await p.locator('.ws-selected .ws-dock .ws-worker-pill .ws-turn-active').count())
    const head = p.locator('.ws-navbar .ws-head-worker .ws-worker-control')
    await poll(p, () => document.querySelector('.ws-navbar .ws-head-worker .ws-worker-control')?.dataset.workerState === 'aloft')
    const headDot = await head.locator('.ws-worker-dot').evaluate(el => getComputedStyle(el).backgroundColor)
    const headLook = await head.evaluate(el => ({ border: getComputedStyle(el).borderTopWidth, background: getComputedStyle(el).backgroundColor }))
    assert.deepEqual(headLook, { border: '0px', background: 'rgba(0, 0, 0, 0)' }, 'the head draws the worker bare')
    const headBox = await head.boundingBox(), position = await p.locator('.ws-head-position').boundingBox()
    if (device === 'phone') {
      assert.ok(await head.locator('.ws-worker-state').isHidden(), 'the phone top bar shows the dot alone')
      assert.ok(headBox.width >= 44 && headBox.height >= 44, `the phone dot is a full target: ${JSON.stringify(headBox)}`)
      assert.ok(headBox.x + headBox.width >= viewport.width - 16, 'the phone dot sits at the right end of the top bar')
    } else {
      assert.match(await head.innerText(), /aloft\s*12 m/)
      assert.ok(headBox.x + headBox.width <= position.x, 'the worker control precedes the page count')
    }
    await shot('aloft')
    await p.evaluate(async () => {
      const row = window.__harness.MOCK_FEED.fibers.find(row => row.fiber.name === 'Remote covariance review')
      row.runtime.phase = 'waiting'
      row.runtime.last_activity_at = Date.now() - 120000
      await window.__harness.modal.fetchAndRender()
    })
    await poll(p, () => document.querySelector('.ws-selected .ws-dock .ws-worker-control')?.dataset.workerState === 'waiting')
    assert.equal(await p.locator('.ws-selected .ws-dock .ws-worker-pill .ws-turn-active').count(), 0)
    await poll(p, () => document.querySelector('.ws-navbar .ws-head-worker .ws-worker-control')?.dataset.workerState === 'waiting')
    assert.notEqual(await head.locator('.ws-worker-dot').evaluate(el => getComputedStyle(el).backgroundColor), headDot, 'a waiting worker turns the head dot gold')
    await shot('waiting')
    await p.locator('.ws-return').click()
    await chooseDeskColumn(p, 0)
    await p.locator('.kbn-desk .kbn-card').filter({ hasText: 'Weekly shear summary' }).click()
    await poll(p, () => { const pill = document.querySelector('.ws-selected .ws-dock .ws-worker-pill'); return pill?.hidden === true && getComputedStyle(pill).display === 'none' })
    await poll(p, () => document.querySelector('.ws-navbar .ws-head-worker')?.hidden === true)
    await shot('no-worker')
  }, viewport)
}

test('Only the owner-reported working phase breathes, on a 2.4 s opacity cycle', async p => {
  await p.locator('.kbn-desk .kbn-card').filter({ hasText: 'Remote covariance review' }).click()
  const dot = p.locator('.ws-selected .ws-dock .ws-worker-pill .ws-worker-dot')
  await dot.waitFor()
  const timing = await p.evaluate(() => {
    const css = getComputedStyle(document.querySelector('.ws-selected .ws-dock .ws-worker-pill .ws-worker-dot'))
    return { name: css.animationName, duration: css.animationDuration, easing: css.animationTimingFunction }
  })
  assert.deepEqual(timing, { name: 'ws-worker-breathe', duration: '2.4s', easing: 'ease-in-out' })
}, undefined, 'false', 'no-preference')

// Say-it-once checks cover the selected page and its chrome. Tabs and the
// constitution switcher repeat names as navigation actions. The desktop fiber
// title is a reading anchor; the phone uses only the navbar name. Expanded
// settings may repeat values in editable controls. Parked/receded pages and
// the inert Desk are not a second readable screen.
const inventory = []
const shots = process.env.WORKSPACE_SHOTS || '/tmp/workspace-say-once'
for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  test(`Say it once: ${device} fiber, media, PDF and unsupported metadata`, async p => {
    await open(p); await choose(p, 'Constitution')
    const header = selected(p).locator('.ws-prose-header')
    assert.equal((await header.innerText()).trim().toLowerCase(), 'awaiting your review', 'fiber kicker uses the Desk state')
    assert.equal(await header.locator(':scope > *').count(), 1)
    const settings = selected(p).locator('.kbn-detail-controls-toggle')
    assert.equal(await settings.getAttribute('aria-expanded'), 'false')
    assert.match(await settings.innerText(), /claude-opus/)
    assert.match(await settings.innerText(), /high/)
    assert.match(await settings.innerText(), /umber-workstation/)
    assert.match(await settings.innerText(), /\/fixture-store\/workspace/)
    assert.equal(await selected(p).locator('.kbn-ctl-agent').count(), 1)
    assert.equal(await selected(p).locator('.kbn-ctl-effort').count(), 1)
    assert.equal(await selected(p).locator('.kbn-ctl-place').count(), 1)
    assert.equal(await selected(p).locator('.ws-agent,.ws-prose-agent,.ws-prose-host,.ws-dock-status').count(), 0)
    const passive = await selected(p).evaluate(page => {
      const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT)
      const text = []
      while (walker.nextNode()) {
        const parent = walker.currentNode.parentElement
        if (parent.checkVisibility({ visibilityProperty: true }) && !parent.closest('.kbn-detail-controls,.kbn-ctl-history')) text.push(walker.currentNode.textContent)
      }
      return text.join(' ')
    })
    assert.doesNotMatch(passive, /claude-opus|\bhigh\b|umber-workstation|\/fixture-store\/workspace/, 'launch metadata has no passive home outside settings')
    assert.ok(await p.locator('.ws-navbar .kbn-card-worker').count() <= 1, 'the head carries at most one worker control')
    assert.ok(await selected(p).locator('.kbn-card-worker').count() <= 1, 'the act zone pill is the only conversation control')
    assert.equal(await selected(p).locator('.ws-fiber-prose > h1:visible').count(), device === 'phone' ? 0 : 1, 'desktop title is the adopted reading anchor; phone navbar owns the name')
    const navbar = p.locator('.ws-navbar')
    assert.doesNotMatch(await navbar.innerText(), /claude-opus|umber-workstation|fixture-store/)
    assert.match(await selected(p).locator('.ws-provenance').innerText(), /changed 47m ago/i, 'fiber time comes from modified_at, not updated_at or receipts')
    assert.doesNotMatch(await selected(p).locator('.ws-provenance').innerText(), /fiber page|umber-workstation|claude-opus/)
    await capture('fiber')
    // Expanded editable values are an action exception, not passive duplicates.
    await settings.click()
    assert.ok(await selected(p).getByRole('combobox', { name: 'Agent', exact: true }).isVisible())
    await capture('settings-expanded')
    await settings.click()
    await selected(p).getByText('History', { exact: true }).click()
    await selected(p).locator('.kbn-ctl-session-list > li').last().waitFor()
    await capture('history-expanded')
    await selected(p).getByText('History', { exact: true }).click()
    await choose(p, 'calibration-report')
    await reportReady(p)
    await capture('report')
    await choose(p, 'Constitution')
    for (const [state, label] of [['media', 'tone.mp3'], ['pdf', 'response.pdf'], ['unsupported', 'archive.zip']]) {
      await choose(p, label)
      if (state === 'media') {
        await poll(p, () => document.querySelector('.ws-selected audio')?.readyState >= 1)
        await poll(p, () => document.querySelector('.ws-selected .ws-audio-page')?.dataset.waveform === 'decoded')
        assert.equal(await selected(p).locator('.ws-audio-waveform').count(), 1, 'the listening instrument owns position controls')
        await capture('audio-paused')
        await selected(p).getByRole('button', { name: 'Play', exact: true }).click()
        await poll(p, () => document.querySelector('.ws-selected audio')?.currentTime > 0.2)
        await capture('audio-playing')
        await selected(p).getByRole('button', { name: 'Pause', exact: true }).click()
      }
      if (state === 'pdf') await selected(p).locator('iframe').waitFor()
      if (state === 'unsupported') await selected(p).getByRole('link', { name: 'Download', exact: true }).waitFor()
      await poll(p, () => {
        const viewer = document.querySelector('.ws-selected .ws-document-viewer')
        return viewer && getComputedStyle(viewer).opacity === '1'
      })
      assert.equal(await selected(p).locator('.ws-label-title').innerText(), label)
      const provenance = await selected(p).locator('.ws-provenance').innerText()
      assert.match(provenance, /sent 2m ago/)
      assert.doesNotMatch(provenance, /claude-opus|umber-workstation/)
      assert.equal(await selected(p).locator('.ws-content .kbn-media-title,.ws-content .kbn-media-provenance,.ws-content h1,.ws-content h3').count(), 0, 'document title/provenance belongs only in the label bar')
      assert.doesNotMatch(await selected(p).locator('.ws-content').innerText(), /sent \d|receipts|claude-opus|umber-workstation|tone\.mp3|response\.pdf|archive\.zip/)
      await capture(state)
    }
    await choose(p, 'remote-summary.pdf')
    assert.match(await selected(p).locator('.ws-provenance').innerText(), /basalt-login-02/, 'foreign document owner remains in label')
    assert.doesNotMatch(await selected(p).locator('.ws-provenance').innerText(), /claude-opus/)
    await p.getByRole('button', { name: 'Return to Desk', exact: true }).click()
    if (device === 'phone') {
      await p.locator('.kbn-folio-seg[data-folio="1"]').click()
      await poll(p, () => document.querySelector('.kbn-folio-seg[data-folio="1"]')?.getAttribute('aria-selected') === 'true')
    }
    await p.locator('.kbn-desk .kbn-card').filter({ hasText: 'Remote covariance review' }).click()
    await choose(p, 'Constitution')
    const pill = selected(p).locator('.ws-dock .ws-worker-pill')
    assert.match((await pill.textContent()).trim(), /^aloft\s*12 m$/i, 'the act zone pill names state and elapsed time, not agent')
    assert.equal(await selected(p).locator('.kbn-card-worker').count(), 1, 'one worker control on the fiber page')
    const cadence = selected(p).locator('.kbn-detail-controls-toggle .kbn-ctl-cadence')
    assert.equal(await cadence.count(), 1)
    assert.ok((await cadence.innerText()).trim(), 'standing cadence lives in the settings line')
    const outsideSettings = await selected(p).evaluate(page => {
      const copy = page.cloneNode(true)
      copy.querySelector('.kbn-detail-controls')?.remove()
      return copy.textContent
    })
    assert.ok(!outsideSettings.includes(await cadence.innerText()), 'cadence is not repeated outside its editable settings')
    await p.getByRole('button', { name: 'Return to Desk', exact: true }).click()
    await p.locator('[data-view="shelf"]').click()
    await p.locator('.ws-overview-folio').first().waitFor()
    await p.screenshot({ path: resolve(shots, `${device}-overview.png`) })

    async function capture(state) {
      await mkdir(shots, { recursive: true })
      const facts = await p.evaluate(() => {
        const page = document.querySelector('.ws-page.ws-selected')
        const texts = selector => [...document.querySelectorAll(selector)].map(e => e.textContent.trim())
        return {
          header: texts('.ws-selected .ws-prose-header'),
          band: texts('.ws-selected .ws-dock .ws-worker-pill'),
          settings: texts('.ws-selected .kbn-detail-controls-toggle'),
          navbar: texts('.ws-nav-verdicts'),
          title: texts('.ws-selected .ws-label-title'),
          provenance: texts('.ws-selected .ws-provenance'),
          inPageTitles: page.querySelectorAll('.ws-content h1,.ws-content h3,.ws-content .kbn-media-title').length,
          inPageProvenance: page.querySelectorAll('.ws-content .kbn-media-provenance').length,
        }
      })
      const screenshot = resolve(shots, `${device}-${state}.png`)
      await p.screenshot({ path: screenshot })
      inventory.push({ device, state, ...facts, screenshot })
      console.log(`INVENTORY ${JSON.stringify(inventory.at(-1))}`)
    }
  }, viewport)
}

test('Theme font families are private and unicode-range faces cannot target the composer', async p => {
  await open(p); await choose(p, 'Constitution')
  const requests = []
  await p.route('https://theme-probe.invalid/**', route => { requests.push(route.request().url()); return route.abort() })
  const result = await p.evaluate(() => {
    const reader = document.querySelector('.ws-reader')
    const scope = reader.dataset.wsTheme
    const css = `@font-face { font-family: "EB Garamond"; src: url(https://theme-probe.invalid/character-a.woff2); unicode-range: U+61; }
      @font-face { font-family: "Fixture Multi Word"; src: local("Georgia"); }
      :scope { --fixture-font: Fixture Multi Word; }
      [data-part="prose"] { font-family: var(--fixture-font, "EB Garamond") !important; }
      [data-part="prose"] p { font: italic 18px "Fixture Multi Word", serif !important; }
      [data-part="act"] textarea { font-family: "EB Garamond"; }`
    const source = window.__harness.scopeTheme(css, `[data-ws-theme="${scope}"]`, 'font-probe')
    const before = new Set(document.fonts)
    const style = document.createElement('style'); style.textContent = source; document.head.append(style)
    const composer = reader.querySelector('textarea'); composer.value = 'aaaa'; composer.focus()
    return { source, font: getComputedStyle(composer).fontFamily,
      proseFont: getComputedStyle(reader.querySelector('[data-part="prose"]')).fontFamily,
      paragraphFont: getComputedStyle(reader.querySelector('[data-part="prose"] p')).fontFamily,
      faces: [...document.fonts].filter(face => !before.has(face)).map(face => face.family) }
  })
  await p.waitForTimeout(200)
  assert.ok(result.source.includes('font-probe-EB Garamond'))
  assert.ok(result.source.includes('font-probe-Fixture Multi Word'))
  assert.ok(result.proseFont.includes('font-probe-Fixture Multi Word'), 'custom-property font references are renamed')
  assert.ok(result.paragraphFont.includes('font-probe-Fixture Multi Word'), 'font shorthand references are renamed')
  assert.ok(!result.font.includes('font-probe'), 'the act-zone composer keeps its own font')
  assert.ok(!result.faces.includes('EB Garamond'), 'a theme cannot install an unnamespaced font-face')
  assert.deepEqual(requests, [], 'unicode-range faces and theme URLs cannot fetch arbitrary servers')
})

test('Theme URLs allow only data, Google Fonts and relative resources inside the fiber folder', async p => {
  const result = await p.evaluate(() => {
    const css = `@font-face { font-family: Test; src: url("./fonts/test.woff2"); }
      :scope { --good: url("nested/../paper.png"); --bad: url("../secret.png");
        --encoded: url("%2e%2e/secret.png"); --slash: url("nested%2f..%2fsecret.png");
        --external: url("https://theme-probe.invalid/beacon"); --same: url("https://board.test/api/v1/version");
        --absolute: url("/api/v1/version"); --protocol: url("//theme-probe.invalid/beacon");
        --escaped: u\\72l("https://theme-probe.invalid/escape");
        --data: url("data:image/svg+xml;base64,PHN2Zy8+");
        --google: url("https://fonts.gstatic.com/s/font.woff2");
        --disguised: url("https://fonts.gstatic.com.evil.test/font.woff2");
        --image-set: image-set("https://theme-probe.invalid/image.png" 1x);
      }`
    return window.__harness.scopeTheme(css, '[data-ws-theme="url-probe"]', 'url-probe', new Map(), 'https://board.test/api/v1/file-assets/owner/fiber/theme.css')
  })
  for (const allowed of ['data:image', 'fonts.gstatic.com/s/font.woff2', '/file-assets/owner/fiber/fonts/test.woff2', '/file-assets/owner/fiber/paper.png']) assert.ok(result.includes(allowed), allowed)
  for (const forbidden of ['theme-probe.invalid', 'secret.png', '/api/v1/version', 'evil.test']) assert.ok(!result.includes(forbidden), forbidden)
})

test('Escaped theme imports cannot load unscoped CSS or target the composer', async p => {
  await open(p); await choose(p, 'Constitution')
  const composer = p.locator('.ws-selected [data-part="act"] textarea')
  await composer.waitFor()
  const before = await composer.evaluate(element => getComputedStyle(element).color)
  const requests = []
  await p.route('https://fonts.googleapis.com.evil.test/**', route => {
    requests.push(route.request().url())
    return route.fulfill({ contentType: 'text/css', body: 'textarea { color: rgb(123, 45, 67) !important; }' })
  })
  const compiled = await p.evaluate(() => {
    const css = String.raw`@import "https://fonts.googleapis.com\2e evil.test/probe.css"; :scope { --probe: 1; }`
    const output = window.__harness.scopeTheme(css, '[data-ws-theme="import-probe"]', 'import-probe')
    const style = document.createElement('style'); style.textContent = output; document.head.append(style)
    return output
  })
  await p.waitForTimeout(250)
  assert.deepEqual(requests, [], 'CSS-decoded import host must pass the resource policy')
  assert.ok(!compiled.includes('evil.test'))
  assert.equal(await composer.evaluate(element => getComputedStyle(element).color), before)
  const safe = await p.evaluate(() => window.__harness.scopeTheme(String.raw`@import "https://fonts.googleapis.com/css2?family=Roboto" screen; :scope { color: red; }`, ':scope', 'safe-import'))
  assert.ok(safe.includes('@import url("https://fonts.googleapis.com/css2?family=Roboto") screen;'), 'permitted imports use a canonical URL')
})

test('Custom theme is scoped with private keyframes, hoisted fonts and conditional rules', async p => {
  const desk = await p.locator('.kbn-card').first().evaluate(el => getComputedStyle(el).opacity)
  await p.locator('[data-view="shelf"]').click()
  await p.locator('.ws-overview-folio[data-uid="01KVBR1F9BWBVKF97473PV67K8"]').click()
  await choose(p, 'Constitution')
  await poll(p, () => getComputedStyle(document.querySelector('.ws-reader')).getPropertyValue('--ws-custom-ready').trim() === '1')
  const theme = await p.locator('.ws-reader').getAttribute('data-ws-theme')
  const source = await p.locator(`style[data-ws-theme-sheet="${theme}"]`).textContent()
  assert.ok(source.includes(`@keyframes ${theme}-ink-flourish`))
  assert.ok(source.includes(`animation-name: ${theme}-ink-flourish`))
  assert.ok(source.includes(`--fixture-animation: ${theme}-ink-flourish`))
  assert.ok(source.includes(`var(--fixture-animation, ${theme}-ink-flourish`))
  assert.ok(source.includes(`@keyframes ${theme}-1ink`))
  assert.ok(source.includes(`var(--fixture-space-animation, ${theme}-1ink`))
  await p.emulateMedia({ reducedMotion: 'no-preference' })
  assert.equal(await selected(p).locator('[data-part="fiber-title"]').evaluate(el => getComputedStyle(el, '::after').animationName), `${theme}-ink-flourish`)
  assert.equal(await selected(p).locator('.ws-prose h2').first().evaluate(el => getComputedStyle(el).animationName), `${theme}-foo\\ bar`, 'escaped and quoted names share CSSOM identity')
  await p.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(await selected(p).locator('[data-part="fiber-title"]').evaluate(el => getComputedStyle(el, '::after').animationName), 'none')
  assert.ok(source.includes('@font-face') && source.includes('Shuttle Fixture Flourish'))
  assert.ok(source.includes('@media') && source.includes('@supports') && source.includes('@layer'))
  assert.equal(await selected(p).locator('[data-part="prose"]').evaluate(el => getComputedStyle(el).getPropertyValue('--ws-after-nested').trim()), '1', 'declarations following a nested selector survive CSSOM scoping')
  assert.ok(!source.includes('example.invalid'), 'non-Google imports are removed before insertion')
  const fontImport = '@import url(https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;600&display=swap);'
  const allowed = await p.evaluate(css => window.__harness.scopeTheme(`${css} h1 { color: red }`, '[data-ws-theme="font-check"]', 'font-check'), fontImport)
  assert.ok(allowed.startsWith('@import url("https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;600&display=swap");'), 'Google Fonts import survives URL semicolons in canonical form')
  assert.ok(allowed.includes('@scope'), 'rules after an import remain scoped')
  assert.equal(await p.locator('.kbn-card').first().evaluate(el => getComputedStyle(el).opacity), desk, 'Desk is outside the theme scope')
  const other = p.locator('.ws-overview-folio[data-uid="01KVBR2G7CXDWMG85592QW78M9"]')
  assert.equal(await other.evaluate(el => getComputedStyle(el).getPropertyValue('--ws-custom-ready').trim()), '', 'another channel does not inherit the custom theme')
  await p.getByRole('button', { name: 'Return to Board', exact: true }).click()
  await other.click()
  assert.equal(await p.locator('.ws-reader').evaluate(el => getComputedStyle(el).getPropertyValue('--ws-custom-ready').trim()), '')
})

test('Plain removes custom and bundled styling, persists, and can restore custom CSS', async p => {
  await p.locator('[data-view="shelf"]').click()
  await p.locator('.ws-overview-folio[data-uid="01KVBR1F9BWBVKF97473PV67K8"]').click()
  await choose(p, 'Constitution')
  await poll(p, () => getComputedStyle(document.querySelector('.ws-reader')).getPropertyValue('--ws-custom-ready').trim() === '1')
  const plain = await openPlainThemeMenu(p)
  await plain.click()
  assert.equal(await plain.getAttribute('aria-pressed'), 'true')
  assert.equal(await plain.evaluate(el => getComputedStyle(el, '::before').content), '"✓"')
  assert.equal(await p.locator('.ws-reader').getAttribute('data-ws-theme'), null)
  assert.equal(await p.locator('.ws-overview-folio[data-uid="01KVBR1F9BWBVKF97473PV67K8"]').getAttribute('data-ws-theme'), null)
  await p.reload()
  await p.locator('.ws-channel-title').waitFor()
  assert.equal(await p.locator('.ws-reader').getAttribute('data-ws-theme'), null)
  const plainAfterReload = await openPlainThemeMenu(p)
  await plainAfterReload.click()
  await poll(p, () => getComputedStyle(document.querySelector('.ws-reader')).getPropertyValue('--ws-custom-ready').trim() === '1')
  await p.setViewportSize({ width: 390, height: 844 })
  const phonePlain = await openPlainThemeMenu(p)
  assert.ok((await phonePlain.boundingBox()).height >= 44, 'Plain has a phone-sized touch target')
})

test('Broken theme falls back to its bundled base', async p => {
  await p.locator('.kbn-card').filter({ hasText: 'Mask validation notes' }).click()
  await choose(p, 'Constitution')
  await poll(p, () => document.querySelector('.ws-reader')?.dataset.wsThemeName === 'laboratory-paper')
  const theme = await p.locator('.ws-reader').getAttribute('data-ws-theme')
  const source = await p.locator(`style[data-ws-theme-sheet="${theme}"]`).textContent()
  assert.ok(source.length > 100, 'the bundled base remains present')
  assert.ok(!source.includes('broken css'))
  assert.ok(await selected(p).locator('.ws-prose').isVisible())
})

test('Act zone stops broad button rules and resets theme fonts, sizes and pigments', async p => {
  await open(p); await choose(p, 'Constitution')
  await poll(p, () => getComputedStyle(document.querySelector('.ws-reader')).getPropertyValue('--ws-custom-ready').trim() === '1')
  assert.equal(await selected(p).locator('.ws-prose-contents button').first().evaluate(el => getComputedStyle(el).color), 'rgb(255, 0, 0)', 'the broad rule is active in the reading zone')
  const temper = selected(p).getByRole('button', { name: 'Temper', exact: true })
  const style = await temper.evaluate(el => ({ color: getComputedStyle(el).color, font: getComputedStyle(el).fontFamily, height: getComputedStyle(el).getPropertyValue('--ws-control-height').trim(), agent: getComputedStyle(el).getPropertyValue('--ws-agent').trim(), transform: getComputedStyle(el).textTransform, pigment: getComputedStyle(el).getPropertyValue('--kbn-agent').trim(), mono: getComputedStyle(el).getPropertyValue('--font-mono').trim() }))
  assert.notEqual(style.color, 'rgb(255, 0, 0)', 'button { color: red } cannot reach Temper')
  assert.ok(!style.font.includes('fantasy'))
  assert.equal(style.height, '32px')
  assert.notEqual(style.agent, 'red')
  assert.equal(style.transform, 'none', 'inherited theme typography also stops at the act zone')
  assert.notEqual(style.pigment, 'red', 'theme aliases cannot change a control pigment')
  assert.ok(!style.mono.includes('fantasy'), 'theme aliases cannot change a control font')
  assert.equal(await selected(p).locator('.ws-dock').getAttribute('data-part'), 'act')
  assert.equal(await selected(p).locator('.ws-dock .ws-worker-pill').getAttribute('data-part'), 'act')
  assert.equal(await p.locator('.ws-nav-verdicts').getAttribute('data-part'), 'act')
}, { width: 1379, height: 900 })

test('Night Chart text and protected control pigments meet AA on dark paper', async p => {
  await p.locator('.kbn-card').filter({ hasText: 'Remote covariance review' }).click()
  await choose(p, 'Constitution')
  await poll(p, () => document.querySelector('.ws-reader')?.dataset.wsThemeName === 'night-chart')
  const contrasts = await selected(p).evaluate(page => {
    const band = page.querySelector('.ws-dock')
    const error = document.createElement('span')
    error.className = 'kbn-detail-error'; error.textContent = 'Fixture error'
    band.append(error)
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')
    const rgb = color => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3) }
    const luminance = color => rgb(color).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0)
    const paper = luminance(getComputedStyle(band).getPropertyValue('--ws-paper'))
    const result = [...page.querySelectorAll('.ws-prose h1,.ws-prose-body p,.ws-prose-status,.ws-labelbar,.kbn-ctl-agent,.kbn-card-worker,.kbn-detail-error')].map(el => {
      const ink = luminance(getComputedStyle(el).color)
      return { part: el.className || el.tagName, ratio: (Math.max(ink, paper) + .05) / (Math.min(ink, paper) + .05) }
    })
    error.remove()
    return result
  })
  for (const { part, ratio } of contrasts) assert.ok(ratio >= 4.5, `${part}: ${ratio.toFixed(2)}:1`)
  console.log(`CONTRAST Night Chart ${Math.min(...contrasts.map(c => c.ratio)).toFixed(2)}:1 minimum across ${contrasts.length} text samples`)
})

test('Overview and sidebar never fan out theme.css probes; folios reuse the reader ETag cache', async p => {
  const themeReads = async () => (await records(p)).filter(r => r.url.includes('/api/v1/file?') && decodeURIComponent(r.url).includes('/theme.css'))
  await p.locator('[data-view="shelf"]').click()
  await p.locator('.ws-overview-folio').first().waitFor()
  await p.waitForTimeout(100)
  assert.equal((await themeReads()).length, 0, 'cold overview uses bundled themes only')
  await p.locator('.ws-overview-folio').filter({ hasText: name }).click()
  await poll(p, () => getComputedStyle(document.querySelector('.ws-reader')).getPropertyValue('--ws-custom-ready').trim() === '1')
  assert.equal((await themeReads()).length, 1, 'only the open reader loads custom CSS')
  await p.clock.fastForward(16000)
  await poll(p, () => window.__harness.requests.some(r => decodeURIComponent(r.url).includes('calibration-report/theme.css') && r.headers?.['if-none-match']))
  const count = (await themeReads()).length
  await p.locator('.ws-return').click()
  await p.locator('.ws-overview-folio').first().waitFor()
  await p.clock.fastForward(16000)
  assert.equal((await themeReads()).length, count, 'overview does not revalidate any custom theme')
  assert.equal(await p.locator('.ws-overview-folio').filter({ hasText: name }).evaluate(el => getComputedStyle(el).getPropertyValue('--ws-custom-ready').trim()), '1', 'reader-loaded theme survives on the folio')
})

test('Theme refresh uses ETag on the ordinary cadence, not on selection frames', async p => {
  await open(p); await choose(p, 'Constitution')
  await poll(p, () => getComputedStyle(document.querySelector('.ws-reader')).getPropertyValue('--ws-custom-ready').trim() === '1')
  const reads = async () => (await records(p)).filter(r => r.url.includes('/api/v1/file?') && decodeURIComponent(r.url).includes('calibration-report/theme.css'))
  const count = (await reads()).length
  await choose(p, 'brief.md'); await choose(p, 'Constitution')
  assert.equal((await reads()).length, count)
  await p.clock.fastForward(16000)
  await poll(p, () => window.__harness.requests.some(r => decodeURIComponent(r.url).includes('calibration-report/theme.css') && r.headers?.['if-none-match']))
  assert.ok((await reads()).at(-1).headers['if-none-match'])
})

test('Nested sidebar cards reset foreign variables, including cards in Plain', async p => {
  await open(p); await choose(p, 'Constitution')
  await poll(p, () => getComputedStyle(document.querySelector('.ws-reader')).getPropertyValue('--ws-custom-ready').trim() === '1')
  const foreign = p.locator('[data-part="sidebar-card"]').filter({ hasText: 'Mask validation notes' })
  await foreign.waitFor()
  assert.equal(await foreign.getAttribute('data-ws-theme-name'), 'laboratory-paper')
  const own = p.locator('[data-part="sidebar-card"]').filter({ hasText: name })
  assert.equal(await own.getAttribute('data-ws-theme'), await p.locator('.ws-reader').getAttribute('data-ws-theme'))
  const assertNeutral = async () => {
    const values = await foreign.evaluate(el => {
      const s = getComputedStyle(el)
      return { ready: s.getPropertyValue('--ws-custom-ready').trim(), after: s.getPropertyValue('--ws-after-nested').trim(), mono: s.getPropertyValue('--font-mono').trim(), transform: s.textTransform, height: s.getPropertyValue('--ws-control-height').trim() }
    })
    assert.equal(values.ready, '', 'unknown custom variables stop at the nested boundary')
    assert.equal(values.after, '')
    assert.ok(!values.mono.includes('fantasy'))
    assert.equal(values.transform, 'none')
    assert.equal(values.height, '32px')
  }
  await assertNeutral()
  await foreign.click(); await choose(p, 'Constitution')
  const plain = await openPlainThemeMenu(p)
  await plain.click()
  assert.equal(await foreign.getAttribute('data-ws-theme'), null)
  assert.ok(await foreign.getAttribute('data-ws-theme-boundary') !== null)
  await p.locator('.ws-sidebar').getByRole('button', { name: new RegExp(name) }).click()
  await choose(p, 'Constitution')
  await poll(p, () => getComputedStyle(document.querySelector('.ws-reader')).getPropertyValue('--ws-custom-ready').trim() === '1')
  await assertNeutral()
}, { width: 1379, height: 900 }, 'true')

test('Protected verdict plate and portaled toast retain material without author CSS', async p => {
  await open(p)
  await poll(p, () => getComputedStyle(document.querySelector('.ws-reader')).getPropertyValue('--ws-custom-ready').trim() === '1')
  const plate = p.locator('.ws-nav-verdicts .ws-review-plate')
  assert.equal(await plate.getAttribute('data-part'), 'act')
  assert.equal(await plate.getAttribute('data-act'), 'verdict')
  assert.notEqual(await plate.getByRole('button', { name: 'Temper', exact: true }).evaluate(el => getComputedStyle(el).color), 'rgb(255, 0, 0)')
  const material = await p.locator('.ws-reader').evaluate(el => ({ paper: getComputedStyle(el).getPropertyValue('--ws-paper').trim(), ink: getComputedStyle(el).getPropertyValue('--ws-ink').trim() }))
  await p.locator('.ws-channel-title').focus(); await p.keyboard.press('t')
  const toast = p.locator('.ws-verdict-toast')
  await toast.waitFor()
  assert.equal(await toast.getAttribute('data-part'), 'act')
  assert.equal(await toast.getAttribute('data-act'), 'toast')
  assert.equal(await toast.getAttribute('data-ws-theme'), null)
  await p.getByRole('button', { name: 'Return to Desk', exact: true }).click()
  assert.deepEqual(await toast.evaluate(el => ({ paper: getComputedStyle(el).getPropertyValue('--ws-paper').trim(), ink: getComputedStyle(el).getPropertyValue('--ws-ink').trim() })), material)
  assert.ok(!await toast.getByRole('button').evaluate(el => getComputedStyle(el).fontFamily.includes('fantasy')))
  await p.keyboard.press('z')
}, { width: 1379, height: 900 })

test('Theme changes repaint paused audio without replacing the player or fetching bytes', async p => {
  await open(p); await choose(p, 'tone.mp3')
  const wave = selected(p).locator('[data-part="audio-waveform"]')
  await poll(p, () => document.querySelector('.ws-selected .ws-audio-page')?.dataset.waveform === 'decoded')
  await p.evaluate(() => { window.__themedAudio = document.querySelector('.ws-selected audio') })
  const pixel = async () => wave.evaluate(canvas => {
    const probe = document.createElement('canvas'); probe.width = probe.height = 1
    const ctx = probe.getContext('2d'); ctx.fillStyle = getComputedStyle(canvas).color; ctx.fillRect(0, 0, 1, 1)
    return { ink: [...ctx.getImageData(0, 0, 1, 1).data], drawn: [...canvas.getContext('2d').getImageData(0, Math.floor(canvas.height / 2), 1, 1).data] }
  })
  const before = await pixel(); assert.deepEqual(before.drawn, before.ink)
  const reads = (await records(p)).filter(r => decodeURIComponent(r.url).includes('tone.mp3')).length
  const plain = await openPlainThemeMenu(p); await plain.click()
  await p.clock.runFor(80)
  const after = await pixel(); assert.deepEqual(after.drawn, after.ink); assert.notDeepEqual(after.ink, before.ink)
  assert.ok(await p.evaluate(() => document.querySelector('.ws-selected audio') === window.__themedAudio && window.__themedAudio.paused && window.__themedAudio.currentTime === 0))
  assert.equal((await records(p)).filter(r => decodeURIComponent(r.url).includes('tone.mp3')).length, reads)
})

for (const theme of ['portolan', 'blueprint', 'laboratory-paper', 'night-chart']) {
  test(`Theme phone paper stays edge to edge with styled bars and page sheet: ${theme}`, async p => {
    const themed = new URL(url); themed.searchParams.set('theme-preview', `01KVBR1F9BWBVKF97473PV67K8:${theme}`)
    await p.goto(themed.href); await open(p); await choose(p, 'Constitution')
    const frame = selected(p).locator('[data-part="page-frame"]')
    const box = await frame.boundingBox()
    assert.ok(Math.abs(box.x) < 1 && Math.abs(box.width - 390) < 1)
    assert.deepEqual(await frame.evaluate(el => { const s = getComputedStyle(el); return [s.borderRadius, s.clipPath, s.boxShadow, s.borderTopWidth] }), ['0px', 'none', 'none', '0px'])
    assert.ok(await p.locator('[data-part="phone-topbar"]').isVisible())
    assert.ok(await p.locator('[data-part="phone-bottom-bar"]').isVisible())
    await p.locator('.ws-page-choice').click()
    assert.ok(await p.locator('[data-part="page-sheet-panel"]').isVisible())
    assert.ok(await p.locator('[data-part="page-sheet-row"]').count() > 1)
    assert.equal(await p.locator('[data-part="page-sheet-panel"]').evaluate(el => getComputedStyle(el).getPropertyValue('--ws-paper').trim()), await p.locator('.ws-reader').evaluate(el => getComputedStyle(el).getPropertyValue('--ws-paper').trim()))
  }, { width: 390, height: 844 })
}

const runnable = tests.filter(test => !process.env.E2E_ONLY || new RegExp(process.env.E2E_ONLY).test(test.name))
const started = performance.now()
let passed = 0
try {
  for (const { name, run, viewport, sidebarChoice, reducedMotion, touch } of runnable) {
    const context = await browser.newContext({ viewport: viewport ?? { width: 1440, height: 900 },
      hasTouch: !!touch || (!!viewport && viewport.width <= 700), isMobile: !!touch || (!!viewport && viewport.width <= 700),
      reducedMotion, locale: 'en-GB', timezoneId: 'Europe/Paris' })
    const page = await context.newPage()
    page.setDefaultTimeout(2000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    let failure
    try {
      await page.clock.install({ time: new Date('2026-10-04T14:00:00Z') })
      if (sidebarChoice !== null) await page.addInitScript(choice => {
        if (window === window.top) localStorage.setItem('shuttle:workspace:sidebar', choice)
      }, sidebarChoice)
      await page.goto(url)
      await page.locator('.kbn-card').filter({ hasText: 'Calibrate the shear response' }).waitFor()
      await run(page)
    } catch (error) { failure = error }
    finally {
      try { assert.deepEqual(errors, [], 'pageerror events') } catch (error) { failure = failure ? new AggregateError([failure, error]) : error }
      await context.close()
    }
    if (failure) console.error(`FAIL ${name}\n${failure.stack}\n${failure.errors?.map(error => error.stack).join('\n') ?? ''}`)
    else { passed++; console.log(`PASS ${name}`) }
  }
} finally { await browser.close() }
await mkdir(shots, { recursive: true })
await writeFile(resolve(shots, 'inventory.json'), JSON.stringify(inventory, null, 2))
console.log(`${passed} passed, ${runnable.length - passed} failed; ${((performance.now() - started) / 1000).toFixed(1)}s`)
if (passed !== runnable.length) process.exitCode = 1
