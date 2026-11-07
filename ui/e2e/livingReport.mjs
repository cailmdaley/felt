import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getBrowser } from './browser.mjs'
import { familyTree, openThread, sentFiles } from './familyNav.mjs'

const url = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=threads`
const shots = process.env.WORKSPACE_SHOTS || '/tmp/workspace-say-once'
const selected = page => page.locator('.ws-page.ws-selected')
const band = page => page.locator('.ws-stage-band')
const named = (page, name) => page.waitForFunction(name => document.querySelector('.ws-stage-band .ws-band-title')?.textContent === name, name)
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
  const button = phone ? page.locator('.ws-navbar .ws-return') : selected(page).locator('.ws-document-back')
  if (phone) await button.focus()
  await button.click()
  await page.waitForTimeout(100)
}
async function report(page, phone) {
  if (!await page.locator('.ws-selected[data-key$="/report.html"]').count()) {
    await (await sentFiles(page)).and(page.locator('[data-key$="/report.html"]')).click()
  }
  await frame(page).getByRole('heading', { name: 'Calibration report', exact: true }).waitFor()
  await page.waitForTimeout(100)
}
export function registerLivingReportJourneys(test) {
  for (const [device, viewport, phone] of [['desktop', { width: 1440, height: 900 }, false], ['phone', { width: 390, height: 844 }, true]]) {
    test(`Living report (${device}): band, fragments, reload ancestry, nested files, sends and family`, async page => {
      const context = page.context()
      await context.addInitScript(() => {
        if (window.parent !== window) return
        localStorage.setItem('shuttle.workspace.channel-seen:' + JSON.stringify(['umber-workstation', '01KVBR1F9BWBVKF97473PV67K8']), '0')
      })
      const errors = []
      page.on('pageerror', error => errors.push(String(error)))
      await page.goto(url)
      await page.locator('.kbn-desk .kbn-card[data-fiber-id="research/workspace/calibration-report"]').click()
      // The family tree keeps the report's owning constitution at its root.
      await (await familyTree(page)).locator('.kbn-thread-row').first().click()
      await band(page).locator('.ws-band-head').waitFor()
      assert.equal(await page.locator('.ws-report-inset').count(), 0, 'no live report inset is mounted')
      assert.equal(await page.locator('.ws-tabs,.ws-head-index,.ws-thumbbar,.ws-page-choice').count(), 0)
      await shot(page, `${device}-landing`)
      await band(page).getByRole('button', { name: 'Constitution', exact: true }).click()
      await selected(page).locator('.ws-fiber-prose').waitFor()
      await shot(page, `${device}-top`)

      // The report opens in the existing nested reader.
      await report(page, phone)
      await shot(page, `${device}-report`)
      // Local fragments stay in srcdoc, retain identity and keep the key bridge alive.
      const identity = await frame(page).locator('#report-identity').textContent()
      await link(page, 'Jump to conclusions')
      assert.equal(await frame(page).locator('#report-identity').textContent(), identity)
      assert.equal(await selected(page).locator('iframe').evaluate(el => el.contentWindow === null), false)
      assert.equal(await frame(page).locator('body').evaluate(() => location.href), 'about:srcdoc')
      assert.ok(await frame(page).locator('#conclusions').evaluate(el => Math.abs(el.getBoundingClientRect().top) < 10))
      await page.keyboard.press('Escape')
      await selected(page).locator('.ws-fiber-prose').waitFor()
      await report(page, phone)
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
      await selected(page).locator('.ws-fiber-prose').waitFor()

      assert.ok(await (await sentFiles(page)).count() > 0)
      await shot(page, `${device}-sheet`)
      await page.keyboard.press('Escape')
      await page.locator('.ws-page-sheet[open]').waitFor({ state: 'hidden' })
      if (!phone) {
        await band(page).getByRole('button', { name: 'Settings', exact: true }).click()
        const menu = page.locator('.ws-settings-menu:not([hidden])')
        await menu.waitFor()
        assert.ok(await menu.locator('.kbn-ctl-history').count() > 0, 'sessions live in settings')
        assert.equal(await menu.locator('.ws-sent-file, .ws-family').count(), 0, 'settings hold no threads or sent files')
        const box = await menu.boundingBox(), header = await band(page).locator('.ws-band-head').boundingBox()
        assert.ok(Math.abs(box.y - (header.y + header.height)) < 16, 'the dropdown leaves both header rows clear')
        await shot(page, 'desktop-settings')
        await page.keyboard.press('Escape')
        await menu.waitFor({ state: 'hidden' })
        assert.equal(await band(page).getByRole('button', { name: 'Settings', exact: true }).evaluate(el => el === document.activeElement), true)
      }
      // A thread's back returns to the page from which it was opened.
      await openThread(page, (await familyTree(page)).locator('.kbn-thread-row[data-thread-state="working"]').first(), 'Response analysis')
      await back(page, phone)
      await named(page, 'Calibrate the shear response')
      // Further ancestors stay reachable from settings without adding a header row.
      await openThread(page, (await familyTree(page)).locator('.kbn-thread-row[data-thread-state="working"]').first(), 'Response analysis')
      await band(page).getByRole('button', { name: 'Settings', exact: true }).click()
      await page.locator('.ws-settings-menu:not([hidden]) .ws-settings-ancestry .ws-ancestry-link').click()
      await named(page, 'Calibrate the shear response')
      assert.equal(await page.locator('.ws-settings-menu:not([hidden])').count(), 0)
      assert.equal(errors.length, 0, errors.join('\n'))
    }, viewport, 'reduce', phone)
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
