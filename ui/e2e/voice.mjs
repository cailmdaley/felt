// Browser voice journeys use the real board and a synthetic recorder.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { getBrowser } from './browser.mjs'

const browser = await getBrowser({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--allow-file-access-from-files'] })
try {
  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme })
    const page = await context.newPage()
    await page.goto(`${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=music`)
    await page.locator(`.kbn-desk .kbn-card:not(.kbn-card-header):has(.kbn-card-name[title*="Music"])`).first().click()
    const band = page.locator('.ws-stage-band')
    const arm = band.locator('.kbn-ctl-meet-arm')
    await arm.waitFor()
    await page.evaluate(() => {
      const voice = window.__harness.modal.voice
      voice.dispose()
      voice.status = { available: true, enabled: true, muted: false, state: 'listening', target: { fiber_id: 'other', origin: 'other', name: 'An exceptionally long constitution name that must not crowd the band' }, last: null, error: null }
      voice.notify()
    })
    await band.locator('.kbn-ctl-meet-arm.kbn-ctl-meet-on').waitFor()
    const geometry = await page.evaluate(() => {
      const el = document.querySelector('.ws-stage-band .ws-voice-strip')
      return { scroll: el.scrollWidth, client: el.clientWidth, text: el.textContent }
    })
    assert.match(geometry.text, /^Following → /)
    assert.ok(geometry.scroll > geometry.client, 'long name is ellipsized')
    assert.ok(await band.locator('.kbn-ctl-meet').isVisible(), 'Listening remains visible')
    assert.ok(await band.locator('.kbn-ctl-meet-pause').isVisible(), 'Pause sits beside the mic')
    assert.ok(await band.locator('.kbn-ctl-meet-stop').isVisible(), 'Stop sits beside the mic')
    await arm.click()
    assert.ok(await page.getByRole('menuitem', { name: 'Open transcript', exact: true }).isVisible(), 'a press while listening opens the menu')
    await mkdir(process.env.HARK_SCREENSHOT_DIR || '/tmp', { recursive: true })
    await page.screenshot({ path: `${process.env.HARK_SCREENSHOT_DIR || '/tmp'}/hark-${scheme}.png` })
    await page.keyboard.press('Escape')
    await page.evaluate(() => {
      const voice = window.__harness.modal.voice
      voice.status = { ...voice.status, muted: true }
      voice.notify()
    })
    await band.locator('.kbn-ctl-meet-paused').waitFor()
    assert.equal(await band.locator('.kbn-ctl-meet-pause').getAttribute('aria-label'), 'Resume listening')
    await page.screenshot({ path: `${process.env.HARK_SCREENSHOT_DIR || '/tmp'}/hark-paused-${scheme}.png` })
    await context.close()
  }
  console.log('voice layout and paused state: ok (light + dark)')

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.goto(`${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=music`)
  await page.locator('.kbn-desk').waitFor()
  await page.evaluate(() => {
    const voice = window.__harness.modal.voice, fetched = window.fetch
    voice.dispose()
    voice.status = { available: true, enabled: true, muted: false, state: 'listening', target: { fiber_id: 'other', origin: 'other', name: 'Other' }, last: null, error: null }
    window.__routes = []
    window.fetch = (url, init) => {
      if (!String(url).endsWith('/api/v1/voice/target')) return fetched(url, init)
      const target = JSON.parse(init.body)
      window.__routes.push(target)
      return Promise.resolve(new Response(JSON.stringify({ ...voice.status, target })))
    }
  })
  await page.locator(`.kbn-desk .kbn-card:not(.kbn-card-header):has(.kbn-card-name[title*="Music"])`).first().click()
  await page.waitForFunction(() => window.__routes.length > 0)
  const [route] = await page.evaluate(() => window.__routes)
  assert.match(route.name, /Music/)
  assert.equal(await page.evaluate(() => window.__harness.modal.voice.status.target.fiber_id), route.fiber_id)
  await context.close()
  console.log('voice follows the page the board shows: ok')

  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const fromDesk = await desk.newPage()
  await fromDesk.goto(`${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=music`)
  await fromDesk.locator('.kbn-desk .kbn-card').first().waitFor()
  await fromDesk.evaluate(() => {
    const modal = window.__harness.modal, card = modal.workspaceCards()[0]
    modal.voice.onRex({ fiber_id: card.uid ?? card.id, origin: card.originId, name: card.name })
  })
  await fromDesk.locator('.ws-stage-band').waitFor()
  await desk.close()
  console.log('the board goes where Rex went, from the Desk: ok')
} finally { await browser.close() }
