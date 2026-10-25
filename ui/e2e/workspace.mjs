import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getBrowser } from './browser.mjs'

const browser = await getBrowser({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--allow-file-access-from-files'] })
const url = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=threads`
const shots = process.env.WORKSPACE_SHOTS || resolve('e2e-shots')
await mkdir(shots, { recursive: true })
const selected = page => page.locator('.ws-page.ws-selected')
const frame = page => selected(page).frameLocator('iframe')
async function shot(page, name) { await page.screenshot({ path: resolve(shots, `${name}.png`) }) }
async function back(page, phone) {
  await (phone ? page.locator('.ws-navbar .ws-return') : selected(page).getByRole('button', { name: 'Back one level', exact: true })).click()
}
async function report(page) {
  await page.getByRole('button', { name: 'Read report', exact: true }).click()
  await frame(page).getByRole('heading', { name: 'Calibration report', exact: true }).waitFor()
}
try {
  for (const [device, viewport, phone] of [['desktop', { width: 1440, height: 900 }, false], ['phone', { width: 390, height: 844 }, true]]) {
    const context = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone, reducedMotion: 'reduce' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(String(error)))
    await page.goto(url)
    await page.getByRole('button', { name: 'Open Calibrate the shear response — no worker', exact: true }).click()
    await selected(page).locator('textarea').waitFor()
    await page.locator('.ws-report-inset iframe').waitFor()
    await page.frameLocator('.ws-report-inset iframe').locator('#report-sentinel').waitFor()
    assert.equal(await page.locator('.ws-tabs,.ws-head-index,.ws-thumbbar,.ws-page-choice').count(), 0)
    assert.equal(await page.locator('.ws-chat-outcome').count(), 0)
    const geometry = await page.locator('.ws-report-inset').evaluate(el => {
      const box = el.getBoundingClientRect(), chat = el.closest('.ws-chat').getBoundingClientRect()
      return { width: box.width, right: box.right, chatRight: chat.right }
    })
    assert.ok(geometry.width > (phone ? 150 : 300), `report is an illustration, not a tiny thumbnail: ${JSON.stringify(geometry)}`)
    await shot(page, `${device}-landing`)

    await report(page)
    await shot(page, `${device}-report`)
    // A relative page not declared in the body or sent-file ledger opens in the same stage.
    const tabsBefore = context.pages().length
    await frame(page).getByRole('link', { name: 'Read the independent validation →', exact: true }).click()
    await frame(page).getByRole('heading', { name: 'Independent patches agree', exact: true }).waitFor()
    assert.equal(context.pages().length, tabsBefore)
    await shot(page, `${device}-nested`)
    await frame(page).getByRole('link', { name: 'Open the response plot →', exact: true }).click()
    await selected(page).locator('img').waitFor()
    await shot(page, `${device}-plot`)
    await back(page, phone)
    await frame(page).getByRole('heading', { name: 'Independent patches agree', exact: true }).waitFor()
    await back(page, phone)
    await frame(page).getByRole('heading', { name: 'Calibration report', exact: true }).waitFor()
    // Paths into a thread's folder retain the owning host and nest like any other page.
    await frame(page).getByRole('link', { name: 'Read the analysis thread →', exact: true }).click()
    await frame(page).getByRole('heading', { name: 'Response analysis', exact: true }).waitFor()
    await back(page, phone)
    await frame(page).getByRole('heading', { name: 'Calibration report', exact: true }).waitFor()
    await back(page, phone)
    await selected(page).locator('textarea').waitFor()

    if (phone) {
      await page.locator('.ws-chat-pages').click()
      await page.locator('.ws-page-sheet[open]').waitFor()
      assert.ok(await page.locator('.ws-page-sheet .ws-sent-file').count() > 0)
      assert.ok(await page.locator('.ws-page-sheet [data-group="archived"]').count() > 0)
      await shot(page, 'phone-sheet')
      await page.getByRole('button', { name: 'Close sent files', exact: true }).click()
      await page.locator('.ws-page-sheet[open]').waitFor({ state: 'hidden' })
    } else {
      await page.getByLabel('Constitution menu', { exact: true }).click()
      await page.getByRole('button', { name: 'Sent files', exact: true }).click()
      await page.locator('.ws-page-sheet[open]').waitFor()
      assert.ok(await page.locator('.ws-page-sheet .ws-sent-file').count() > 0)
      await shot(page, 'desktop-sent-files')
      await page.getByRole('button', { name: 'Close sent files', exact: true }).click()
      await page.locator('.ws-page-sheet[open]').waitFor({ state: 'hidden' })
      const toggle = page.getByRole('button', { name: 'Hide threads', exact: true })
      await toggle.click()
      assert.equal(await page.locator('.ws-thread-rail').isVisible(), false)
      await page.getByRole('button', { name: 'Show threads', exact: true }).click()
    }
    // Body embeds and links remain reachable from the constitution menu.
    await page.getByLabel('Constitution menu', { exact: true }).click()
    await page.getByRole('button', { name: 'Constitution', exact: true }).click()
    await selected(page).locator('.ws-fiber-prose').waitFor()
    assert.equal(await selected(page).locator('.ws-dock').count(), 0)
    await back(page, phone)
    await selected(page).locator('textarea').waitFor()
    // A thread's back goes to its orchestrator's chat, not the Desk.
    if (phone) {
      await page.locator('.ws-chat-pages').click()
      await page.locator('.ws-page-sheet [data-group="working"] .kbn-thread-row').first().click()
    } else await page.locator('.ws-thread-rail [data-thread-details="working"] .kbn-thread-row').first().click()
    await selected(page).getByRole('heading', { name: 'Response analysis', exact: true }).waitFor()
    await selected(page).locator('.ws-chat-origin').click()
    await selected(page).getByRole('heading', { name: 'Calibrate the shear response', exact: true }).waitFor()
    assert.equal(errors.length, 0, errors.join('\n'))
    await context.close()
    console.log(`PASS living report (${device}): inset, nested pages/plots/thread report, back, sends, body, family`)
  }
} finally { await browser.close() }
