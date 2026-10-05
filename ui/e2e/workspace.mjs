import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
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
const test = (name, run, viewport) => tests.push({ name, run, viewport })
const selected = p => p.locator('.ws-page.ws-selected')
const tab = (p, label) => p.getByRole('tab', { name: label, exact: true })
async function open(p, expected = 'calibration-report') {
  await p.locator('.kbn-card').filter({ hasText: name }).click()
  await tab(p, 'calibration-report').waitFor()
  await p.waitForFunction(label => document.querySelector('.ws-tab[aria-selected="true"]')?.textContent === label, expected)
}
async function choose(p, label) {
  await tab(p, label).click()
  await p.waitForFunction(label => document.querySelector('.ws-tab[aria-selected="true"]')?.textContent === label, label)
}
async function poll(p, fn, arg) { await p.waitForFunction(fn, arg, { timeout: 2500, polling: 40 }) }
const report = p => p.locator('.ws-page').filter({ has: p.locator('.ws-label-title', { hasText: 'calibration-report' }) }).locator('iframe')
async function reportReady(p) {
  await poll(p, () => [...document.querySelectorAll('.ws-page iframe')].some(f => f.contentDocument?.querySelector('#report-sentinel')))
  return report(p)
}
async function records(p) { return p.evaluate(() => window.__harness.requests) }

test('Desk keyboard starts in awaiting review and Enter opens report first', async p => {
  await p.keyboard.press('j')
  assert.match(await p.locator('.kbn-card.kbn-key-selected').innerText(), /Calibrate the shear response/)
  await p.keyboard.press('Enter')
  await reportReady(p)
  assert.equal(await tab(p, 'calibration-report').getAttribute('aria-selected'), 'true')
  assert.ok(await p.evaluate(() => document.activeElement?.tagName !== 'IFRAME' && !document.activeElement?.closest('.ws-content')), 'keyboard entry must keep app-level focus')
})

test('Pointer, stepping, HTML scrolling, persistent iframe, expansion and resize', async p => {
  await open(p)
  const iframe = await reportReady(p)
  await iframe.evaluate(f => { window.__reportWindow = f.contentWindow; f.contentWindow.__sentinel = 'kept'; window.__reportIdentity = f.contentDocument.querySelector('#report-identity').textContent })
  for (const [forward, backward] of [['l', 'h'], ['ArrowRight', 'ArrowLeft']]) {
    await p.keyboard.press(forward)
    assert.equal(await tab(p, 'calibration-report').getAttribute('aria-selected'), 'false')
    await p.keyboard.press(backward)
    assert.equal(await tab(p, 'calibration-report').getAttribute('aria-selected'), 'true')
  }
  await choose(p, 'brief.md')
  await choose(p, 'calibration-report')
  for (const [down, up] of [['ArrowDown', 'ArrowUp']]) {
    await iframe.evaluate(f => f.contentWindow.scrollTo(0, 0))
    await p.keyboard.press(down)
    await poll(p, () => window.__reportWindow.scrollY > 0)
    const before = await iframe.evaluate(f => f.contentWindow.scrollY)
    await p.keyboard.press(up)
    await poll(p, before => window.__reportWindow.scrollY < before, before)
  }
  await tab(p, 'calibration-report').dblclick()
  assert.ok(await p.locator('.ws-page.ws-expanded').count())
  await p.locator('.ws-page.ws-expanded .ws-labelbar').dblclick()
  assert.equal(await p.locator('.ws-page.ws-expanded').count(), 0)
  const edge = p.locator('.ws-page').filter({ has: p.locator('.ws-label-title', { hasText: 'calibration-report' }) }).locator('.ws-edge-right')
  const box = await edge.boundingBox()
  const width = await iframe.evaluate(f => f.closest('.ws-page').getBoundingClientRect().width)
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await p.mouse.down(); await p.mouse.move(box.x - 120, box.y + box.height / 2); await p.mouse.up()
  assert.notEqual(await iframe.evaluate(f => f.closest('.ws-page').getBoundingClientRect().width), width)
  await p.setViewportSize({ width: 1250, height: 760 })
  assert.ok(await iframe.evaluate(f => f.contentWindow === window.__reportWindow && f.contentWindow.__sentinel === 'kept'), 'browser resize must retain the iframe')
  await p.getByRole('button', { name: 'Return to Desk', exact: true }).click()
  await open(p)
  assert.ok(await iframe.evaluate(f => f.contentWindow === window.__reportWindow && f.contentWindow.__sentinel === 'kept' && f.contentDocument.querySelector('#report-identity').textContent === window.__reportIdentity))
})

test('j/k step constitutions in the switcher order', async p => {
  await open(p)
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

test('Fiber composer isolates keys; settings and history use mocked daemon', async p => {
  await open(p); await choose(p, 'Constitution')
  const input = p.getByRole('textbox', { name: 'Message for the next worker' })
  await input.fill('hjkl'); await input.press('ArrowLeft'); await input.press('ArrowRight'); await input.press('ArrowUp'); await input.press('ArrowDown')
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

test('Body embed appears once in channel and its channel link opens report', async p => {
  await open(p); await choose(p, 'Constitution')
  assert.equal(await selected(p).locator('.ws-prose-documents button').filter({ hasText: /^calibration-report$/ }).count(), 1)
  await selected(p).locator('.ws-prose-documents button').filter({ hasText: /^calibration-report$/ }).click()
  await poll(p, () => document.querySelector('.ws-tab[aria-selected="true"]')?.textContent === 'calibration-report')
  assert.equal(await tab(p, 'calibration-report').getAttribute('aria-selected'), 'true')
})

test('Body file link opens a linked document', async p => {
  await open(p); await choose(p, 'Constitution')
  await selected(p).getByRole('link', { name: 'mask table' }).click()
  await poll(p, () => document.querySelector('.ws-tab[aria-selected="true"]')?.textContent === 'mask.csv')
  assert.equal(await tab(p, 'mask.csv').getAttribute('aria-selected'), 'true')
})

test('Body wikilink opens a fiber absent from the card index', async p => {
  await open(p); await choose(p, 'Constitution')
  await selected(p).locator('.kbn-wikilink-live[data-fiber="research/workspace/method-note"]').click()
  await p.getByText('The response correction uses independent simulations and leaves the measured shear unchanged in the null tests.', { exact: true }).waitFor()
})

test('Overview lenses, Find, exact receipt ribbon route and scroll restoration', async p => {
  await p.locator('[data-view="shelf"]').click()
  for (const lens of ['Recent work', 'Projects', 'Hosts']) {
    const radio = p.getByRole('radio', { name: lens, exact: true }); await radio.click()
    assert.equal(await radio.getAttribute('aria-checked'), 'true')
  }
  const find = p.getByRole('searchbox', { name: 'Find work or files' })
  await find.fill('Calibrate')
  assert.equal(await p.locator('.ws-overview-folio:visible').count(), 1)
  await find.fill('')
  await p.locator('.ws-overview').evaluate(e => { e.scrollTop = 120; window.__overviewScroll = e.scrollTop })
  assert.ok(await p.evaluate(() => window.__overviewScroll > 0), 'overview must actually scroll')
  await p.locator('.ws-overview-ribbon button').filter({ hasText: 'brief.md' }).click()
  assert.equal(await tab(p, 'brief.md').getAttribute('aria-selected'), 'true')
  await p.getByRole('button', { name: 'Return to Board', exact: true }).click()
  assert.ok(await p.locator('.ws-overview').evaluate(e => e.scrollTop === window.__overviewScroll))
}, { width: 1440, height: 600 })

test('Overview media thumbnails show duration and a paused first video frame', async p => {
  await p.locator('[data-view="shelf"]').click()
  const audioCard = p.locator('.ws-overview-ribbon button').filter({ hasText: 'tone.mp3' })
  await audioCard.scrollIntoViewIfNeeded()
  await poll(p, () => [...document.querySelectorAll('.kbn-thumbnail-audio')].some(t => /\d+:\d\d/.test(t.textContent)))
  assert.match(await audioCard.innerText(), /\d+:\d\d/)
  const videoCard = p.locator('.ws-overview-ribbon button').filter({ hasText: 'test.mp4' })
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

for (const format of ['mp3', 'wav']) test(`Audio ${format} plays, progresses, pauses away and parking without auto-resume`, async p => {
  await open(p); await choose(p, `tone.${format}`)
  const audio = p.getByRole('tabpanel', { name: `tone.${format}`, exact: true, includeHidden: true }).locator('audio')
  await audio.waitFor()
  await audio.evaluate(a => { window.__audio = a })
  await p.evaluate(() => document.activeElement?.blur())
  await p.keyboard.press('Space')
  await poll(p, () => window.__audio && !window.__audio.paused && window.__audio.currentTime > 0)
  await p.keyboard.press('Space')
  assert.ok(await audio.evaluate(a => a.paused), 'Space must toggle native playback')
  await p.keyboard.press('Space')
  await poll(p, () => !window.__audio.paused)
  assert.equal(await p.locator('audio').evaluateAll(as => as.filter(a => !a.paused).length), 1)
  await poll(p, () => [...document.querySelectorAll('.kbn-media-progress')].some(e => e.value > 0))
  const other = `tone.${format === 'mp3' ? 'wav' : 'mp3'}`
  await choose(p, other); assert.ok(await audio.evaluate(a => a.paused))
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

for (const format of ['mp4', 'webm']) test(`Video ${format} plays and seeks native fixture`, async p => {
  await open(p); await choose(p, `test.${format}`)
  const video = selected(p).locator('video')
  await video.evaluate(async v => { await v.play() })
  await poll(p, () => [...document.querySelectorAll('video')].some(v => v.currentTime > 0 && v.videoWidth > 0))
  await video.evaluate(v => { v.pause(); v.currentTime = 0.5 })
  await poll(p, () => [...document.querySelectorAll('video')].some(v => !v.seeking && Math.abs(v.currentTime - 0.5) < 0.1))
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
  await poll(p, () => [...document.querySelectorAll('.ws-overview iframe')].some(f => f.src.includes('#page=1')))
})

test('Remote worker pill records attach handler without launching a terminal', async p => {
  await p.locator('.kbn-card').filter({ hasText: 'Remote covariance review' }).click()
  await p.locator('.ws-worker-pill .kbn-card-worker').click()
  await poll(p, () => window.__harness.events.some(e => e.type === 'open-worker') || window.__harness.handlers.some(h => h.path === '/api/v1/attach'))
  const event = await p.evaluate(() => window.__harness.events.find(e => e.type === 'open-worker'))
  assert.equal(event.host, 'basalt-login-02')
  assert.match(event.session, /remote-review-01KVBR3H8DYFXNH96683RX89N0-shuttle/)
})

test('Phone overview single column, reader tabs, footer stepping and Back', async p => {
  await p.locator('[data-view="shelf"]').click()
  await poll(p, () => document.querySelectorAll('.ws-overview-folio:not([hidden])').length >= 2)
  const folios = await p.locator('.ws-overview-folio:visible').evaluateAll(es => es.map(e => e.getBoundingClientRect().x))
  assert.ok(folios.length > 1 && folios.every(x => Math.abs(x - folios[0]) < 2))
  await p.locator('.ws-overview-folio').filter({ hasText: name }).click()
  await tab(p, 'calibration-report').waitFor()
  assert.ok(await p.locator('.ws-thumbbar').isVisible())
  await p.getByRole('button', { name: 'Next document', exact: true }).click()
  assert.equal(await tab(p, 'calibration-report').getAttribute('aria-selected'), 'false')
  await p.getByRole('button', { name: 'Previous document', exact: true }).click()
  assert.equal(await tab(p, 'calibration-report').getAttribute('aria-selected'), 'true')
  await p.getByRole('button', { name: 'Return to Board', exact: true }).click()
  assert.ok(await p.getByRole('searchbox', { name: 'Find work or files' }).isVisible())
}, { width: 390, height: 844 })

const started = performance.now()
let passed = 0
try {
  for (const { name, run, viewport } of tests) {
    const context = await browser.newContext({ viewport: viewport ?? { width: 1440, height: 900 },
      reducedMotion: 'reduce', locale: 'en-GB', timezoneId: 'Europe/Paris' })
    const page = await context.newPage()
    page.setDefaultTimeout(2000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    let failure
    try {
      await page.clock.install({ time: new Date('2026-10-04T14:00:00Z') })
      await page.goto(url)
      await page.locator('.kbn-card').filter({ hasText: 'Calibrate the shear response' }).waitFor()
      await run(page)
    } catch (error) { failure = error }
    finally {
      try { assert.deepEqual(errors, [], 'pageerror events') } catch (error) { failure = failure ? new AggregateError([failure, error]) : error }
      await context.close()
    }
    if (failure) console.error(`FAIL ${name}\n${failure.stack}`)
    else { passed++; console.log(`PASS ${name}`) }
  }
} finally { await browser.close() }
console.log(`${passed} passed, ${tests.length - passed} failed; ${((performance.now() - started) / 1000).toFixed(1)}s`)
if (passed !== tests.length) process.exitCode = 1
