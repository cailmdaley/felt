import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getBrowser } from './browser.mjs'

const url = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=threads&transcript=report`
const shots = process.env.WORKSPACE_SHOTS || '/tmp/workspace-say-once'
const selected = page => page.locator('.ws-page.ws-selected')
const frame = page => selected(page).frameLocator('iframe')
async function link(page, name) {
  const target = frame(page).getByRole('link', { name, exact: true })
  await target.scrollIntoViewIfNeeded()
  await page.waitForTimeout(200)
  await target.click()
}
async function shot(page, name) {
  await mkdir(shots, { recursive: true })
  await page.screenshot({ path: resolve(shots, `${name}.png`) })
}
async function back(page, phone) {
  if (phone) await frame(page).locator('body').evaluate(() => window.scrollBy(0, -100)).catch(() => {})
  const button = phone ? page.locator('.ws-navbar .ws-return') : selected(page).getByRole('button', { name: 'Back one level', exact: true })
  if (phone) await button.focus()
  await button.click()
  await page.waitForTimeout(100)
}
async function report(page) {
  await selected(page).locator('.ws-report-chip').click()
  await frame(page).getByRole('heading', { name: 'Calibration report', exact: true }).waitFor()
  await page.waitForTimeout(100)
}
export function registerLivingReportJourneys(test) {
  for (const [device, viewport, phone] of [['desktop', { width: 1440, height: 900 }, false], ['phone', { width: 390, height: 844 }, true]]) {
    test(`Living report (${device}): header chip, fragments, reload ancestry, nested files, sends and family`, async page => {
      const context = page.context()
      await context.addInitScript(() => {
        if (window.parent !== window) return
        localStorage.setItem('shuttle.workspace.channel-seen:' + JSON.stringify(['umber-workstation', '01KVBR1F9BWBVKF97473PV67K8']), '0')
      })
      const errors = []
      page.on('pageerror', error => errors.push(String(error)))
      await page.goto(url)
      await page.getByRole('button', { name: 'Open Calibrate the shear response — no worker', exact: true }).click()
      await selected(page).locator('textarea').waitFor()
      await page.locator('.ws-report-chip .ws-thumbnail').waitFor()
      assert.equal(await page.locator('.ws-report-inset').count(), 0, 'no live report inset is mounted')
      await shot(page, `${device}-landing`)
      const dockBox = await page.locator('.ws-report-chip').boundingBox()
      const headerBox = await selected(page).locator('.ws-chat-head').boundingBox()
      const settingsBox = await selected(page).getByRole('button', { name: 'Settings', exact: true }).boundingBox()
      assert.ok(dockBox.y >= headerBox.y && dockBox.y + dockBox.height <= headerBox.y + headerBox.height, 'the chip stays within the bar on every device')
      assert.ok(dockBox.x >= settingsBox.x + settingsBox.width, 'the chip follows the icons at the header\'s end')
      assert.equal(await selected(page).locator('.ws-transcript-find').count(), 0, 'the conversation has no local Find or reserved band')
      const composerBox = await selected(page).locator('textarea').boundingBox()
      assert.ok(dockBox.y + dockBox.height < composerBox.y, 'dock stays above the composer')
      await selected(page).locator('.ws-transcript-scroll').evaluate(el => { el.scrollTop = 0 })
      while (await page.locator('.ws-transcript-earlier:visible').count()) {
        await page.locator('.ws-transcript-earlier:visible').click()
        await selected(page).locator('.ws-transcript-scroll').evaluate(el => { el.scrollTop = 0 })
      }
      assert.equal(await page.locator('.ws-report-chip').isVisible(), true, 'scrolling does not dock or hide the chip')
      assert.equal(await page.locator('.ws-tabs,.ws-head-index,.ws-thumbbar,.ws-page-choice').count(), 0)
      assert.equal(await page.locator('.ws-chat-outcome').count(), 0)
      await shot(page, `${device}-top`)

      // The persistent chip opens the report in the existing nested reader.
      await selected(page).locator('.ws-transcript-scroll').evaluate(el => { el.scrollTop = el.scrollHeight })
      await page.locator('.ws-report-chip .ws-thumbnail').waitFor()
      await report(page)
      await shot(page, `${device}-report`)
      // Local fragments stay in srcdoc, retain identity and keep the key bridge alive.
      const identity = await frame(page).locator('#report-identity').textContent()
      await link(page, 'Jump to conclusions')
      assert.equal(await frame(page).locator('#report-identity').textContent(), identity)
      assert.equal(await selected(page).locator('iframe').evaluate(el => el.contentWindow === null), false)
      assert.equal(await frame(page).locator('body').evaluate(() => location.href), 'about:srcdoc')
      assert.ok(await frame(page).locator('#conclusions').evaluate(el => Math.abs(el.getBoundingClientRect().top) < 10))
      await page.keyboard.press('Escape')
      await selected(page).locator('textarea').waitFor()
      await report(page)
      await link(page, 'Validation conclusions')
      await frame(page).locator('#validation-conclusions').waitFor()
      assert.ok(await frame(page).locator('#validation-conclusions').evaluate(el => Math.abs(el.getBoundingClientRect().top) < 10))
      await back(page, phone)
      // A relative page not declared in the body or sent-file ledger opens in the same stage.
      const tabsBefore = context.pages().length
      await link(page, 'Read the independent validation →')
      await frame(page).getByRole('heading', { name: 'Independent patches agree', exact: true }).waitFor()
      await page.waitForTimeout(100)
      assert.equal(context.pages().length, tabsBefore)
      await frame(page).locator('body').evaluate(() => window.scrollTo(0, 0))
      await page.waitForTimeout(100)
      await shot(page, `${device}-nested`)
      await link(page, 'Open the response plot →')
      await selected(page).locator('img').waitFor()
      await shot(page, `${device}-plot`)
      await page.reload()
      await selected(page).locator('img').waitFor()
      await back(page, phone)
      await frame(page).getByRole('heading', { name: 'Independent patches agree', exact: true }).waitFor()
      await back(page, phone)
      await frame(page).getByRole('heading', { name: 'Calibration report', exact: true }).waitFor()
      await link(page, 'Cross-host report →')
      await frame(page).getByRole('heading', { name: 'Remote section', exact: true }).waitFor()
      assert.match(await selected(page).getAttribute('data-key'), /^basalt-login-02:\/remote\/report.html$/)
      assert.ok(await frame(page).locator('#remote-section').evaluate(el => Math.abs(el.getBoundingClientRect().top) < 10))
      await back(page, phone)
      // Paths into a thread's folder retain the owning host and nest like any other page.
      await link(page, 'Read the analysis thread →')
      await frame(page).getByRole('heading', { name: 'Response analysis', exact: true }).waitFor()
      await back(page, phone)
      await frame(page).getByRole('heading', { name: 'Calibration report', exact: true }).waitFor()
      await back(page, phone)
      await selected(page).locator('textarea').waitFor()

      if (phone) {
        await selected(page).getByRole('button', { name: 'Settings', exact: true }).click()
        await page.locator('.ws-page-sheet[open]').waitFor()
        assert.ok(await page.locator('.ws-page-sheet .ws-sent-file').count() > 0)
        assert.ok(await page.locator('.ws-page-sheet [data-group="archived"]').count() > 0)
        await shot(page, 'phone-sheet')
        await page.getByRole('button', { name: 'Close settings', exact: true }).click()
        await page.locator('.ws-page-sheet[open]').waitFor({ state: 'hidden' })
      } else {
        await selected(page).getByRole('button', { name: 'Settings', exact: true }).click()
        await page.locator('.ws-page-sheet[open]').waitFor()
        assert.ok(await page.locator('.ws-page-sheet .ws-sent-file').count() > 0)
        assert.ok(await page.locator('.ws-sent-new').count() > 0)
        assert.ok(await page.locator('.ws-page-sheet .kbn-ctl-history').count() > 0, 'sessions share settings with dated sends')
        const panel = await page.locator('.ws-page-sheet-panel').boundingBox()
        const card = await selected(page).boundingBox()
        assert.ok(panel.x >= card.x && panel.x + panel.width <= card.x + card.width, 'files panel stays in the constitution card')
        await shot(page, 'desktop-sent-files')
        await page.getByRole('button', { name: 'Close settings', exact: true }).click()
        await page.locator('.ws-page-sheet[open]').waitFor({ state: 'hidden' })
        const toggle = page.getByRole('button', { name: 'Hide threads', exact: true })
        await toggle.click()
        assert.equal(await page.locator('.ws-thread-rail').isVisible(), false)
        await page.getByRole('button', { name: 'Show threads', exact: true }).click()
      }
      // Body embeds and links remain reachable from the constitution icon.
      if (phone) await selected(page).getByRole('button', { name: 'Settings', exact: true }).click()
      await page.getByRole('button', { name: 'Constitution', exact: true }).click()
      await selected(page).locator('.ws-fiber-prose').waitFor()
      assert.equal(await selected(page).locator('.ws-dock').count(), 0)
      await back(page, phone)
      await selected(page).locator('textarea').waitFor()
      // A thread's back goes to its orchestrator's chat, not the Desk.
      if (phone) {
        await selected(page).getByRole('button', { name: 'Settings', exact: true }).click()
        await page.locator('.ws-page-sheet [data-group="working"] .kbn-thread-row').first().click()
      } else await page.locator('.ws-thread-rail [data-thread-details="working"] .kbn-thread-row').first().click()
      await selected(page).getByRole('heading', { name: 'Response analysis', exact: true }).waitFor()
      await selected(page).locator('.ws-chat-origin').click()
      await selected(page).getByRole('heading', { name: 'Calibrate the shear response', exact: true }).waitFor()
      // Further ancestors stay reachable from settings without adding a header row.
      if (phone) {
        await selected(page).getByRole('button', { name: 'Settings', exact: true }).click()
        await page.locator('.ws-page-sheet [data-group="working"] .kbn-thread-row').first().click()
      } else await page.locator('.ws-thread-rail [data-thread-details="working"] .kbn-thread-row').first().click()
      await selected(page).getByRole('heading', { name: 'Response analysis', exact: true }).waitFor()
      await selected(page).getByRole('button', { name: 'Settings', exact: true }).click()
      await page.locator('.ws-page-sheet[open] .ws-settings-ancestry .ws-ancestry-link').click()
      await selected(page).getByRole('heading', { name: 'Calibrate the shear response', exact: true }).waitFor()
      assert.equal(await page.locator('.ws-page-sheet[open]').count(), 0)
      assert.equal(errors.length, 0, errors.join('\n'))
    }, viewport, 'false', 'reduce', phone)
  }
  for (const hasTouch of [false, true]) {
    test(`Persistent rail (${hasTouch ? 'coarse' : 'fine'} pointer)`, async page => {
      await page.goto(url)
      const enter = () => page.getByRole('button', { name: 'Open Calibrate the shear response — no worker', exact: true }).click()
      await enter()
      await page.getByRole('button', { name: 'Hide threads', exact: true }).click()
      assert.equal(await page.locator('.ws-thread-rail').isVisible(), false)
      assert.equal(await page.evaluate(() => localStorage.getItem('shuttle:workspace:rail')), 'false')
      await page.reload()
      await page.getByRole('button', { name: 'Show threads', exact: true }).waitFor()
      assert.equal(await page.locator('.ws-thread-rail').isVisible(), false)
      await page.getByRole('button', { name: 'Show threads', exact: true }).click()
      assert.equal(await page.locator('.ws-thread-rail').isVisible(), true)
    }, { width: 1200, height: 900 }, 'false', 'reduce', hasTouch)
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  const cases = []
  registerLivingReportJourneys((...test) => cases.push(test))
  const browser = await getBrowser({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--allow-file-access-from-files'] })
  try {
    for (const [name, run, viewport, , reducedMotion, hasTouch] of cases) {
      const context = await browser.newContext({ viewport, isMobile: viewport.width <= 700, hasTouch, reducedMotion })
      try {
        await run(await context.newPage())
        console.log(`PASS ${name}`)
      } finally { await context.close() }
    }
  } finally { await browser.close() }
}
