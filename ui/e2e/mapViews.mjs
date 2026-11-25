// The ways of moving over the work, and the rule they share: moving never
// opens a conversation or steers Rex, and Back from a file finds everything
// where it stood.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pageBack, threadRow } from './familyNav.mjs'

const url = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=threads`
const root = 'Calibrate the shear response'

/** The family's board, with a terminal behind every worker, so asking Rex leaves an event. */
async function board(page) {
  await page.goto(url)
  await page.locator(`.kbn-desk .kbn-family[title*="${root}"] > :first-child`).first().waitFor()
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
    await page.locator(`.kbn-desk .kbn-family[title*="${root}"] > :first-child`).last().locator(':is(.kbn-family-name, .thread-row-slug)').click()
    await view(page).locator('.ov-head').waitFor()
    // A Desk row of the family may open a thread's view: its root is its topmost orchestrator.
    const top = view(page).locator('.ov-ancestor').first()
    if (await top.count()) await top.click()
    await until(page, () => document.querySelector('.ws-page.ws-selected .ov-head') && !document.querySelector('.ws-page.ws-selected .ov-ancestor'))
  }

  test('A constitution\'s view: a thread\'s row opens its view one level down; its orchestrators stand above, opened by a click or a pull past the top; moving never steers Rex', async page => {
    await landed(page)
    const rootName = await view(page).locator('.ov-head').getAttribute('title')
    await page.evaluate(async name => {
      window.__harness.MOCK_FEED.fibers.find(entry => entry.fiber.name === name).runtime = { state: 'running', phase: 'waiting', session_uuid: 'session-root', tmux_session: 'session-root' }
      await window.__harness.modal.fetchAndRender()
    }, rootName)
    await threadRow(page, view(page), 'analysis').click()
    await head(page, 'Response analysis').waitFor()
    assert.deepEqual(await asked(page), [])
    assert.match(await page.locator('.ws-stage-band .ws-band-title').textContent(), /\/analysis$/)
    // Its orchestrators stand above its head.
    const scroller = view(page).locator('.ws-family-scroll')
    assert.deepEqual(await view(page).locator('.ov-ancestor .thread-row-slug').allTextContents(), ['calibration-report'])
    // Keys move the focus among the rows, and neither they nor scrolling steer Rex.
    await view(page).locator('.ov-head').focus()
    await page.keyboard.press('k')
    assert.equal(await page.evaluate(() => document.activeElement?.querySelector('.thread-row-slug')?.textContent), 'calibration-report')
    await scroller.evaluate(el => { el.scrollTop = 0 })
    assert.deepEqual(await asked(page), [])
    // Pulled past the top, the orchestrator's view opens.
    for (let n = 0; n < 4 && !await head(page, rootName).count(); n++) {
      await scroller.hover()
      await page.mouse.wheel(0, -100)
      await page.waitForTimeout(60)
    }
    await head(page, rootName).waitFor()
    assert.deepEqual(await asked(page), [])
    // The thread's row again, then a click on an orchestrator's step opens its view too.
    await threadRow(page, view(page), 'analysis').click()
    await head(page, 'Response analysis').waitFor()
    await scroller.evaluate(el => { el.scrollTop = 0 })
    await view(page).locator('.ov-ancestor').first().click()
    await head(page, rootName).waitFor()
    await page.waitForTimeout(150)
    assert.deepEqual(await asked(page), [])
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
    // The threads keep to a reading measure, so each row's age stands near its words.
    assert.ok(threads.width <= 760, `the thread list is ${threads.width}px wide`)
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
    // The report itself shows, not a frame left empty.
    assert.equal(await page.frameLocator('.ws-page.ws-selected .uf-page iframe').locator('h1').textContent(), 'Report: Pipeline repository steward')
    await view(page).locator('.uf-page iframe').waitFor()
    if (device === 'desktop') {
      // On a computer the unfolded page is live: a press inside it is the page's, and its keys come back to the bar.
      assert.equal(await view(page).locator('.uf-cover').count(), 0)
      await page.frameLocator('.ws-page.ws-selected .uf-page iframe').locator('body').click()
    } else {
      // On a phone a pane over the page takes the press for full screen; the page under it is inert, the bar's full screen named for it.
      assert.equal(await view(page).locator('.uf-cover').getAttribute('aria-hidden'), 'true')
      assert.equal(await view(page).locator('.uf-page > :first-child').evaluate(el => el.inert), true)
      assert.equal(await bar.locator('.uf-full').getAttribute('aria-label'), 'Open report.html full screen')
      await view(page).locator('.uf-page').focus()
    }
    await page.keyboard.press('ArrowLeft')
    await until(page, () => document.querySelector('.ws-page.ws-selected .uf-bar .uf-count')?.textContent === '1 / 6')
    await page.keyboard.press('ArrowLeft')
    assert.equal(page.url(), at, 'an arrow at the first file goes nowhere')
    // Folded, the preview stands back in sight, and the files button lists the sends, the newest opening the reader.
    await bar.locator('.uf-fold').click()
    assert.equal(await view(page).locator('.uf[data-unfolded]').count(), 0)
    assert.ok(await card.isVisible())
    const box = await card.boundingBox(), shown = await scroller.boundingBox()
    assert.ok(box.y >= shown.y - 1 && box.y < shown.y + shown.height, 'the folded preview is in view')
    await view(page).locator('.ov-head [data-part="sends"]').click()
    await page.locator('.kbn-conversation-menu .uf-file-row').first().click()
    await view(page).locator('.uf[data-unfolded] .uf-full').click()
    await until(page, () => document.querySelector('.ws-page.ws-selected')?.getAttribute('data-key')?.includes('/fixture-project/'))
  }, viewport)

  test('A lone constitution\'s view, and `c` from it opens that worker\'s conversation', async page => {
    await page.goto(url.replace('example=threads', 'example=families'))
    const card = page.locator('.kbn-desk .kbn-family[title="Morning post"] > :first-child').first()
    await card.waitFor({ state: 'attached' })
    await page.evaluate(async () => {
      for (const { runtime } of window.__harness.MOCK_FEED.fibers) if (runtime) runtime.tmux_session = runtime.session_uuid
      await window.__harness.modal.fetchAndRender()
    })
    await card.locator(':is(.kbn-family-name, .thread-row-slug)').click({ force: true })
    await head(page, 'Morning post').waitFor()
    assert.equal(await view(page).locator('.ov-thread').count(), 0)
    await view(page).locator('.ov-unfold .ws-thumbnail').waitFor()
    await page.evaluate(() => { document.activeElement?.blur() })
    const before = await asked(page)
    await page.keyboard.press('c')
    await asks(page, before.length + 1)
    assert.deepEqual(await asked(page), [...before, 'open:session-morning-post'])
  })
}
