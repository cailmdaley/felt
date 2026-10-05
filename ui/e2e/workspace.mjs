import assert from 'node:assert/strict'
import { access, mkdir, writeFile } from 'node:fs/promises'
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
const test = (name, run, viewport, sidebarChoice = 'false', reducedMotion = 'reduce') => tests.push({ name, run, viewport, sidebarChoice, reducedMotion })
const selected = p => p.locator('.ws-page.ws-selected')
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
    await p.locator('.ws-page-sheet-row').filter({ has: p.locator('.ws-page-sheet-title', { hasText: displayLabel(label) }) }).click()
    await poll(p, () => !document.querySelector('.ws-page-sheet')?.open)
  } else await tab(p, label).click()
  await p.waitForFunction(label => document.querySelector('.ws-tab[aria-selected="true"]')?.getAttribute('aria-label') === label, displayLabel(label))
}
async function poll(p, fn, arg) { await p.waitForFunction(fn, arg, { timeout: 2500, polling: 40 }) }
const reportPage = p => p.locator('.ws-page[data-key="umber-workstation:/fixture-store/workspace/.felt/research/workspace/calibration-report/report.html"]')
const report = p => reportPage(p).locator('iframe')
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
  await iframe.evaluate(f => {
    const report = f.contentDocument
    const querySelectorAll = report.querySelectorAll.bind(report)
    report.__workspaceBodyWalks = 0
    report.querySelectorAll = selector => {
      if (selector === 'body *') report.__workspaceBodyWalks++
      return querySelectorAll(selector)
    }
  })
  for (const [down, up] of [['ArrowDown', 'ArrowUp']]) {
    await iframe.evaluate(f => f.contentWindow.scrollTo(0, 0))
    await p.keyboard.press(down)
    await poll(p, () => window.__reportWindow.scrollY > 0)
    const before = await iframe.evaluate(f => f.contentWindow.scrollY)
    await p.keyboard.press(up)
    await poll(p, before => window.__reportWindow.scrollY < before, before)
  }
  assert.ok(await iframe.evaluate(f => f.contentDocument.__workspaceBodyWalks) <= 1, 'report scroller is resolved at most once for the frame')
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
  assert.ok(await iframe.evaluate(f => f.contentWindow === window.__reportWindow && f.contentWindow.__sentinel === 'kept'), 'browser resize must retain the iframe')
  await p.getByRole('button', { name: 'Return to Desk', exact: true }).click()
  await open(p)
  assert.ok(await iframe.evaluate(f => f.contentWindow === window.__reportWindow && f.contentWindow.__sentinel === 'kept' && f.contentDocument.querySelector('#report-identity').textContent === window.__reportIdentity))
})

test('Filmstrip previews share a safe budget, condense instantly, and retain selection through a fresh re-send', async p => {
  await open(p); await reportReady(p)
  const film = p.locator('.ws-tabs')
  assert.ok(await film.evaluate(el => el.classList.contains('ws-strip-film')))
  assert.ok((await film.boundingBox()).height <= 104)
  await poll(p, () => document.querySelectorAll('.ws-tab-thumb iframe').length > 0)
  for (const frame of await p.locator('.ws-tab-kind-html iframe').all()) {
    assert.equal(await frame.getAttribute('sandbox'), '')
    assert.equal(await frame.getAttribute('tabindex'), '-1')
  }
  assert.ok(await p.locator('.ws-thumbnail-body').count() <= 16)
  await poll(p, () => document.querySelector('.ws-tab-kind-html.ws-thumbnail-ready'))
  assert.equal(await p.locator('.ws-tab-kind-html .ws-thumbnail-face').evaluate(el => getComputedStyle(el).visibility), 'hidden')
  assert.equal(await p.locator('.ws-tab-kind-html .kbn-thumbnail-glyph').evaluate(el => getComputedStyle(el).display), 'none')
  assert.ok(await tab(p, 'calibration-report').locator('.ws-tab-label').evaluate(el => el.classList.contains('ws-tab-title')))
  assert.match(await tab(p, 'calibration-report').getAttribute('title'), /report\.html$/)
  assert.equal(await p.locator('.ws-tab-fresh').count(), 0, 'first visits are quiet')
  await report(p).evaluate(f => { window.__filmReport = f.contentWindow })
  await p.locator('.ws-selected .ws-expand-button').click()
  assert.ok(!await film.evaluate(el => el.classList.contains('ws-strip-film')))
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
  await p.getByRole('button', { name: 'Return to Desk', exact: true }).click()
  await open(p)
  await poll(p, () => document.querySelector('.ws-tab-fresh')?.getAttribute('aria-label') === 'Field note')
  assert.equal(await tab(p, 'calibration-report').getAttribute('aria-selected'), 'true')
  assert.ok(await report(p).evaluate(f => f.contentWindow === window.__filmReport))
  assert.equal(await film.locator('.ws-tab').nth(1).getAttribute('aria-label'), 'Field note')
  if (process.env.WORKSPACE_SHOTS) {
    await mkdir(process.env.WORKSPACE_SHOTS, { recursive: true })
    await p.screenshot({ path: `${process.env.WORKSPACE_SHOTS}/harness-fresh-desktop.png` })
  }
  await p.setViewportSize({ width: 390, height: 844 })
  await poll(p, () => !document.querySelector('.ws-tabs').classList.contains('ws-strip-film'))
  assert.equal(await film.locator('.ws-tab-thumb:visible').count(), 0)
  if (process.env.WORKSPACE_SHOTS) {
    await p.locator('.ws-page-choice').click()
    await p.screenshot({ path: `${process.env.WORKSPACE_SHOTS}/harness-fresh-phone.png` })
    await p.keyboard.press('Escape')
    await poll(p, () => !document.querySelector('.ws-page-sheet')?.open)
  }
  await choose(p, 'brief.md')
  assert.equal(await p.locator('.ws-tab-fresh').count(), 0)
})

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
  await p.locator('.ws-overview-ribbon button[title*="brief.md"]').click()
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
  assert.doesNotMatch(await audioCard.locator('.ws-overview-thumb').innerText(), /tone\.mp3/, 'ribbon caption owns the filename')
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
  await p.keyboard.press('.')
  assert.ok(await selected(p).locator('audio').evaluate(a => a.currentTime > 0))
  await p.keyboard.press(',')
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
  await poll(p, () => [...document.querySelectorAll('.ws-overview iframe')].some(f => f.src.includes('#page=1')))
})

test('Remote worker pill records attach handler without launching a terminal', async p => {
  await p.locator('.kbn-desk .kbn-card').filter({ hasText: 'Remote covariance review' }).click()
  await p.locator('.ws-worker-pill .kbn-card-worker').click()
  await poll(p, () => window.__harness.events.some(e => e.type === 'open-worker') || window.__harness.handlers.some(h => h.path === '/api/v1/attach'))
  const event = await p.evaluate(() => window.__harness.events.find(e => e.type === 'open-worker'))
  assert.equal(event.host, 'basalt-login-02')
  assert.match(event.session, /remote-review-01KVBR3H8DYFXNH96683RX89N0-shuttle/)
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
  assert.ok(await p.getByRole('searchbox', { name: 'Find work or files' }).isVisible())
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

test('Phone bar-only touch swipe steps, reverses and cancels; document vertical scroll only hides chrome', async p => {
  await open(p); await reportReady(p)
  const original = await selected(p).getAttribute('data-key')
  const bar = await p.locator('.ws-thumbbar').boundingBox()
  const y = bar.y + 22
  await swipe(p, 220, y, 120, y + 4)
  assert.notEqual(await selected(p).getAttribute('data-key'), original)
  await swipe(p, 120, y, 220, y + 4)
  assert.equal(await selected(p).getAttribute('data-key'), original)
  await swipe(p, 220, y, 120, y, true)
  assert.equal(await selected(p).getAttribute('data-key'), original)
  await swipe(p, 5, y, 150, y)
  assert.equal(await selected(p).getAttribute('data-key'), original, 'Safari edge-back starts are not claimed')
  await swipe(p, 180, y, 184, y - 70)
  assert.equal(await selected(p).getAttribute('data-key'), original, 'vertical bar pans are not pages')
  await swipe(p, 190, 650, 194, 200)
  assert.equal(await selected(p).getAttribute('data-key'), original, 'vertical report scroll is not a page gesture')
  await poll(p, () => document.querySelector('.ws-reader').classList.contains('ws-topbar-hidden'))
  await p.waitForTimeout(650) // Let the native touch fling settle before returning to the top.
  await report(p).evaluate(frame => frame.contentWindow.scrollTo(0, 0))
  await poll(p, () => !document.querySelector('.ws-reader').classList.contains('ws-topbar-hidden'))
}, { width: 390, height: 844 })

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

test('Reader c and Cmd-Backslash toggle sidebar; slash focuses Find, filters filenames and Enter selects', async p => {
  await open(p)
  const title = p.locator('.ws-channel-title')
  const sidebar = p.locator('.ws-sidebar')
  await title.focus()
  await p.keyboard.press('c')
  assert.ok(await sidebar.isVisible())
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
  await p.keyboard.press('c')
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
  await p.keyboard.press('c')
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
    assert.equal(await selected(p).locator('.kbn-card-worker,.ws-dock-worker').count(), 0, 'navbar owns the only conversation control')
    assert.equal(await selected(p).locator('.ws-fiber-prose > h1:visible').count(), device === 'phone' ? 0 : 1, 'desktop title is the adopted reading anchor; phone navbar owns the name')
    const navbar = p.locator('.ws-worker-pill')
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
    await poll(p, () => /^aloft(?: · (?:terminal|browser))?$/i.test(document.querySelector('.ws-worker-pill')?.textContent.trim() ?? ''))
    assert.match((await navbar.textContent()).trim(), /^aloft(?: · (?:terminal|browser))?$/i, 'navbar names state, not agent')
    await choose(p, 'Constitution')
    assert.equal(await selected(p).locator('.kbn-card-worker').count(), 0)
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
          band: texts('.ws-selected .ws-dock-worker'),
          settings: texts('.ws-selected .kbn-detail-controls-toggle'),
          navbar: texts('.ws-worker-pill'),
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

const started = performance.now()
let passed = 0
try {
  for (const { name, run, viewport, sidebarChoice, reducedMotion } of tests) {
    const context = await browser.newContext({ viewport: viewport ?? { width: 1440, height: 900 },
      hasTouch: !!viewport && viewport.width <= 700, isMobile: !!viewport && viewport.width <= 700,
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
    if (failure) console.error(`FAIL ${name}\n${failure.stack}`)
    else { passed++; console.log(`PASS ${name}`) }
  }
} finally { await browser.close() }
await mkdir(shots, { recursive: true })
await writeFile(resolve(shots, 'inventory.json'), JSON.stringify(inventory, null, 2))
console.log(`${passed} passed, ${tests.length - passed} failed; ${((performance.now() - started) / 1000).toFixed(1)}s`)
if (passed !== tests.length) process.exitCode = 1
