import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { familyTree, openThread, pageBack, sentFiles, showFile, threadRow } from './familyNav.mjs'
import { consoleAct, consoleMenu } from './verbs.mjs'

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

/** A rewrite that changes what stands above a reader: passages added under the title, the tall screenshot hidden. */
const reworked = html => html
  .replace('</h1>', `</h1>${Array.from({ length: 30 }, (_, n) => `<p id="added-${n}">An added finding, number ${n}, long enough to take a line of its own.</p>`).join('')}`)
  .replace('<img id="oversized-report-image"', '<img hidden id="oversized-report-image"')
/** The first report line still showing below a frame's reading edge `y`, and where it starts against that edge. */
const passageAt = y => {
  const line = [...document.querySelectorAll('p')].find(p => p.textContent.startsWith('Report line') && p.getBoundingClientRect().bottom > y)
  return [line?.textContent?.slice(0, 16) ?? '-', Math.round((line?.getBoundingClientRect().top ?? 0) - y)]
}

const url = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=threads`
const shots = process.env.WORKSPACE_SHOTS || '/tmp/workspace-say-once'
const selected = page => page.locator('.ws-page.ws-selected')
const band = page => page.locator('.ws-stage-band')
const named = (page, name) => page.waitForFunction(name => document.querySelector('.ws-stage-band .ws-band-title')?.title === name, name)
/** The report's frame on show; a live rewrite stages its successor beside it, unseen, until it loads. */
const SHOWN = 'iframe:not([style*="opacity"])'
const frame = page => selected(page).frameLocator(SHOWN)
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
async function report(page) {
  if (!await page.locator(`.ws-selected[data-key$="${REPORT}"]`).count()) await showFile(page, REPORT)
  await frame(page).getByRole('heading', { name: 'Calibration report', exact: true }).waitFor()
  await page.waitForTimeout(100)
}
/** The constitution's own page, a click on its receded page away. */
async function constitution(page) {
  await page.locator('.ws-page[data-key^="fiber:"]').first().dispatchEvent('click')
  await selected(page).locator('.ws-fiber-prose').waitFor()
}
/** The reader's back from any of its pages is one step to the Desk it was opened from. */
async function leftForDesk(page) {
  await pageBack(page)
  await page.locator('.ws-reader.ws-dormant').waitFor()
  assert.equal(await page.locator('.kbn-viewtabs .kbn-viewtab-active').getAttribute('data-view'), 'desk')
}
export function registerLivingReportJourneys(test) {
  test('A live rewrite keeps the reader in place on the report\'s page', async page => {
    await page.goto(url)
    const original = await page.evaluate(suffix => window.__harness.files.find(file => file.path.endsWith(suffix)).body.text(), REPORT)
    await page.locator('.kbn-desk .kbn-family[data-fiber-id="research/workspace/calibration-report"] .kbn-family-name').click()
    await selected(page).waitFor()
    await showFile(page, REPORT)
    await frame(page).locator('#report-sentinel').waitFor()
    const inner = async () => (await selected(page).locator(SHOWN).elementHandle()).contentFrame()
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

  }, { width: 1440, height: 900 }, 'reduce')
  test('A live rewrite that adds and hides passages above the reader leaves them beside the passage they were reading', async page => {
    await page.goto(url)
    const original = await page.evaluate(suffix => window.__harness.files.find(file => file.path.endsWith(suffix)).body.text(), REPORT)
    await page.locator('.kbn-desk .kbn-family[data-fiber-id="research/workspace/calibration-report"] .kbn-family-name').click()
    await selected(page).waitFor()
    await showFile(page, REPORT)
    await frame(page).locator('#report-sentinel').waitFor()
    const inner = async () => (await selected(page).locator(SHOWN).elementHandle()).contentFrame()
    await (await inner()).evaluate(() => document.scrollingElement.scrollTo(0, 2500))
    await page.waitForTimeout(400)
    const read = async () => (await inner()).evaluate(passageAt, 1)
    const before = await read()
    assert.match(before[0], /^Report line/, `the reader stands in the report's lines (${before})`)
    await serve(page, reworked(original))
    await frame(page).locator('#added-0').waitFor({ timeout: 15_000 })
    await page.waitForTimeout(400)
    const after = await read()
    assert.equal(after[0], before[0], 'the same passage stands at the top of the reader')
    assert.ok(Math.abs(after[1] - before[1]) <= 2, `at the same place on screen (${before} → ${after})`)

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
      await page.locator('.kbn-desk .kbn-family[data-fiber-id="research/workspace/calibration-report"] .kbn-family-name').click()
      // The Desk opens the family's frontier; its topmost orchestrator is the report's owner.
      if (await band(page).locator('.ws-band-title').getAttribute('title') !== 'Calibrate the shear response') {
        await selected(page).locator('.ov-ancestor').first().click()
      }
      await named(page, 'Calibrate the shear response')
      await band(page).locator('.ws-dock').waitFor()
      assert.equal(await page.locator('.ws-tabs,.ws-head-index,.ws-thumbbar,.ws-page-choice').count(), 0)
      await shot(page, `${device}-landing`)
      // Its view's head opens its constitution's page; the receded page is a click away too.
      await constitution(page)
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
      // Escape from inside the report reaches the reader, which closes to the Desk; Forward reopens the report.
      await page.keyboard.press('Escape')
      await page.locator('.ws-reader.ws-dormant').waitFor()
      await page.goForward()
      await report(page)
      await link(page, 'Validation conclusions')
      await frame(page).locator('#validation-conclusions').waitFor()
      assert.ok(await frame(page).locator('#validation-conclusions').evaluate(el => Math.abs(el.getBoundingClientRect().top) < 10))
      await report(page)
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
      // A reload keeps the plot over the Desk: Back is the Desk, and Forward the plot.
      await page.reload()
      await selected(page).locator('img').waitFor()
      await leftForDesk(page)
      await page.goForward()
      await selected(page).locator('img').waitFor()
      await report(page)
      await link(page, 'Cross-host report →')
      await frame(page).getByRole('heading', { name: 'Remote section', exact: true }).waitFor()
      assert.match(await selected(page).getAttribute('data-key'), /^basalt-login-02:\/remote\/report.html$/)
      assert.ok(await frame(page).locator('#remote-section').evaluate(el => Math.abs(el.getBoundingClientRect().top) < 10))
      await report(page)
      // Paths into a thread's folder retain the owning host and nest like any other page.
      await link(page, 'Read the analysis thread →')
      await frame(page).getByRole('heading', { name: 'Response analysis', exact: true }).waitFor()
      await constitution(page)

      if (phone) {
        assert.ok(await (await sentFiles(page)).count() > 0)
        await shot(page, `${device}-sheet`)
        await page.keyboard.press('Escape')
        await page.locator('.ws-page-sheet[open]').waitFor({ state: 'hidden' })
      } else {
        // Settings stands as a button where the console has room, else in its menu, which takes the focus back.
        const settings = await consoleMenu(band(page)).isVisible() ? consoleMenu(band(page)) : band(page).locator('.ws-band-buttons .ws-acts-settings')
        await (await consoleAct(band(page), 'Settings')).click()
        const menu = page.locator('.ws-settings-menu:not([hidden])')
        await menu.waitFor()
        assert.ok(await menu.locator('.kbn-ctl-history').count() > 0, 'sessions live in settings')
        assert.equal(await menu.locator('.ws-sent-file, .ws-family').count(), 0, 'settings hold no threads or sent files')
        const box = await menu.boundingBox(), header = await band(page).locator('.ws-band-head').boundingBox()
        assert.ok(Math.abs(box.y + box.height - header.y) < 16, 'the dropdown opens above the console, clear of it')
        await shot(page, 'desktop-settings')
        await page.keyboard.press('Escape')
        await menu.waitFor({ state: 'hidden' })
        assert.equal(await settings.evaluate(el => el === document.activeElement), true)
      }
      // A thread's row opens its own view, whose head opens its constitution.
      const tree = await familyTree(page)
      if (!phone) assert.ok(await tree.locator('.ov-head [data-part="sends"]').isVisible(), 'the view holds its sent files among its pages')
      await openThread(page, threadRow(page, tree, 'analysis'), 'Response analysis')
      await named(page, 'Response analysis')
      await selected(page).locator('.ov-head [data-part="constitution"]').click()
      await selected(page).locator('.ws-fiber-prose').waitFor()
      assert.equal(errors.length, 0, errors.join('\n'))
    }, viewport, 'reduce', phone)
  }
}
