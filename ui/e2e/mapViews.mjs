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
  await page.locator(`.kbn-desk .kbn-card:not(.kbn-card-header):has(.kbn-card-name[title*="${root}"])`).first().waitFor()
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
  const row = (page, name) => tree(page).locator('.fp-row').filter({ has: page.locator(`.fp-name[title="${name}"]`) })
  const landed = async page => {
    await board(page)
    await page.locator(`.kbn-desk .kbn-card:not(.kbn-card-header):has(.kbn-card-name[title*="${root}"])`).last().locator('.kbn-card-name').click()
    await tree(page).waitFor()
  }

  test('A constitution\'s page: rows enter quietly, documents unfold in place, and Back restores the page', async page => {
    await landed(page)
    const analysis = row(page, 'Response analysis')
    if (await analysis.getAttribute('aria-expanded') === 'true') await analysis.click()
    const quiet = await asked(page), route = new URL(page.url()).hash
    await analysis.click()
    assert.equal(await analysis.getAttribute('aria-expanded'), 'true')
    await asks(page, quiet.length + 1)
    assert.deepEqual(await asked(page), [...quiet, 'select:session-analysis'])
    await until(page, () => document.querySelector('.ws-page.ws-selected .fp-row[data-worker] .fp-name')?.title === 'Response analysis')
    // The band names the highlighted thread after its root, and its figures are the thread's.
    assert.equal(await page.locator('.ws-stage-band .ws-band-title').textContent(), `${root} / Response analysis`)
    await analysis.locator('.fp-constitution').click()
    await analysis.locator('.fp-doc .ws-fiber-prose').waitFor()
    assert.equal(new URL(page.url()).hash, route)
    assert.equal(await analysis.locator('.fp-constitution').getAttribute('aria-pressed'), 'true')
    await analysis.locator('.fp-constitution').click()
    assert.equal(await analysis.locator('.fp-doc').isVisible(), false)
    await analysis.click()
    assert.equal(await analysis.getAttribute('aria-expanded'), 'false')
    assert.deepEqual(await asked(page), [...quiet, 'select:session-analysis'])

    const head = tree(page).locator('.fp-head')
    await head.locator('.fp-lead').waitFor()
    const chips = await head.locator('.fp-docs button').allTextContents()
    assert.deepEqual(chips.slice(0, 2), ['⌗', '☰'])
    assert.match(chips[2], /^⧉ [1-9]\d*$/)
    await head.locator('.fp-sent').click()
    assert.equal(await head.locator('.fp-sent').getAttribute('aria-expanded'), 'true')
    const file = head.locator('.fp-files .fp-file').first()
    await file.click()
    await head.locator('.fp-doc .ws-embedded').waitFor()
    assert.equal(new URL(page.url()).hash, route)
    assert.equal(await file.getAttribute('aria-pressed'), 'true')
    await file.click()
    assert.equal(await head.locator('.fp-doc').isVisible(), false)
    // A PDF unfolds whole: its pages and toolbar, not a frame's slice of them.
    const pdf = head.locator('.fp-files .fp-file').filter({ hasText: 'response.pdf' })
    await pdf.click()
    await head.locator('.fp-doc .pdfViewer canvas').first().waitFor()
    const [doc, stage] = await Promise.all(['.fp-doc', '.fp-doc .kbn-fileview-pdf-stage'].map(sel => head.locator(sel).evaluate(el => el.getBoundingClientRect().height)))
    assert.ok(doc >= stage, `the unfolded PDF shows its whole stage (${doc}px row for a ${stage}px stage)`)
    await pdf.click()
    await head.locator('.fp-lead').click()
    const link = head.frameLocator('.fp-doc iframe').getByRole('link', { name: 'Read the independent validation →' })
    await link.waitFor()
    // Back keeps the open document where it stood in the page's view. The page
    // may grow above it meanwhile (the visited file joins the row's sent files),
    // which the browser's scroll anchoring absorbs, so scrollTop alone can move.
    const standing = () => page.locator('.ws-page.ws-selected .ws-family-scroll').evaluate(el => Math.round(el.querySelector('.fp-head > .fp-doc').getBoundingClientRect().top - el.getBoundingClientRect().top))
    const stood = await standing()
    await link.click()
    await page.locator('.ws-page.ws-selected iframe').waitFor()
    await page.locator('.ws-page.ws-selected .ws-document-back').click()
    await head.frameLocator('.fp-doc iframe').getByRole('link', { name: 'Read the independent validation →' }).waitFor()
    assert.equal(new URL(page.url()).hash, route)
    assert.equal(await analysis.getAttribute('aria-expanded'), 'false')
    await until(page, () => !document.querySelector('.ws-track')?.getAnimations({ subtree: true }).some(a => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity))
    assert.equal(await standing(), stood)
  }, { width: 800, height: 1000 }, 'no-preference')

  test('Row keys skim without moving voice or Rex, then enter and leave the page', async page => {
    await landed(page)
    await page.evaluate(() => {
      const voice = window.__harness.modal.voice, fetch = window.fetch
      voice.dispose()
      voice.status = { available: true, enabled: true, muted: false, state: 'listening', target: { fiber_id: 'other', origin: 'other', name: 'Other' }, last: null, error: null }
      window.__routes = []
      window.fetch = (url, init) => {
        if (!String(url).endsWith('/api/v1/voice/target')) return fetch(url, init)
        const target = JSON.parse(init.body); window.__routes.push(target)
        return Promise.resolve(new Response(JSON.stringify({ ...voice.status, target })))
      }
    })
    const before = await asked(page), analysis = row(page, 'Response analysis')
    await tree(page).locator('.fp-head').focus()
    for (let n = 0; n < 20 && await analysis.getAttribute('aria-selected') !== 'true'; n++) await page.keyboard.press('j')
    assert.equal(await analysis.getAttribute('aria-selected'), 'true')
    assert.deepEqual(await asked(page), before)
    assert.deepEqual(await page.evaluate(() => window.__routes), [])
    await page.keyboard.press('Enter')
    await asks(page, before.length + 1)
    await until(page, () => window.__routes.some(target => target.name === 'Response analysis'))
    assert.deepEqual(await asked(page), [...before, 'select:session-analysis'])
    await analysis.focus()
    await page.keyboard.press('l')
    assert.ok(await analysis.locator('.fp-docs button').first().evaluate(el => el === document.activeElement))
    await page.keyboard.press('l')
    await analysis.locator('.fp-doc .ws-embedded').waitFor()
    await page.keyboard.press('h')
    assert.equal(await analysis.locator('.fp-doc').isVisible(), false)
    assert.ok(await analysis.evaluate(el => el === document.activeElement))
    await page.keyboard.press('l')
    await analysis.locator('.fp-doc .ws-embedded').waitFor()
    await page.keyboard.press('k')
    assert.equal(await analysis.getAttribute('aria-selected'), 'false', 'k moves on from a row with a document unfolded')
    assert.equal(await analysis.locator('.fp-doc').isVisible(), true, 'the document stays under its own row')
    await page.keyboard.press('h')
    assert.equal(await analysis.locator('.fp-doc').isVisible(), false, 'h from another row folds it first')
    assert.ok(await page.locator('.kbn-reader-open').count())
    await page.keyboard.press('h')
    await until(page, () => !document.querySelector('.kbn-reader-open'))
  }, { width: 800, height: 1000 })

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
      window.__landReads = () => { window.fetch = fetched; held.splice(0).forEach(land => land()) }
      window.fetch = (input, init) => /tapestry\.html/.test(String(input)) ? new Promise(land => held.push(() => land(fetched(input, init)))) : fetched(input, init)
      location.hash = '#/board/hub@umber-workstation/family%3Aumber-workstation%3Ahub'
    })
    await tree(page).locator('.fp-row').first().waitFor()
    await row(page, 'Pipeline repository steward').locator('.fp-name').click()
    // Away from the rows, where `l` steps down a level, it opens the selected thread's tapestry.
    await page.evaluate(() => { document.activeElement?.blur() })
    const map = await page.evaluate(() => location.hash)
    await page.keyboard.press('l')
    await page.waitForTimeout(200)
    assert.equal(await page.evaluate(() => location.hash), map, 'nothing opens while the read is out')
    await page.evaluate(() => window.__landReads())
    const steward = row(page, 'Pipeline repository steward')
    await steward.frameLocator('.fp-doc iframe').getByRole('heading', { name: 'Pipeline repository steward' }).waitFor()
    assert.equal(new URL(page.url()).hash, map, 'the tapestry unfolds on the family page')
    assert.equal(await steward.locator('.fp-lead').getAttribute('aria-pressed'), 'true')
    await page.evaluate(() => { document.activeElement?.blur() })
    await page.keyboard.press('l')
    assert.equal(await steward.locator('.fp-doc').isVisible(), false, 'a second l folds it')
  })

  test('A lone constitution opens on its tapestry, and `c` from inside it opens that worker\'s conversation', async page => {
    await page.goto(url.replace('example=threads', 'example=families'))
    const card = page.locator('.kbn-desk .kbn-card:has(.kbn-card-name[title="Morning post"])').first()
    await card.waitFor({ state: 'attached' })
    await page.evaluate(async () => {
      for (const { runtime } of window.__harness.MOCK_FEED.fibers) if (runtime) runtime.tmux_session = runtime.session_uuid
      await window.__harness.modal.fetchAndRender()
    })
    await card.locator('.kbn-card-name').click({ force: true })
    const head = tree(page).locator('.fp-head')
    const map = head.frameLocator('.fp-doc iframe')
    await map.getByRole('heading', { name: 'Morning post' }).click()
    assert.ok(await head.locator('.fp-doc iframe').evaluate(el => el === document.activeElement), 'the tapestry holds the focus')
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
