// Three ways of moving over the whole of the work, and the one rule they share:
// moving never touches Rex. Only a click on a thread does, and Back from a file
// finds everything where it stood.
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
  const star = (page, name) => page.locator(`.ws-page.ws-selected .fm-star[aria-label^="${name},"]`)
  const rested = page => until(page, () => !document.querySelector('.family-map-moving'))
  const landed = async page => {
    await board(page)
    await page.locator('.kbn-desk .kbn-card').filter({ hasText: root }).last().locator('.kbn-card-name').click()
    await inScene(page, root)
    await rested(page)
  }
  // The scene's title, or on a phone, which draws none, the peek.
  const inScene = (page, name) => until(page, name => document.querySelector('.ws-page.ws-selected :is(.fm-focus-name, .ws-family-peek-name)')?.textContent === name, name)

  test('The radial: a click flies and asks Rex; zoom, pan, Back and stepping out leave it be', async page => {
    await landed(page)
    const band = () => page.locator('.ws-stage-band .ws-band-title').textContent()
    const before = await asked(page)
    const plate = await page.locator('.ws-page.ws-selected .fm-sky-plate').boundingBox()
    const start = await box(star(page, 'Discarded pilot'))
    await page.mouse.move(plate.x + plate.width / 2, plate.y + plate.height / 2)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -40)
    await page.keyboard.up('Control')
    await page.locator('.family-map-moving').waitFor()
    await rested(page)
    const zoomed = await box(star(page, 'Discarded pilot'))
    assert.notDeepEqual(zoomed, start, 'the zoom moved the field')
    await page.mouse.wheel(30, 0)
    await until(page, ([selector, x]) => Math.round(document.querySelector(selector).getBoundingClientRect().x) !== x, ['.ws-page.ws-selected .fm-star[aria-label^="Discarded pilot,"]', zoomed[0]])
    await rested(page)
    assert.deepEqual(await asked(page), before, 'zooming and panning never reach Rex')

    await star(page, 'Response analysis').click()
    assert.equal(await page.locator('.family-map-moving').count(), 1, 'a click flies')
    await rested(page)
    await inScene(page, 'Response analysis')
    await asks(page, before.length + 1)
    assert.deepEqual(await asked(page), [...before, 'select:session-analysis'], 'a click moves Rex to the thread\'s window at once')
    assert.match(await page.locator('.ws-page.ws-selected .fm-star[data-worker]').getAttribute('aria-label'), /^Response analysis,/)
    assert.equal(await band(), root, 'the page does not change')

    const place = await box(star(page, 'Response analysis'))
    await page.locator('.ws-page.ws-selected .fm-held').filter({ hasText: 'Constitution' }).click()
    await until(page, () => document.querySelector('.ws-stage-band .ws-band-title')?.textContent === 'Response analysis')
    await page.locator('.ws-page.ws-selected .ws-document-back').click()
    await inScene(page, 'Response analysis')
    await rested(page)
    assert.deepEqual(await box(star(page, 'Response analysis')), place, 'Back returns to the same zoom')

    await page.keyboard.press('Escape')
    await inScene(page, root)
    await rested(page)
    assert.equal(await page.locator('.ws-reader.ws-dormant').count(), 0, 'stepping out stays on the page')
    assert.deepEqual(await asked(page), [...before, 'select:session-analysis'], 'Back and stepping out never reach Rex')
  }, { width: 1440, height: 900 }, 'no-preference')

  test("The radial on a phone: a first tap comes to a thread, a second leaves a terminal worker's ring alone", async page => {
    await landed(page)
    const held = page.locator('.ws-page.ws-selected .fm-star[data-worker]')
    assert.match(await held.getAttribute('aria-label'), new RegExp(`^${root},`))
    await star(page, 'Response analysis').tap()
    await inScene(page, 'Response analysis')
    assert.match(await held.getAttribute('aria-label'), new RegExp(`^${root},`), 'the first tap leaves Rex be')
    await star(page, 'Response analysis').tap()
    assert.match(await held.getAttribute('aria-label'), new RegExp(`^${root},`), 'a terminal worker has nowhere to open on a phone, so the ring stays')
  }, { width: 390, height: 844 }, 'reduce', true)

  test('`l` before the tapestry has been read waits for it, rather than opening the newest file', async page => {
    await page.goto(`${url.replace('example=threads', 'example=families')}#/board/hub@umber-workstation/family%3Aumber-workstation%3Ahub`)
    await page.locator('.ws-page.ws-selected .fm-star').first().waitFor()
    await page.evaluate(() => {
      const fetched = window.fetch, held = []
      window.__landReads = () => held.splice(0).forEach(land => land())
      window.fetch = (input, init) => /tapestry\.html/.test(String(input)) ? new Promise(land => held.push(() => land(fetched(input, init)))) : fetched(input, init)
    })
    await star(page, 'Pipeline repository steward').click()
    await rested(page)
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
    await page.keyboard.press('2')
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
    await page.keyboard.press('2')
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

  test('The Globe: hotkey 2, keys and a drag move without Rex, a click moves Rex to its thread, a file opens and Back returns as it stood', async page => {
    await board(page)
    await page.keyboard.press('2')
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
