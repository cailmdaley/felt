// A Desk row holds its family's threads in its own section, each named by
// its slug path, every level folding on its own caret, remembered across a
// reload, never wider than the row.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const url = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=families`
const carrier = page => page.locator('.kbn-desk .kbn-card').filter({ has: page.locator('.kbn-desk-threads:not([hidden]) .kbn-thread-row') }).first()
const shown = card => card.locator('.kbn-desk-threads .kbn-thread-row').evaluateAll(rows => rows.map(row => ({
  state: row.dataset.threadState, depth: Number(row.dataset.depth), clipped: row.scrollWidth > row.clientWidth + 1,
  outside: row.getBoundingClientRect().right > row.closest('.kbn-card').getBoundingClientRect().right + 0.5,
})))
const whole = async card => assert.deepEqual((await shown(card)).filter(row => row.outside || row.clipped), [], 'no thread reaches past its row')

export function registerDeskThreadJourneys(test) {
  test('Desk keys cross sections, skip folds, and enter the selected row', async page => {
    const selected = () => page.locator('.kbn-desk .kbn-key-selected')
    const draftHead = page.locator('[data-column="drafts"] .kbn-col-head')
    const flightHead = page.locator('[data-column="inFlight"] .kbn-col-head')
    await draftHead.click()
    await flightHead.click()
    await page.keyboard.press('j')
    assert.equal(await selected().locator('xpath=ancestor::section[@data-column]').getAttribute('data-column'), 'awaitingReview')
    await page.keyboard.press('k')
    assert.equal(await selected().locator('xpath=ancestor::section[@data-column]').getAttribute('data-column'), 'drafts')
    await page.keyboard.press('j')
    assert.equal(await selected().locator('xpath=ancestor::section[@data-column]').getAttribute('data-column'), 'awaitingReview')
    await page.keyboard.press('h')
    assert.equal(await selected().count(), 0)
    await page.keyboard.press('j')
    const uid = await selected().getAttribute('data-card-uid')
    await page.keyboard.press('l')
    await page.locator('.kbn-reader-open .ws-page.ws-selected').waitFor()
    assert.ok(page.url().includes(uid), 'l opens the selected constitution')
  }, { width: 800, height: 1000 })
  for (const [device, viewport] of [['half a screen', { width: 800, height: 1000 }], ['phone', { width: 390, height: 844 }]]) test(`The Desk holds a family's threads in each section, folds every level and remembers it (${device})`, async page => {
    await page.goto(url)
    await carrier(page).waitFor()
    const uid = await carrier(page).getAttribute('data-card-uid')
    const card = page.locator(`.kbn-desk .kbn-card[data-card-uid="${uid}"]`).first()
    const folded = await shown(card)
    // Every thread beneath a row stands in the row's own section.
    assert.equal(new Set(folded.map(row => row.state)).size, 1, 'a row holds one section\'s threads')
    await whole(card)
    assert.equal(await card.locator('.kbn-desk-threads').textContent().then(text => /archived/.test(text)), false, 'archived threads stay off the Desk')
    const nested = card.locator('.kbn-desk-threads button.kbn-thread-fold').first()
    if (await nested.count()) {
      const before = (await shown(card)).length
      const wasOpen = await nested.getAttribute('aria-expanded') === 'true'
      await nested.click()
      assert.equal(await nested.getAttribute('aria-expanded'), String(!wasOpen))
      assert.notEqual((await shown(card)).length, before)
    }
    // The family's count folds the whole to its row, and the Desk remembers it.
    const count = card.locator('.kbn-thread-count')
    await count.click()
    assert.equal(await count.getAttribute('aria-expanded'), 'false')
    assert.equal((await shown(card)).length, 0)
    await page.reload()
    const again = page.locator(`.kbn-desk .kbn-card[data-card-uid="${uid}"]`).first()
    await again.waitFor()
    assert.equal(await again.locator('.kbn-thread-count').getAttribute('aria-expanded'), 'false', 'the fold is remembered')
    await again.locator('.kbn-thread-count').click()
    // A thread opens its own page, as its row would.
    const thread = again.locator('.kbn-desk-threads .kbn-thread-row').first()
    const title = await thread.getAttribute('title')
    await thread.locator('.kbn-thread-name').click()
    await page.waitForFunction(title => document.querySelector('.kbn-reader-open .ws-band-title, .kbn-reader-open .ws-page.ws-selected')?.textContent?.includes(title), title)
  }, viewport)
}
