import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { familySends, familyTree, openThread, pageBack, sentFiles, showFile, threadRow } from './familyNav.mjs'

const REPORT = '/calibration-report/report.html'
/** The report's bytes as its owner serves them; the board's watcher finds a change on its next poll. */
async function serve(page, html) {
  await page.evaluate(([html, suffix]) => {
    window.__harness.files.find(file => file.path.endsWith(suffix)).body = new Blob([html], { type: 'text/html' })
  }, [html, REPORT])
  await page.clock.runFor(4_000)
}
const grown = html => html.replace('<h2 id="conclusions">', `<h2 id="grown">A new section</h2>${'<p>More of the report.</p>'.repeat(40)}<h2 id="conclusions">`)
const shrunk = html => html.replace(/<p>Report line 21:[\s\S]*<\/body>/, '<p id="shrunk">The rest was cut.</p></body>')

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
  if (phone) await page.locator('.ws-navbar .ws-return').focus()
  await pageBack(page)
  await page.waitForTimeout(100)
}
async function report(page) {
  if (!await page.locator('.ws-selected[data-key$="/report.html"]').count()) await showFile(page, '/report.html')
  await frame(page).getByRole('heading', { name: 'Calibration report', exact: true }).waitFor()
  await page.waitForTimeout(100)
}
export function registerLivingReportJourneys(test) {
  test('A live rewrite keeps the reader in place, on the report\'s page and unfolded on its family\'s page', async page => {
    await page.goto(url)
    const original = await page.evaluate(suffix => window.__harness.files.find(file => file.path.endsWith(suffix)).body.text(), REPORT)
    await page.locator('.kbn-desk .kbn-card[data-fiber-id="research/workspace/calibration-report"]:not(.kbn-card-header) .kbn-card-name').click()
    await selected(page).waitFor()
    await showFile(page, REPORT)
    await frame(page).locator('#report-sentinel').waitFor()
    const inner = async () => (await selected(page).locator('iframe').elementHandle()).contentFrame()
    const reading = async () => (await inner()).evaluate(() => [Math.round(document.scrollingElement.scrollTop), document.scrollingElement.scrollHeight - innerHeight])
    await (await inner()).evaluate(() => document.scrollingElement.scrollTo(0, 2500))
    await page.waitForTimeout(200)
    assert.equal((await reading())[0], 2500)
    // A section grows below the reader: the new page shows where the old one stood.
    await serve(page, grown(original))
    await frame(page).locator('#grown').waitFor({ timeout: 15_000 })
    assert.equal((await reading())[0], 2500, 'the reader stays at its offset in the rewritten report')
    // The report shrinks past the reader: the new page shows clamped to its end at once.
    await serve(page, shrunk(original))
    await frame(page).locator('#shrunk').waitFor({ timeout: 15_000 })
    const [cut, end] = await reading()
    assert.ok(end > 0 && end < 2500, `the shortened report ends above the old offset (${end})`)
    assert.equal(cut, end, 'the reader lands at the shortened report\'s end, without a pass through its top')

    // Unfolded on the family's page, the report is drawn whole and the page scrolls.
    await serve(page, original)
    const head = (await familyTree(page)).locator('.fp-head')
    await head.locator('.fp-lead').click()
    await head.frameLocator('.fp-doc iframe').locator('#report-sentinel').waitFor()
    const scroller = selected(page).locator('.ws-family-scroll')
    const standing = () => scroller.evaluate(el => [Math.round(el.scrollTop), Math.round(el.querySelector('.fp-head .kbn-fileview-frame-wrap').getBoundingClientRect().height)])
    await page.waitForFunction(() => document.querySelector('.ws-selected .fp-head .kbn-fileview-frame-wrap')?.getBoundingClientRect().height > 3000, undefined, { polling: 40 })
    await scroller.evaluate(el => el.scrollTo(0, 2500))
    await page.waitForTimeout(200)
    const [at, tall] = await standing()
    assert.equal(at, 2500)
    await serve(page, grown(original))
    await head.frameLocator('.fp-doc iframe').locator('#grown').waitFor({ timeout: 15_000 })
    await page.waitForFunction(tall => document.querySelector('.ws-selected .fp-head .kbn-fileview-frame-wrap').getBoundingClientRect().height > tall, tall, { polling: 40 })
    assert.equal((await standing())[0], 2500, 'the family page keeps its offset while the report grows under it')
    await serve(page, shrunk(original))
    await head.frameLocator('.fp-doc iframe').locator('#shrunk').waitFor({ timeout: 15_000 })
    await page.waitForFunction(tall => document.querySelector('.ws-selected .fp-head .kbn-fileview-frame-wrap').getBoundingClientRect().height < tall / 2, tall, { polling: 40 })
    const [held] = await standing(), max = await scroller.evaluate(el => el.scrollHeight - el.clientHeight)
    assert.equal(held, Math.min(2500, max), 'a shorter report leaves the page at its offset, or clamped to its end')
  }, { width: 1440, height: 900 }, 'reduce')
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
      await page.locator('.kbn-desk .kbn-card[data-fiber-id="research/workspace/calibration-report"]:not(.kbn-card-header) .kbn-card-name').click()
      // The Desk opens the family's frontier; ancestry reaches the report's owner.
      if (await band(page).locator('.ws-band-title').textContent() !== 'Calibrate the shear response') {
        await band(page).getByRole('button', { name: 'Settings', exact: true }).click()
        await page.locator('.ws-settings-menu:not([hidden]) .ws-ancestry-link').first().click()
      }
      await named(page, 'Calibrate the shear response')
      await band(page).locator('.ws-band-head').waitFor()
      assert.equal(await page.locator('.ws-tabs,.ws-head-index,.ws-thumbbar,.ws-page-choice').count(), 0)
      await shot(page, `${device}-landing`)
      await band(page).getByRole('button', { name: 'Constitution', exact: true }).click()
      await selected(page).locator('.ws-fiber-prose').waitFor()
      await shot(page, `${device}-top`)

      // The report opens in the existing nested reader.
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
      await selected(page).locator('.ws-fiber-prose').waitFor()
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
      await selected(page).locator('.ws-fiber-prose').waitFor()

      if (phone) {
        assert.ok(await (await sentFiles(page)).count() > 0)
        await shot(page, `${device}-sheet`)
        await page.keyboard.press('Escape')
        await page.locator('.ws-page-sheet[open]').waitFor({ state: 'hidden' })
      } else {
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
      // Entering a thread and unfolding its constitution keep the family's page.
      const tree = await familyTree(page), route = new URL(page.url()).hash
      if (!phone) assert.ok(await (await familySends(page)).count() > 0, 'the family page lists the sends')
      const analysis = threadRow(page, tree, 'Response analysis')
      await openThread(page, analysis, 'Response analysis')
      await analysis.locator('.fp-constitution').press('Enter')
      await analysis.locator('.fp-doc .ws-fiber-prose').waitFor()
      assert.equal(new URL(page.url()).hash, route)
      await named(page, 'Calibrate the shear response / Response analysis')
      assert.equal(errors.length, 0, errors.join('\n'))
    }, viewport, 'reduce', phone)
  }
}
