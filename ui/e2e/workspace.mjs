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
      document.body.focus()
    })
    await p.keyboard.press('ArrowRight')
    assert.equal(await inner.evaluate(() => sessionStorage.getItem('slide')), '2')
    assert.equal(await selected(p).getAttribute('data-key'), key, 'deck-owned arrows never step workspace documents')
    assert.equal(await p.evaluate(() => localStorage.getItem('plot-theme')), null, 'report preferences cannot leak to board storage')
    await p.evaluate(() => localStorage.setItem('opaque-board-sentinel', 'private-board-state'))
    await inner.evaluate(() => {
      const link = document.createElement('a'); link.href = 'opaque-popup.html'; link.textContent = 'Sibling hostile HTML'; document.body.prepend(link)
    })
    const checkPopup = async click => {
      const opened = p.context().waitForEvent('page')
      await click()
      const popup = await opened
      await popup.waitForFunction(() => window.__access)
      const access = await popup.evaluate(() => window.__access)
      await popup.close()
      assert.deepEqual(access, { storageDenied: true, apiDenied: true, sentinel: null }, 'raw HTML popups cannot regain the board origin')
      return access
    }
    const siblingPopup = await checkPopup(() => inner.getByRole('link', { name: 'Sibling hostile HTML', exact: true }).click())
    await selected(p).getByRole('button', { name: 'Document menu', exact: true }).click()
    const rawFilePopup = await checkPopup(() => p.getByRole('link', { name: 'Open in new tab', exact: true }).click())
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
  await open(p); await reportReady(p)
  await p.locator('.ws-selected iframe').evaluate(frame => {
    const bridge = new DOMParser().parseFromString(frame.srcdoc, 'text/html').querySelector('[data-shuttle-workspace-bridge]').outerHTML
    frame.srcdoc = '<!doctype html><html><head>' + bridge + '</head><body><p id="early">Short initial layout</p><script>window.addEventListener("load",()=>setTimeout(()=>window.__shortReady=true,0))</script></body></html>'
  })
  const inner = await reportDocument(p)
  await inner.waitForFunction(() => window.__shortReady)
  const command = async (type, payload) => p.locator('.ws-selected iframe').evaluate((frame, data) => frame.contentWindow.postMessage(data, '*'), { protocol: 'shuttle-document', version: 1, type, payload })
  await command('restore', { x: 0, y: 160 })
  await command('active', { active: false })
  const saved = () => p.evaluate(() => JSON.parse(sessionStorage.getItem('shuttle:workspace:scroll:' + document.querySelector('.ws-selected').dataset.key))?.y)
  await p.waitForFunction(() => JSON.parse(sessionStorage.getItem('shuttle:workspace:scroll:' + document.querySelector('.ws-selected').dataset.key))?.y === 160)
  assert.equal(await saved(), 160, 'pending restore is not overwritten by a clamped zero')
  await inner.evaluate(() => {
    document.querySelector('#early').remove()
    const main = document.createElement('main'); main.id = 'late'; main.style.cssText = 'height:280px;overflow:auto;line-height:20px'
    main.innerHTML = '<div style="height:6000px">Late asynchronous report content</div>'
    document.body.append(main)
  })
  await inner.waitForFunction(() => document.querySelector('#late').scrollTop === 160)
  await command('active', { active: true })
  await inner.locator('body').click({ position: { x: 1, y: 1 } }); await p.keyboard.press('ArrowDown')
  await inner.waitForFunction(() => document.querySelector('#late').scrollTop > 160)
  await p.waitForFunction(() => JSON.parse(sessionStorage.getItem('shuttle:workspace:scroll:' + document.querySelector('.ws-selected').dataset.key))?.y > 160)
  assert.ok(await saved() > 160)
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
  await poll(p, () => [...document.querySelectorAll('audio')].some(e => !e.paused && e.currentTime > 0))
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
  assert.ok(box.x >= 11 && box.width <= 367, 'HTML page stays in phone gutters')
  await mkdir(shots, { recursive: true })
  await p.screenshot({ path: resolve(shots, 'sandbox-report-phone.png') })
}, { width: 390, height: 844 })

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

test('Sidebar current row follows repeated j/k, Alt navigation and browser Back immediately', async p => {
  await open(p)
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

// Say-it-once checks are scoped to the selected page and its chrome. Tabs,
// the constitution switcher/title and the in-constitution document list repeat
// names intentionally: they select/navigate. The navbar and control-band pills
// are two conversation actions, not two passive worker summaries. Expanded
// settings may repeat values in editable controls; the folded summary is their
// single passive home. Parked/receded pages and the inert Desk aren't a second
// readable screen, so global text counts would enforce the wrong contract.
const inventory = []
const shots = process.env.WORKSPACE_SHOTS || '/tmp/workspace-say-once'
for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  test(`Say it once: ${device} fiber, media, PDF and unsupported metadata`, async p => {
    await open(p); await choose(p, 'Constitution')
    const header = selected(p).locator('.ws-prose-header')
    assert.equal((await header.innerText()).trim().toLowerCase(), 'closed', 'fiber header carries status alone')
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
    const worker = selected(p).locator('.ws-dock-worker')
    const pillCount = await worker.locator('.kbn-card-worker').count()
    assert.ok(pillCount <= 1, 'band has at most one shared conversation action')
    assert.equal(await worker.locator(':scope > *').count(), pillCount, 'no passive worker-line duplicate when there is no worker')
    assert.doesNotMatch(await worker.innerText(), /claude-opus|umber-workstation|fixture-store/)
    const navbar = p.locator('.ws-worker-pill')
    assert.doesNotMatch(await navbar.innerText(), /claude-opus|umber-workstation|fixture-store/)
    assert.match(await selected(p).locator('.ws-provenance').innerText(), /changed 47m ago/i, 'fiber time comes from modified_at, not updated_at or receipts')
    assert.doesNotMatch(await selected(p).locator('.ws-provenance').innerText(), /fiber page|umber-workstation|claude-opus/)
    await capture('fiber')
    // Expanded editable values are an action exception, not passive duplicates.
    await settings.click()
    assert.ok(await selected(p).getByRole('combobox', { name: 'Agent', exact: true }).isVisible())
    await settings.click()
    for (const [state, label] of [['media', 'tone.mp3'], ['pdf', 'response.pdf'], ['unsupported', 'archive.zip']]) {
      await choose(p, label)
      if (state === 'media') {
        await poll(p, () => document.querySelector('.ws-selected audio')?.readyState >= 1)
        assert.equal(await selected(p).locator('progress').count(), 0, 'native transport owns playback position')
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
    await p.locator('.kbn-card').filter({ hasText: 'Remote covariance review' }).click()
    assert.match((await navbar.innerText()).trim(), /^aloft$/i, 'navbar names state, not agent')
    await choose(p, 'Constitution')
    const remoteWorker = selected(p).locator('.ws-dock-worker')
    assert.match((await remoteWorker.innerText()).trim(), /^aloft$/i)
    assert.equal(await remoteWorker.locator('.kbn-card-worker').count(), 1)
    const cadence = selected(p).locator('.kbn-detail-controls-toggle .kbn-ctl-cadence')
    assert.equal(await cadence.count(), 1)
    assert.ok((await cadence.innerText()).trim(), 'standing cadence lives in the settings line')
    const outsideSettings = await selected(p).evaluate(page => {
      const copy = page.cloneNode(true)
      copy.querySelector('.kbn-detail-controls')?.remove()
      return copy.textContent
    })
    assert.ok(!outsideSettings.includes(await cadence.innerText()), 'cadence is not repeated outside its editable settings')

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
    if (failure) console.error(`FAIL ${name}\n${failure.stack}\n${failure.errors?.map(error => error.stack).join('\n') ?? ''}`)
    else { passed++; console.log(`PASS ${name}`) }
  }
} finally { await browser.close() }
await mkdir(shots, { recursive: true })
await writeFile(resolve(shots, 'inventory.json'), JSON.stringify(inventory, null, 2))
console.log(`${passed} passed, ${tests.length - passed} failed; ${((performance.now() - started) / 1000).toFixed(1)}s`)
if (passed !== tests.length) process.exitCode = 1
