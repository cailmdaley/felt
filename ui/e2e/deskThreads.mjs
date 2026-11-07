// A family's threads hang under its Desk row as an outline: open on what
// needs you, every level folding on its own caret, remembered across a
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
  for (const [device, viewport] of [['half a screen', { width: 800, height: 1000 }], ['phone', { width: 390, height: 844 }]]) test(`The Desk opens a family's threads on what needs you, folds every level and remembers it (${device})`, async page => {
    await page.goto(url)
    await carrier(page).waitFor()
    const uid = await carrier(page).getAttribute('data-card-uid')
    const card = page.locator(`.kbn-desk .kbn-card[data-card-uid="${uid}"]`).first()
    const folded = await shown(card)
    // Open by default only on the way to what needs you.
    for (const [n, row] of folded.entries()) {
      const needs = row.state === 'waiting' || row.state === 'to-review'
      const context = folded.slice(n + 1).some(below => below.depth > row.depth)
      assert.ok(needs || context, `a ${row.state} thread is drawn by default without a reason`)
    }
    await whole(card)
    assert.equal(await card.locator('.kbn-desk-threads').textContent().then(text => /archived/.test(text)), false, 'archived threads stay off the Desk')
    // The rest of a level is behind its count, and a thread with threads folds on its own caret.
    const more = card.locator('.kbn-thread-more').first()
    if (await more.count()) {
      await more.click()
      assert.ok((await shown(card)).length > folded.length)
      await whole(card)
    }
    const nested = card.locator('.kbn-desk-threads button.kbn-thread-fold').first()
    const before = (await shown(card)).length
    const wasOpen = await nested.getAttribute('aria-expanded') === 'true'
    await nested.click()
    assert.equal(await nested.getAttribute('aria-expanded'), String(!wasOpen))
    assert.notEqual((await shown(card)).length, before)
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
    const title = await thread.locator('.kbn-thread-name').textContent()
    await thread.locator('.kbn-thread-name').click()
    await page.waitForFunction(title => document.querySelector('.kbn-reader-open .ws-band-title, .kbn-reader-open .ws-page.ws-selected')?.textContent?.includes(title), title)
  }, viewport)
}
