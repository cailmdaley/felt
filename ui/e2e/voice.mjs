// Headless Listen journeys over the real board, synthetic daemon and browser mic.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { launchBrowser } from './browser.mjs'

const out = process.env.LISTEN_SCREENSHOT_DIR
if (out) await mkdir(out, { recursive: true })
const url = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=workspace`
// A private headless Chrome supplies fake audio; no operator microphone is opened.
const browser = await launchBrowser({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
})
async function open(page, state) {
  await page.goto(`${url}&voice=${state}`)
  await page.locator('.kbn-desk .kbn-card[data-fiber-id="research/workspace/calibration-report"]:not(.kbn-card-header) .kbn-card-name').click()
  await page.locator('.ws-stage-band .listen-mic').waitFor()
}
const band = page => page.locator('.ws-stage-band')
const mic = page => band(page).locator('.listen-mic')
const menu = page => band(page).locator('.listen-dropdown').click()
const shot = async (page, name) => { if (out) await page.screenshot({ path: resolve(out, `listen-${name}.png`), animations: 'disabled' }) }
try {
  const route = page => band(page).locator('.listen-route')
  for (const state of ['off', 'following', 'pinned', 'meeting', 'muted', 'failed', 'phone']) {
    const phone = state === 'phone'
    const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, hasTouch: phone, isMobile: phone, timezoneId: 'Europe/Paris' })
    const page = await context.newPage()
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    await open(page, state)
    assert.equal(await mic(page).getAttribute('aria-label'), state === 'off' ? 'Listen' : state === 'muted' ? 'Unmute' : 'Mute')
    if (state === 'off') assert.equal(await band(page).locator('.ws-voice-strip').isVisible(), false)
    if (state === 'pinned') assert.match(await band(page).locator('.ws-voice-strip').textContent(), /^📌 /)
    if (state === 'meeting') assert.match(await band(page).locator('.ws-voice-strip').textContent(), /^⏺ /)
    if (state === 'muted') assert.equal(await mic(page).locator('path').count(), 2)
    if (state === 'failed') {
      assert.equal(await band(page).locator('.listen-failed').count(), 1)
      const ink = await mic(page).evaluate(el => getComputedStyle(el).color)
      const alarm = await mic(page).evaluate(el => {
        const probe = document.createElement('span'); probe.style.color = 'var(--ws-stop)'; el.append(probe)
        const color = getComputedStyle(probe).color; probe.remove(); return color
      })
      assert.equal(ink, alarm)
    }
    await menu(page)
    await page.waitForFunction(() => !document.querySelector('.listen-cadence input')?.disabled)
    assert.equal(await route(page).count(), state === 'off' ? 0 : 1)
    if (state === 'meeting') assert.match(await route(page).textContent(), /^Meeting on /)
    assert.equal(await page.getByRole('menuitem', { name: 'Follow me', exact: true }).count(), state === 'pinned' ? 1 : 0)
    assert.equal(await page.getByRole('menuitem', { name: 'End meeting', exact: true }).count(), state === 'meeting' ? 1 : 0)
    assert.equal(await page.getByRole('menuitem', { name: 'Start meeting on this card', exact: true }).count(), phone || state === 'meeting' ? 0 : 1)
    if (state === 'failed') assert.match(await page.locator('[role=menu]').textContent(), /microphone is unavailable/)
    await shot(page, state)
    assert.deepEqual(errors, [])
    await context.close()
  }
  console.log('Listen off, following, pinned, meeting, muted, failed and phone: ok')

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Europe/Paris' })
  const page = await context.newPage()
  await open(page, 'following')
  await menu(page)
  await page.getByRole('menuitem', { name: 'Start meeting on this card', exact: true }).click()
  await band(page).locator('.ws-voice-strip[data-mode=meeting]').waitFor()
  await menu(page)
  await shot(page, 'meeting-menu')
  await page.getByRole('menuitem', { name: 'End meeting', exact: true }).click()
  await band(page).locator('.ws-voice-strip[data-mode=following]').waitFor()
  await menu(page)
  await page.getByRole('menuitem', { name: 'Pin to this card', exact: true }).click()
  await band(page).locator('.ws-voice-strip[data-mode=pinned]').waitFor()
  await menu(page)
  assert.equal(await page.getByRole('menuitem', { name: 'Pin to this card', exact: true }).count(), 0)
  await page.getByLabel('Quiet seconds (pinned)', { exact: true }).fill('90')
  await page.getByLabel('Quiet seconds (pinned)', { exact: true }).press('Tab')
  await page.getByRole('menuitem', { name: "Today's transcript", exact: true }).click()
  await page.locator('.voice-transcript [role=log] p').first().waitFor()
  assert.equal(await page.locator('.voice-transcript [role=log] p').count(), 3)
  assert.match(await page.locator('.voice-transcript [role=log]').textContent(), /\d{2}:\d{2}:\d{2} me → calibration-report:/)
  await page.getByLabel('This card only', { exact: true }).check()
  await page.waitForFunction(() => document.querySelectorAll('.voice-transcript [role=log] p').length === 2)
  await shot(page, 'transcript')
  await page.keyboard.press('Escape')
  await page.locator('.voice-transcript').waitFor({ state: 'detached' })
  await menu(page)
  await page.getByRole('menuitem', { name: 'Follow me', exact: true }).click()
  await band(page).locator('.ws-voice-strip[data-mode=following]').waitFor()
  await mic(page).click()
  await band(page).locator('.listen-muted').waitFor()
  await menu(page)
  await page.getByRole('menuitem', { name: 'Stop listening', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.ws-stage-band .listen-mic')?.getAttribute('aria-label') === 'Listen')
  assert.equal(await band(page).locator('.ws-voice-strip').isVisible(), false)
  const requests = await page.evaluate(() => window.__harness.requests)
  assert.ok(requests.every(request => !request.url.includes('/meeting')))
  assert.ok(requests.some(request => request.url.includes('/api/v1/voice') && request.method === 'POST' && JSON.parse(request.body).pinned_quiet_seconds === 90))
  await context.close()
  console.log('Meeting, follow, pin, pinned quiet, transcript filter, mute and Stop: ok')

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  const phonePage = await mobile.newPage()
  await phonePage.addInitScript(() => {
    window.__phoneSockets = []
    window.WebSocket = class {
      readyState = 0; bufferedAmount = 0; frames = 0
      constructor(url) {
        window.__phoneSockets.push({ url, socket: this })
        setTimeout(() => { this.readyState = 1; this.onopen?.(new Event('open')); this.onmessage?.(new MessageEvent('message', { data: '{"state":"connected"}' })) }, 0)
      }
      send(data) { if (data instanceof ArrayBuffer && data.byteLength) this.frames++ }
      close() { this.readyState = 3 }
    }
  })
  await open(phonePage, 'off')
  await mic(phonePage).click()
  await phonePage.waitForFunction(() => window.__phoneSockets[0]?.socket.frames > 0)
  const socket = await phonePage.evaluate(() => ({ url: window.__phoneSockets[0].url, frames: window.__phoneSockets[0].socket.frames }))
  assert.match(socket.url, /\/api\/v1\/voice\/audio\?launch=voice-harness&recorder=local$/)
  await mic(phonePage).click()
  await band(phonePage).locator('.listen-muted').waitFor()
  await mic(phonePage).click()
  await menu(phonePage)
  assert.equal(await phonePage.getByRole('menuitem', { name: 'Start meeting on this card', exact: true }).count(), 0)
  await phonePage.getByRole('menuitem', { name: 'Stop listening', exact: true }).click()
  await phonePage.waitForFunction(() => window.__phoneSockets[0].socket.readyState === 3)
  await mobile.close()
  console.log(`Phone starts through voice, emits PCM and mutes/stops: ok (${socket.frames} synthetic frames)`)
} finally { await browser.close() }
