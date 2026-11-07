// The ways of moving over the work, and the rule they share: moving never
// opens a conversation. Only a click on a thread moves Rex, quietly, and Back
// from a file finds everything where it stood.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const url = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=threads`
const root = 'Calibrate the shear response'

/** The family's board, with a terminal behind every worker, so asking Rex leaves an event. */
async function board(page) {
  await page.goto(url)
  await page.locator('.kbn-desk .kbn-card').filter({ hasText: root }).first().waitFor()
  await page.evaluate(async () => {
    for (const { runtime } of window.__harness.MOCK_FEED.fibers) if (runtime) runtime.tmux_session = runtime.session_uuid
    await window.__harness.modal.fetchAndRender()
  })
}
/** Every ask of Rex, as `select:` for a click's quiet move and `open:` for the explicit act. */
const asked = page => page.evaluate(() => window.__harness.events.filter(event => event.type === 'open-worker' || event.type === 'select-worker').map(event => `${event.type === 'open-worker' ? 'open' : 'select'}:${event.session}`))
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { polling: 40 })
const asks = (page, n) => until(page, n => window.__harness.events.filter(event => event.type === 'open-worker' || event.type === 'select-worker').length >= n, n)
/** A hand's click at a name: names let the pointer through to the tile under them. */
const clickOn = async (page, locator) => { const { x, y, width, height } = await locator.boundingBox(); await page.mouse.click(x + width / 2, y + height / 2) }
const box = async locator => { const { x, y } = await locator.boundingBox(); return [Math.round(x), Math.round(y)] }

export function registerMapViewJourneys(test) {
  const tree = page => page.locator('.ws-page.ws-selected .fp-tree')
  const row = (page, name) => tree(page).locator('.fp-row').filter({ has: page.locator('.fp-name').getByText(name, { exact: true }) })
  const landed = async page => {
    await board(page)
    await page.locator('.kbn-desk .kbn-card').filter({ hasText: root }).last().locator('.kbn-card-name').click()
    await tree(page).waitFor()
  }

  test('A constitution\'s page: a click unfolds a row and moves Rex quietly, a second folds it, and a file and Back leave it as it stood', async page => {
    await landed(page)
    const band = () => page.locator('.ws-stage-band .ws-band-title').textContent()
    const before = await asked(page)
    const analysis = row(page, 'Response analysis')
    if (await analysis.getAttribute('aria-expanded') === 'true') await analysis.click()
    const quiet = await asked(page)
    await analysis.click()
    assert.equal(await analysis.getAttribute('aria-expanded'), 'true')
    await asks(page, quiet.length + 1)
    assert.deepEqual(await asked(page), [...quiet, 'select:session-analysis'], 'an unfolding click moves Rex to the thread\'s window')
    await until(page, () => document.querySelector('.ws-page.ws-selected .fp-row[data-worker] .fp-name')?.textContent === 'Response analysis')
    assert.equal(await band(), root, 'the page does not change')
    await analysis.locator('[data-kind="constitution"]').waitFor()
    const order = await analysis.locator('.fp-held button').evaluateAll(buttons => buttons.map(button => button.dataset.kind ?? button.className))
    assert.deepEqual(order.filter(kind => kind !== 'fp-earlier'), [...(order[0] === 'lead' ? ['lead'] : []), 'constitution', ...order.filter(kind => kind === 'file'), 'fp-converse'], 'tapestry, constitution, then sent files, then Rex')

    const scroll = await page.locator('.ws-page.ws-selected .ws-family-scroll').evaluate(el => el.scrollTop)
    await analysis.locator('[data-kind="constitution"]').click()
    await page.waitForFunction(() => document.querySelector('.ws-stage-band .ws-band-title')?.textContent === 'Response analysis')
    await page.locator('.ws-page.ws-selected .ws-document-back').click()
    await tree(page).waitFor()
    assert.equal(await row(page, 'Response analysis').getAttribute('aria-expanded'), 'true', 'Back finds the row still open')
    assert.equal(await page.locator('.ws-page.ws-selected .ws-family-scroll').evaluate(el => el.scrollTop), scroll, 'and the scroll where it was')

    await row(page, 'Response analysis').click()
    assert.equal(await row(page, 'Response analysis').getAttribute('aria-expanded'), 'false', 'a second click folds the row')
    await row(page, 'Response analysis').focus()
    await page.keyboard.press('ArrowRight')
    assert.equal(await row(page, 'Response analysis').getAttribute('aria-expanded'), 'true', 'the right arrow unfolds')
    await page.keyboard.press('Escape')
    assert.equal(await row(page, 'Response analysis').getAttribute('aria-expanded'), 'false', 'Escape folds the open row')
    assert.equal(await page.locator('.ws-reader.ws-dormant').count(), 0, 'and stays on the page')
    assert.deepEqual(await asked(page), [...quiet, 'select:session-analysis'], 'files, Back, keys and folding never reach Rex')
    assert.ok(before.length <= quiet.length)
  }, { width: 800, height: 1000 }, 'no-preference')

  test('A constitution\'s page sets archived threads aside behind one fold, and opens it on demand', async page => {
    await landed(page)
    const fold = tree(page).locator('.fp-aside').last()
    await fold.waitFor()
    assert.equal(await row(page, 'Discarded pilot').count(), 0, 'nothing set aside shows')
    await fold.click()
    await row(page, 'Discarded pilot').waitFor()
  }, { width: 390, height: 844 }, 'reduce', true)

  test('`l` before the tapestry has been read waits for it, rather than opening the newest file', async page => {
    // The page reads every row's tapestry as it paints, so the reads are held from before it opens.
    await page.goto(url.replace('example=threads', 'example=families'))
    await page.locator('.kbn-desk .kbn-card').first().waitFor()
    await page.evaluate(() => {
      const fetched = window.fetch, held = []
      window.__landReads = () => held.splice(0).forEach(land => land())
      window.fetch = (input, init) => /tapestry\.html/.test(String(input)) ? new Promise(land => held.push(() => land(fetched(input, init)))) : fetched(input, init)
      location.hash = '#/board/hub@umber-workstation/family%3Aumber-workstation%3Ahub'
    })
    await tree(page).locator('.fp-row').first().waitFor()
    await row(page, 'Pipeline repository steward').locator('.fp-name').click()
    const map = await page.evaluate(() => location.hash)
    await page.keyboard.press('l')
    await page.waitForTimeout(200)
    assert.equal(await page.evaluate(() => location.hash), map, 'nothing opens while the read is out')
    await page.evaluate(() => window.__landReads())
    await until(page, () => /tapestry\.html/.test(decodeURIComponent(location.hash)))
  })

  test('Rex naming a fiber on two hosts reveals that host\'s copy on the Globe', async page => {
    await board(page)
    await page.evaluate(async () => {
      const rows = window.__harness.MOCK_FEED.fibers, row = rows.find(({ fiber }) => fiber.name === 'Response analysis')
      delete row.fiber.uid
      rows.push({ ...row, origin: 'other-host', runtime: null, fiber: { ...row.fiber, name: 'Response analysis elsewhere', shuttle: { ...row.fiber.shuttle, host: 'other-host' } } })
      await window.__harness.modal.fetchAndRender()
    })
    const id = await page.evaluate(() => window.__harness.MOCK_FEED.fibers.at(-1).fiber.id)
    const rex = origin => page.evaluate(([origin, id]) => window.__harness.modal.voice.onRex({ fiber_id: id, origin }), [origin, id])
    const here = await page.evaluate(() => window.__harness.MOCK_FEED.fibers.find(({ fiber }) => fiber.name === 'Response analysis').origin)
    await page.keyboard.press('4')
    await page.locator('.globe canvas').waitFor()
    await page.waitForTimeout(1300)
    for (const [origin, name] of [['other-host', 'Response analysis elsewhere'], [here, 'Response analysis']]) {
      await rex(origin)
      await until(page, name => document.querySelector('.globe-peek-name')?.textContent === name, name)
    }
  })

  test('The Globe names every live thread of a crowded family, whole and clear of each other, at half a screen, and leaves the archived quiet', async page => {
    await page.goto(url.replace('example=threads', 'example=families'))
    await page.locator('.kbn-desk .kbn-card').first().waitFor()
    await page.keyboard.press('4')
    await page.locator('.globe canvas').waitFor()
    await page.waitForTimeout(1400)
    await page.evaluate(() => window.__harness.modal.voice.onRex({ fiber_id: 'hub', origin: 'umber-workstation' }))
    await until(page, () => document.querySelector('.globe-peek-name')?.textContent)
    await page.waitForTimeout(1400)
    const names = await page.evaluate(() => [...document.querySelectorAll('.globe-name[data-thread]')].map(name => { const { left, top, right, bottom } = name.getBoundingClientRect(); return { left, top, right, bottom, text: name.getAttribute('aria-label') } }))
    const named = label => names.some(name => name.text.startsWith(`${label}, `))
    const live = ['Staging and production runs', 'Weekly coworking', 'Production on the second site', 'Validation repository steward', 'Pipeline repository steward', 'Why the new shapes couple more to PSF model errors', 'Port the validation workflow to the new runner', 'Learn from the blinded full-area run', 'Non-tomographic mock through validation', 'Shear response on the deep tiles', 'Footprint and masks for the release', 'Photometric redshift calibration', 'Notes for the collaboration meeting', 'Calibration of the star catalogue']
    for (const label of live) assert.ok(named(label), `${label} is named`)
    for (const label of ['Blinded cosmology on the growing catalogue', 'Add the paper figures to validation', 'Check the second site for blind records', 'Pilot on the early footprint', 'Ingest the new exposures']) assert.ok(!named(label), `archived ${label} stays quiet`)
    for (const [n, a] of names.entries()) for (const b of names.slice(n + 1)) assert.ok(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, `${a.text} overlaps ${b.text}`)
  }, { width: 800, height: 1000 })

  test('On the Globe, / opens Find and a pick flies the Globe to that thread, leaving Rex and the stage be', async page => {
    await board(page)
    await page.keyboard.press('4')
    await page.locator('.globe-canvas').waitFor()
    await page.waitForTimeout(1300)
    const before = await asked(page)
    await page.keyboard.press('/')
    await page.keyboard.type('Deep follow-up')
    await page.locator('.ws-channel-row').filter({ hasText: 'Deep follow-up' }).first().waitFor()
    await page.keyboard.press('Enter')
    await page.locator('.globe-peek-name').filter({ hasText: 'Deep follow-up on the response cut' }).waitFor()
    assert.equal(await page.locator('.kbn-reader-open').count(), 0, 'the constitution page stays shut')
    assert.equal(new URL(page.url()).hash, '#/globe')
    assert.deepEqual(await asked(page), before, 'a pick never reaches Rex')
  })

  test('The Globe: hotkey 4, keys and a drag move without Rex, a click moves Rex to its thread, a file opens and Back returns as it stood', async page => {
    await board(page)
    await page.keyboard.press('4')
    const canvas = page.locator('.globe-canvas')
    await canvas.waitFor()
    assert.equal(new URL(page.url()).hash, '#/globe')
    const name = label => page.locator('.globe-names .globe-name').filter({ hasText: label })
    const peek = page.locator('.globe-peek-name')
    const before = await asked(page)
    await page.keyboard.press('ArrowRight')
    await peek.filter({ hasText: 'Choose the response cut' }).waitFor()
    const report = name('Report')
    await report.waitFor()
    const flown = await box(report)
    const stage = await canvas.boundingBox()
    await page.mouse.move(stage.x + 200, stage.y + stage.height - 200)
    await page.mouse.down()
    await page.mouse.move(stage.x + 230, stage.y + stage.height - 215, { steps: 4 })
    await page.mouse.up()
    await until(page, ([x, y]) => {
      const box = [...document.querySelectorAll('.globe-names .globe-name')].find(el => el.textContent === 'Report')?.getBoundingClientRect()
      return box && (Math.round(box.x) !== x || Math.round(box.y) !== y)
    }, flown)
    assert.deepEqual(await asked(page), before, 'moving never reaches Rex')

    const crumbs = await page.locator('.globe-crumbs').textContent()
    await page.waitForTimeout(300)
    const place = await box(report)
    await clickOn(page, report)
    await page.locator('.ws-page.ws-selected .ws-document-back').waitFor()
    assert.equal(await page.locator('.kbn-viewtabs .kbn-viewtab-active').getAttribute('data-view'), 'globe', 'the file stands over the Globe')
    await page.locator('.ws-page.ws-selected .ws-document-back').click()
    await until(page, () => !document.querySelector('.kbn-reader-open'))
    assert.equal(new URL(page.url()).hash, '#/globe')
    await report.waitFor()
    assert.equal(await page.locator('.globe-crumbs').textContent(), crumbs, 'Back keeps the level')
    assert.deepEqual(await box(report), place, 'Back keeps the camera')
    assert.deepEqual(await asked(page), before, 'a file never reaches Rex')

    await clickOn(page, name('Deep follow-up'))
    await peek.filter({ hasText: 'Deep follow-up on the response cut' }).waitFor()
    await asks(page, before.length + 1)
    assert.deepEqual(await asked(page), [...before, 'select:session-analysis/checks/question/deep'], 'a click moves Rex to the thread\'s window at once')
    await page.keyboard.press('Escape')
    await until(page, () => !document.querySelector('.globe-crumbs').textContent.includes('Deep follow-up'))
    assert.equal((await asked(page)).length, before.length + 1, 'stepping out never reaches Rex')
  })
}
