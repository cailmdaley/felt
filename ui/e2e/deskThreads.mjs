// A family's threads hang under its Desk row: folded to what needs you, the
// rest behind the count's caret, remembered across a reload, never wider than
// the row.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const url = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=families`

const carrier = page => page.locator('.kbn-desk .kbn-card').filter({ has: page.locator('.kbn-thread-count[aria-expanded]') })
  .filter({ has: page.locator('.kbn-desk-threads:not([hidden]) .kbn-thread-row') }).first()
const shown = card => card.locator('.kbn-desk-threads .kbn-thread-row').evaluateAll(rows => rows.map(row => ({
  state: row.dataset.threadState, depth: Number(row.dataset.depth), clipped: row.scrollWidth > row.clientWidth + 1,
  outside: row.getBoundingClientRect().right > row.closest('.kbn-card').getBoundingClientRect().right + 0.5,
})))

export function registerDeskThreadJourneys(test) {
  for (const [device, viewport] of [['half a screen', { width: 800, height: 1000 }], ['phone', { width: 390, height: 844 }]]) test(`The Desk shows a family's threads that need you, opens the rest on its caret and remembers it (${device})`, async page => {
    await page.goto(url)
    const card = carrier(page)
    await card.waitFor()
    const folded = await shown(card)
    assert.ok(folded.length > 0)
    // Folded, every thread drawn needs you, or stands above one that does.
    for (const [n, row] of folded.entries()) {
      const needs = row.state === 'waiting' || row.state === 'to-review'
      const context = folded.slice(n + 1).some(below => below.depth > row.depth)
      assert.ok(needs || context, `a ${row.state} thread is drawn folded without a reason`)
    }
    assert.deepEqual(folded.filter(row => row.outside || row.clipped), [], 'no thread reaches past its row')
    const count = card.locator('.kbn-thread-count')
    await count.click()
    assert.equal(await count.getAttribute('aria-expanded'), 'true')
    const open = await shown(card)
    assert.ok(open.length >= folded.length)
    assert.deepEqual(open.filter(row => row.outside || row.clipped), [], 'no thread reaches past its row')
    assert.equal(await card.locator('.kbn-desk-threads').textContent().then(text => /archived/.test(text)), false, 'archived threads stay off the Desk')
    const name = await card.getAttribute('data-card-uid')
    await page.reload()
    const again = page.locator(`.kbn-desk .kbn-card[data-card-uid="${name}"]`).first()
    await again.waitFor()
    assert.equal(await again.locator('.kbn-thread-count').getAttribute('aria-expanded'), 'true', 'the fold is remembered')
    assert.equal((await shown(again)).length, open.length)
    // A thread opens its own page, as its row would.
    const thread = again.locator('.kbn-desk-threads .kbn-thread-row').first()
    const title = await thread.locator('.kbn-thread-name').textContent()
    await thread.click()
    await page.waitForFunction(title => document.querySelector('.kbn-reader-open .ws-band-title, .kbn-reader-open .ws-page.ws-selected')?.textContent?.includes(title), title)
  }, viewport)
}
