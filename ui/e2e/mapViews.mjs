// The ways of moving over the work, and the rule they share: moving never
// opens a conversation. Only a click on a thread moves Rex, quietly, and Back
// from a file finds everything where it stood.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pageBack, threadRow } from './familyNav.mjs'

const url = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=threads`
const root = 'Calibrate the shear response'

/** The family's board, with a terminal behind every worker, so asking Rex leaves an event. */
async function board(page) {
  await page.goto(url)
  await page.locator(`.kbn-desk .kbn-family[title*="${root}"] .kbn-family-head`).first().waitFor()
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
  const view = page => page.locator('.ws-page.ws-selected .ws-family-page')
  const head = (page, name) => view(page).locator(`.ov-head[title="${name}"]`)
  const landed = async page => {
    await board(page)
    await page.locator(`.kbn-desk .kbn-family[title*="${root}"] .kbn-family-head`).last().locator('.kbn-family-name').click()
    await view(page).locator('.ov-head').waitFor()
    // A Desk row of the family may open a thread's view: its root is its topmost orchestrator.
    const top = view(page).locator('.ov-ancestor').first()
    if (await top.count()) await top.click()
    await until(page, () => document.querySelector('.ws-page.ws-selected .ov-head') && !document.querySelector('.ws-page.ws-selected .ov-ancestor'))
  }

  test('A constitution\'s view: a thread\'s row opens its view one level down and moves Rex; its orchestrators stand above, opened by a click or a pull past the top; keys move nothing', async page => {
    await landed(page)
    const rootName = await view(page).locator('.ov-head').getAttribute('title')
    // The root has a worker too, so a pull that left Rex alone did so by choice.
    await page.evaluate(async name => {
      window.__harness.MOCK_FEED.fibers.find(entry => entry.fiber.name === name).runtime = { state: 'running', phase: 'waiting', session_uuid: 'session-root', tmux_session: 'session-root' }
      await window.__harness.modal.fetchAndRender()
    }, rootName)
    const quiet = await asked(page)
    await threadRow(page, view(page), 'analysis').click()
    await head(page, 'Response analysis').waitFor()
    await asks(page, quiet.length + 1)
    assert.deepEqual(await asked(page), [...quiet, 'select:session-analysis'])
    assert.match(await page.locator('.ws-stage-band .ws-band-title').textContent(), /\/analysis$/)
    // Its orchestrators stand above its head.
    const scroller = view(page).locator('.ws-family-scroll')
    assert.deepEqual(await view(page).locator('.ov-ancestor .thread-row-slug').allTextContents(), ['calibration-report'])
    // Keys move the focus among the rows, and neither they nor scrolling move Rex.
    await view(page).locator('.ov-head').focus()
    await page.keyboard.press('k')
    assert.equal(await page.evaluate(() => document.activeElement?.querySelector('.thread-row-slug')?.textContent), 'calibration-report')
    await scroller.evaluate(el => { el.scrollTop = 0 })
    assert.deepEqual(await asked(page), [...quiet, 'select:session-analysis'])
    // Pulled past the top, the orchestrator's view opens; a pull is no click, so Rex stays.
    const pulled = await asked(page)
    for (let n = 0; n < 4 && !await head(page, rootName).count(); n++) {
      await scroller.hover()
      await page.mouse.wheel(0, -100)
      await page.waitForTimeout(60)
    }
    await head(page, rootName).waitFor()
    await page.waitForTimeout(500)
    assert.deepEqual(await asked(page), pulled)
    // The thread's row again; Rex already stands at its worker.
    await threadRow(page, view(page), 'analysis').click()
    await head(page, 'Response analysis').waitFor()
    // A click on an orchestrator's step opens its view too, and moves Rex to its worker.
    await scroller.evaluate(el => { el.scrollTop = 0 })
    await view(page).locator('.ov-ancestor').first().click()
    await head(page, rootName).waitFor()
    await asks(page, pulled.length + 1)
    // However many views down the reader went, Back is one step to the Desk.
    await pageBack(page)
    await page.locator('.ws-reader.ws-dormant').waitFor()
    assert.equal(await page.locator('.kbn-viewtabs .kbn-viewtab-active').getAttribute('data-view'), 'desk')
  }, { width: 800, height: 1000 })

  test('A view without threads: its preview takes the view\'s width', async page => {
    await page.goto(url.replace('example=threads', 'example=families'))
    await page.locator('.kbn-desk .kbn-family').first().waitFor()
    await page.evaluate(() => { location.hash = '#/board/hub@umber-workstation/family%3Aumber-workstation%3Ahub' })
    await view(page).locator('.ov-thread[data-fiber="hub/psf-coupling"]').click()
    await view(page).locator('.ov-unfold .ws-thumbnail').waitFor()
    assert.equal(await view(page).locator('.ov-threads').isVisible(), false)
    const [main, preview] = await Promise.all(['.ov-main', '.ov-unfold'].map(part => view(page).locator(part).boundingBox()))
    assert.ok(preview.width > main.width * .9, `the preview spans the view (${preview.width} of ${main.width})`)
  })

  for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) test(`The view, stacked (${device}): its orchestrators pinned above as strips; its tapestry unfolds in place under a bar that stays at the top, steps with ← and →, and folds back`, async page => {
    await page.goto(url.replace('example=threads', 'example=families'))
    await page.locator('.kbn-desk .kbn-family').first().waitFor()
    await page.evaluate(() => { location.hash = '#/board/hub@umber-workstation/family%3Aumber-workstation%3Ahub' })
    await view(page).locator('.ov-thread[data-fiber="hub/pipeline-steward"]').click()
    await view(page).locator('.ov-head .ov-needs').getByText('asks', { exact: true }).waitFor()
    assert.equal((await view(page).locator('.ov-said-text').textContent()).trim(), 'Should the workflow rewrite land before the cut, or after it?')
    // Stacked: the head, the threads, then the preview, at every width.
    const [head, threads, preview] = await Promise.all(['.ov-head', '.ov-threads', '.ov-unfold'].map(part => view(page).locator(part).boundingBox()))
    assert.ok(head.y < threads.y && threads.y + threads.height <= preview.y, 'head, then threads, then the preview')
    assert.equal(await view(page).locator('.ov-up .ov-ancestor .thread-row-slug').allTextContents().then(names => names.join(' ')), 'hub')
    const card = view(page).locator('.uf-card')
    await card.locator('.ws-thumbnail').waitFor()
    assert.equal(await card.count(), 1, 'the other sent files wait behind the files button')
    await card.click()
    const bar = view(page).locator('.uf-bar')
    const where = () => bar.locator('.uf-name, .uf-count').allTextContents()
    assert.deepEqual(await where(), ['Tapestry', '1 / 6'])
    // Unfolded at its natural height, its bar stays at the top of the view's scroll while the page runs on.
    await view(page).locator('.uf-page iframe').waitFor()
    await until(page, () => document.querySelector('.ws-page.ws-selected .uf-page')?.getBoundingClientRect().height > 1000)
    const scroller = view(page).locator('.ws-family-scroll')
    await scroller.evaluate(el => { el.scrollTop += 900 })
    await page.waitForTimeout(100)
    const [barTop, scrollTop] = await Promise.all([bar.boundingBox(), scroller.boundingBox()]).then(([b, s]) => [Math.round(b.y), Math.round(s.y)])
    assert.equal(barTop, scrollTop, 'the bar is pinned to the top of the scroll')
    // → and ← step, from the page and from inside the file; the board takes neither as back.
    const at = page.url()
    await page.keyboard.press('ArrowRight')
    assert.deepEqual(await where(), ['report.html', '2 / 6'])
    await view(page).locator('.uf-page iframe').waitFor()
    await page.frameLocator('.ws-page.ws-selected .uf-page iframe').locator('body').click()
    await page.keyboard.press('ArrowLeft')
    await until(page, () => document.querySelector('.ws-page.ws-selected .uf-bar .uf-count')?.textContent === '1 / 6')
    await page.keyboard.press('ArrowLeft')
    assert.equal(page.url(), at, 'an arrow at the first file goes nowhere')
    // Folded, the preview stands back in sight, and the files button still opens the reader on the newest send.
    await bar.locator('.uf-fold').click()
    assert.equal(await view(page).locator('.uf[data-unfolded]').count(), 0)
    assert.ok(await card.isVisible())
    const box = await card.boundingBox(), shown = await scroller.boundingBox()
    assert.ok(box.y >= shown.y - 1 && box.y < shown.y + shown.height, 'the folded preview is in view')
    await view(page).locator('.ov-head [data-part="sends"]').click()
    await until(page, () => document.querySelector('.ws-page.ws-selected')?.getAttribute('data-key')?.includes('/fixture-project/'))
  }, viewport)

  test('A lone constitution\'s view, and `c` from it opens that worker\'s conversation', async page => {
    await page.goto(url.replace('example=threads', 'example=families'))
    const card = page.locator('.kbn-desk .kbn-family[title="Morning post"] .kbn-family-head').first()
    await card.waitFor({ state: 'attached' })
    await page.evaluate(async () => {
      for (const { runtime } of window.__harness.MOCK_FEED.fibers) if (runtime) runtime.tmux_session = runtime.session_uuid
      await window.__harness.modal.fetchAndRender()
    })
    await card.locator('.kbn-family-name').click({ force: true })
    await head(page, 'Morning post').waitFor()
    assert.equal(await view(page).locator('.ov-thread').count(), 0)
    await view(page).locator('.ov-unfold .ws-thumbnail').waitFor()
    await page.evaluate(() => { document.activeElement?.blur() })
    const before = await asked(page)
    await page.keyboard.press('c')
    await asks(page, before.length + 1)
    assert.deepEqual(await asked(page), [...before, 'open:session-morning-post'])
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
    await page.locator('.kbn-desk .kbn-family').first().waitFor()
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
    await page.locator('.kbn-reader-open').waitFor({ state: 'attached' })
    assert.equal(await page.locator('.kbn-viewtabs .kbn-viewtab-active').getAttribute('data-view'), 'globe', 'the file stands over the Globe')
    await pageBack(page)
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
