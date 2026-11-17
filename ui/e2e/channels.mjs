import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchBrowser } from './browser.mjs'

const channels = () => [...document.querySelectorAll('.kbn-ch-pick-name')].map(el => el.textContent)
/** The stream: each item's slug and kind, each station's slug and what it marks (start, tick, end:<verdict>). */
const lines = () => [...document.querySelectorAll('.kbn-ch > .kbn-ch-stream > li[data-slug]')].map(el => [el.dataset.slug, el.dataset.kind ?? el.dataset.what])
const fits = async page => {
  assert.equal(await page.locator('.kbn-channels').evaluate(el => el.scrollWidth <= el.clientWidth), true)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
}
const pick = (page, name) => page.locator('.kbn-ch-pick', { has: page.locator('.kbn-ch-pick-name', { hasText: new RegExp(`^${name}$`) }) })
const middle = async locator => { const box = await locator.boundingBox(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 } }
/** A finger held still on `from` until it is picked up, then drawn to `to` and lifted; without `to`, lifted where it held. */
const hold = async (page, from, to) => {
  const cdp = await page.context().newCDPSession(page)
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points })
  await touch('touchStart', [from])
  await page.waitForTimeout(600)
  for (let step = 1; to && step <= 12; step++) {
    await touch('touchMove', [{ x: from.x + (to.x - from.x) * step / 12, y: from.y + (to.y - from.y) * step / 12 }])
    await page.waitForTimeout(30)
  }
  await touch('touchEnd', [])
  await cdp.detach()
}
const shot = async (page, name) => {
  await page.waitForTimeout(400)
  await page.screenshot({ path: resolve(process.env.CHANNELS_SHOTS ?? tmpdir(), `channels-${name}.png`) })
}
const browser = await launchBrowser()
try {
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    await page.goto(`${pathToFileURL(resolve('harness-board-dist/index.html'))}?example=channels#/channels`)
    await page.locator('.kbn-ch-jump').fill('compo')
    await pick(page, 'composer').click()
    await page.waitForFunction(() => document.querySelector('.kbn-ch-name')?.textContent === 'composer')
    assert.equal(await page.locator('.kbn-ch > .ws-dock .ws-band-title').textContent(), 'score')
    assert.equal(await page.locator('.kbn-ch > .ws-dock .ws-worker-message').getAttribute('data-placeholder'), 'Message score')
    await shot(page, 'seatless-office')
    await context.close()
  }
  for (const [name, width, height] of [['desktop', 1440, 900], ['phone', 390, 844]]) {
    const phone = name === 'phone'
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', isMobile: phone, hasTouch: phone })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${pathToFileURL(resolve('harness-board-dist/index.html'))}?example=channels#/channels`)
    await page.waitForFunction(() => document.querySelectorAll('.kbn-ch-pick').length === 8)
    await page.evaluate(() => document.fonts.ready)
    // What waits on the human, the newest wait first, then the human's order; the hidden composer and old notes, idle three weeks, only by Jump to.
    // The Mill's workers are idle at the end of their turns: that waits on no one, so it keeps its place in the order.
    assert.deepEqual(await page.evaluate(channels), ['cmbx', 'unions', 'vizier', 'move', 'felt', 'french', 'science', 'garden'])
    if (phone) {
      // The rail is the first screen; choosing a channel fills it.
      assert.equal(await page.locator('.kbn-ch').isVisible(), false)
    }
    await shot(page, `${name}-rail`)
    // The garden plan is dragged above French: by the mouse, or by a finger held still and then drawn.
    const from = await middle(pick(page, 'garden')), to = await middle(pick(page, 'french'))
    to.y -= 6
    if (phone) await hold(page, from, to)
    else {
      await page.mouse.move(from.x, from.y); await page.mouse.down()
      for (let step = 1; step <= 10; step++) await page.mouse.move(from.x, from.y + (to.y - from.y) * step / 10)
      await page.mouse.up()
    }
    await page.waitForFunction(() => document.querySelectorAll('.kbn-ch-pick-name')[5]?.textContent === 'garden')
    assert.deepEqual(await page.evaluate(channels), ['cmbx', 'unions', 'vizier', 'move', 'felt', 'garden', 'french', 'science'])
    // The drag opened nothing and asked for no menu.
    assert.equal(await page.locator('[role="menu"]').count(), 0)
    if (phone) assert.equal(await page.locator('.kbn-ch').isVisible(), false)
    // A right-click, or a finger held and lifted, opens an entry's menu; Hide takes it out of the rail.
    if (phone) await hold(page, await middle(pick(page, 'science')))
    else await pick(page, 'science').click({ button: 'right' })
    await page.waitForFunction(() => document.querySelectorAll('[role="menuitem"]').length === 3)
    assert.deepEqual(await page.locator('[role="menuitem"]').allTextContents(), ['Hide', 'Pin', 'Move to bottom'])
    await shot(page, `${name}-rail-menu`)
    await page.locator('[role="menuitem"]', { hasText: 'Hide' }).click()
    await page.waitForFunction(() => document.querySelectorAll('.kbn-ch-pick').length === 7)
    // Jump to finds a hidden channel, marked as such.
    await page.locator('.kbn-ch-jump').fill('compo')
    await page.waitForFunction(() => document.querySelectorAll('.kbn-ch-pick').length === 1)
    assert.deepEqual(await page.evaluate(channels), ['composer'])
    assert.equal(await page.locator('.kbn-ch-pick-hidden').textContent(), 'hidden')
    await shot(page, `${name}-jump-hidden`)
    await page.locator('.kbn-ch-jump').fill('')
    await page.waitForFunction(() => document.querySelectorAll('.kbn-ch-pick').length === 7)
    await pick(page, 'cmbx').click()
    await page.waitForFunction(() => document.querySelector('.kbn-ch-name')?.textContent === 'cmbx' && document.querySelector('.kbn-ch-item'))
    if (phone) assert.equal(await page.locator('.kbn-ch-rail').isVisible(), false)
    // Everything its workers addressed to the human, with its threads' lives drawn as lines between.
    await page.waitForFunction(() => document.querySelectorAll('.kbn-ch > .kbn-ch-stream > .kbn-ch-item').length === 5)
    const said = await page.evaluate(lines)
    assert.deepEqual(said.filter(([, kind]) => ['ask', 'post', 'close', 'file'].includes(kind)), [['covariance', 'file'], ['covariance', 'close'], ['kappa-tsz', 'post'], ['foregrounds', 'ask'], ['cmbx', 'post']])
    // Closed to its chair, then marked for the human's review: an item, and its line's end.
    assert.ok(said.some(([who, what]) => who === 'covariance' && what === 'end:closed'), 'the close ends its line')
    assert.ok(said.some(([who, what]) => who === 'beam' && what === 'start'), 'the silent beam window shows only as its line')
    // A post's head names its thread and says no word the stream already implies; a question says it asks.
    assert.equal(await page.locator('.kbn-ch-item[data-fiber="cmbx/kappa-tsz"] .kbn-ch-who').textContent(), 'kappa-tsz')
    assert.equal(await page.locator('.kbn-ch-item[data-fiber="cmbx/kappa-tsz"] .kbn-ch-kind').count(), 0)
    assert.equal(await page.locator('.kbn-ch-item[data-kind="ask"] .kbn-ch-kind').textContent(), 'asks')
    // The channel's head carries its chair's pages; its console speaks to its chair, by slugs.
    assert.ok(await page.locator('.kbn-ch-head .kbn-ch-pages [data-part="constitution"]').isVisible())
    assert.equal(await page.locator('.kbn-ch > .ws-dock .ws-band-title').textContent(), 'cmbx')
    assert.equal(await page.locator('.kbn-ch > .ws-dock .ws-worker-message').getAttribute('data-placeholder'), 'Message cmbx')
    // Its post carries the deck, the plot and the notes it attached, each at its density's box in a row that wraps:
    // a page 480 by 270, a figure 480 by 360, a card 360 by 56, never wider than the row.
    const kappa = page.locator('.kbn-ch-item[data-fiber="cmbx/kappa-tsz"]')
    assert.equal(await kappa.locator('.kbn-ch-previews .uf-card').count(), 3)
    const rowWidth = (await kappa.locator('.uf-row').boundingBox()).width
    const boxes = await kappa.locator('.uf-card').evaluateAll(cards => cards.map(card => [card.dataset.density, Math.round(card.getBoundingClientRect().width), Math.round(card.getBoundingClientRect().height)]))
    // Narrower than its box, a figure or a page keeps its proportions, a card its height.
    const box = (density, width, height) => { const drawn = Math.min(width, Math.round(rowWidth)); return [density, drawn, density === 'card' ? height : Math.round(drawn * height / width)] }
    assert.deepEqual(boxes.map(([density, width, height]) => [density, width, height]), [box('page', 480, 270), box('figure', 480, 360), box('card', 360, 56)])
    // The close for review says its review note, never its outcome.
    assert.match(await page.locator('.kbn-ch-item[data-kind="close"] .kbn-ch-item-text').textContent(), /agree to 4%/)
    assert.equal(await page.locator('.kbn-ch-stream').getByText('validated against 2000 simulations').count(), 0)
    // The stream opens on its newest item.
    await page.waitForFunction(() => { const el = document.querySelector('.kbn-ch > .kbn-ch-stream'); return el.scrollHeight - el.scrollTop - el.clientHeight <= 24 }, null, { timeout: 5000 })
    await fits(page)
    await shot(page, `${name}-channel`)
    // A click unfolds it in place, opening nothing; → steps to the next file, Escape folds it back.
    await kappa.locator('.uf-card').first().click()
    await page.waitForFunction(() => document.querySelector('.kbn-ch-item[data-fiber="cmbx/kappa-tsz"] .kbn-ch-previews[data-unfolded] .uf-count')?.textContent === '1 / 3')
    assert.equal(await page.locator('.ws-selected').count(), 0, 'unfolding opens no view')
    await shot(page, `${name}-unfolded`)
    await page.keyboard.press('ArrowRight')
    await page.waitForFunction(() => document.querySelector('.kbn-ch-item[data-fiber="cmbx/kappa-tsz"] .uf-count')?.textContent === '2 / 3')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('.kbn-ch-item[data-fiber="cmbx/kappa-tsz"] .kbn-ch-previews[data-unfolded]'))
    // An item opens its constitution's view in the reader.
    await page.locator('.kbn-ch-item[data-kind="ask"] .kbn-ch-who').click()
    await page.waitForFunction(() => document.querySelector('.ws-selected .ov-name')?.textContent === 'foregrounds')
    assert.equal(await page.locator('.ws-selected .ov-needs').textContent(), 'asks')
    await shot(page, `${name}-view`)
    // A view's sent files: the button opens the newest, and ← and → step among them in its place.
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelector('.kbn-ch-name')?.textContent === 'cmbx' && document.querySelector('.kbn-ch').offsetParent)
    await page.locator('.kbn-ch-item[data-fiber="cmbx/kappa-tsz"] .kbn-ch-who').click()
    await page.waitForFunction(() => document.querySelector('.ws-selected .ov-name')?.textContent === 'kappa-tsz')
    await page.locator('.ws-selected .ov-head [data-part="sends"]').click()
    await page.waitForFunction(() => document.querySelectorAll('.kbn-conversation-menu .uf-file-row').length === 3)
    await shot(page, `${name}-sends-list`)
    // A row of the list unfolds that file in the view, where ← and → step among them.
    await page.locator('.kbn-conversation-menu .uf-file-row').first().click()
    const viewCount = () => page.waitForFunction(() => document.querySelector('.ws-selected .uf-count')?.textContent).then(h => h.jsonValue())
    const [at, of] = (await viewCount()).split(' / ').map(Number)
    assert.ok(at < of, 'the first row is not the last file')
    await page.keyboard.press('ArrowRight')
    await page.waitForFunction(want => document.querySelector('.ws-selected .uf-count')?.textContent === want, `${at + 1} / ${of}`)
    await shot(page, `${name}-sends`)
    // Escape folds the file, and the next leaves the view: one step back to Channels.
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.querySelector('.kbn-ch-name')?.textContent === 'cmbx' && document.querySelector('.kbn-ch').offsetParent)
    if (phone) {
      await page.locator('.kbn-ch-back').click()
      assert.ok(await page.locator('.kbn-ch-rail').isVisible())
      await page.locator('.kbn-ch-jump').fill('old')
    } else {
      // UNIONS, busy: its items and the lines of its many threads, a dozen running at once.
      await page.locator('.kbn-ch').focus()
      await page.keyboard.press('j')
      await page.waitForFunction(() => document.querySelector('.kbn-ch-name')?.textContent === 'unions')
      // A dozen threads' posts to the human through the day, a hub's figure, its chair's round, and a thread's question.
      await page.waitForFunction(() => document.querySelectorAll('.kbn-ch > .kbn-ch-stream > .kbn-ch-item').length === 14)
      // The chains thread's second post, three minutes after its first, groups under its head.
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.kbn-ch-item[data-grouped]')].map(el => el.dataset.slug)), ['chains'])
      // A dozen lines at once in one margin of fine ink, 56px wide, a few fibres at any height and the rest on the strand.
      assert.equal(await page.locator('.kbn-ch-margin > .kbn-ch-ink').getAttribute('width'), '56')
      // Its ink costs a few milliseconds a painting (about 3 on a laptop); the bound leaves room for a slow runner.
      const inked = await page.evaluate(() => performance.getEntriesByName('kbn-ch-ink').map(each => each.duration))
      assert.ok(inked.length && Math.max(...inked.slice(1)) < 30, `margin paintings took ${inked.map(ms => ms.toFixed(1)).join(', ')}ms`)
      // The ring counts the threads with a live worker, and its list names exactly them, one thread row each, what waits first:
      // not the seats at rest, the standing digest between runs, the draft or the thread put to rest.
      await page.locator('.kbn-ch-count-ring').click()
      await page.waitForFunction(() => document.querySelectorAll('[role="menuitem"]').length > 0)
      const listed = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"] .thread-row-slug')].map(el => el.textContent))
      assert.equal(listed.length, Number(await page.locator('.kbn-ch-count-ring').textContent()))
      assert.deepEqual([...listed].sort(), ['blinding', 'bmodes', 'chains', 'depth', 'east', 'ia', 'paper', 'photoz', 'psf', 'rho', 'shear-2pt', 'unions', 'west'])
      const attention = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"] .thread-row')].map(row => row.dataset.attention))
      assert.deepEqual(attention, [...attention].sort((a, b) => Number(a !== 'waiting') - Number(b !== 'waiting')))
      await shot(page, 'desktop-bundle-menu')
      await page.keyboard.press('Escape')
      await shot(page, 'desktop-busy')
      await page.keyboard.press('[')
      assert.equal(await page.locator('.kbn-ch-layout[data-rail-hidden]').count(), 1)
      await page.keyboard.press('[')
      await page.keyboard.press('/')
      await page.keyboard.type('old')
    }
    // Jump to finds a channel the rail no longer lists, and the fleet's documents.
    await page.waitForFunction(() => document.querySelectorAll('.kbn-ch-pick').length === 1)
    assert.deepEqual(await page.evaluate(channels), ['old-notes'])
    assert.deepEqual(await page.locator('.kbn-ch-doclist .kbn-ch-doc-name').allTextContents(), ['lensing-notes.md'])
    await shot(page, `${name}-jump`)
    await page.locator('.kbn-ch-pick').click()
    await page.waitForFunction(() => document.querySelector('.kbn-ch-name')?.textContent === 'old-notes')
    if (phone) await page.locator('.kbn-ch-back').click()
    await page.locator('.kbn-ch-jump').fill('')
    // The rail lists the channel being read; on a phone, back on the rail, none is.
    await page.waitForFunction(n => document.querySelectorAll('.kbn-ch-pick').length === n, phone ? 7 : 8)
    assert.deepEqual(errors, [])
    await context.close()
    console.log(`Channels ${name}: the recent channels with what waits floated, a channel dragged into place, its menu, a hidden channel found by Jump to, a stream of what was addressed to the human beside its threads' lines, an item opening its constitution's view, ${phone
      ? 'one screen at a time with back to the rail'
      : 'a busy channel, the rail hidden and shown'}, Jump to finding a hidden channel and a document and bringing the channel back, no overflow; screenshots saved`)
  }
  // Half a screen: the rail is a drawer over the stream.
  const context = await browser.newContext({ viewport: { width: 750, height: 900 }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${pathToFileURL(resolve('harness-board-dist/index.html'))}?example=channels#/channels`)
  await page.waitForFunction(() => document.querySelectorAll('.kbn-ch-pick').length === 8)
  await page.evaluate(() => document.fonts.ready)
  // Half a screen, the rail is a drawer, put away until it is asked for; it ends above the console.
  assert.equal(await page.locator('.kbn-ch-rail').isVisible(), false)
  await page.locator('.kbn-ch-rail-toggle').click()
  await page.locator('.kbn-ch-rail').waitFor({ state: 'visible' })
  const [rail, dock] = await Promise.all([page.locator('.kbn-ch-rail').boundingBox(), page.locator('.kbn-ch > .ws-dock').boundingBox()])
  assert.ok(Math.abs(rail.y + rail.height - dock.y) <= 1)
  await shot(page, 'half-rail')
  await pick(page, 'cmbx').click()
  await page.locator('.kbn-ch-rail').waitFor({ state: 'hidden' })
  await page.locator('.kbn-ch-item[data-fiber="cmbx/kappa-tsz"] .uf-card').first().waitFor()
  await fits(page)
  await shot(page, 'half-channel')
  assert.deepEqual(errors, [])
  await context.close()
  console.log('Channels at half a screen: the rail a drawer ending above the console, the stream full width; screenshots saved')
  {
    // Something fresh addressed to the human in a channel not being read lights its rail dot; reading it clears it.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${pathToFileURL(resolve('harness-board-dist/index.html'))}?example=channels#/channels`)
    await page.waitForFunction(() => document.querySelectorAll('.kbn-ch-pick').length === 8)
    // Every channel read, ending in cmbx.
    for (const name of [...await page.evaluate(channels), 'cmbx']) { await pick(page, name).click(); await page.waitForTimeout(150) }
    assert.equal(await page.locator('.kbn-ch-pick-unread').count(), 0, 'nothing unread once each channel is read')
    const post = async text => page.evaluate(text => {
      const board = window.__harness.channels.board, like = board.find(record => record.root === 'french') ?? board[0]
      board.push({ ...like, id: `brd-fresh-${board.length}`, kind: 'post', fiber: 'french', by: { fiber: 'french' }, to: { label: 'Sam' }, root: 'french', timestamp: Date.now() + 1000, received_at: Date.now() + 1000, text, files: [] })
    }, text)
    // On another channel: the rail's quiet dot.
    await post('Leçon trois est prête.')
    await page.evaluate(() => window.__harness.modal.fetchAndRender())
    await pick(page, 'french').locator('.kbn-ch-pick-unread').waitFor()
    assert.equal(await pick(page, 'french').locator('.kbn-ch-pick-mark').count(), 0, 'unread is not the owed dot of waiting')
    await shot(page, 'unread-rail')
    await pick(page, 'french').click()
    await pick(page, 'french').locator('.kbn-ch-pick-unread').waitFor({ state: 'detached' })
    assert.deepEqual(errors, [])
    await context.close()
    console.log('Channels unread: something fresh addressed to the human in a channel not being read lights its rail dot, and reading it clears the dot')
  }
  {
    // A close to the human with its closing post: the stream draws its tapestry, and neither it nor the view draws the outcome.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${pathToFileURL(resolve('harness-board-dist/index.html'))}?example=channels#/channels`)
    await pick(page, 'vizier').click()
    const close = page.locator('.kbn-ch-item[data-fiber="morning-post"]')
    await close.locator('.kbn-ch-previews .uf-card[data-key$="/tapestry.html"] .ws-thumbnail').waitFor()
    // The tapestry leads its previews, before the file the close attached.
    assert.match(await close.locator('.kbn-ch-previews .uf-card').first().getAttribute('data-key'), /tapestry\.html$/)
    const outcome = 'Eleven letters sorted'
    assert.equal(await close.getByText(outcome).count(), 0)
    await close.locator('.kbn-ch-who').click()
    await page.waitForFunction(() => document.querySelector('.ws-selected .ov-name')?.textContent === 'morning-post')
    await page.locator('.ws-selected .ov-unfold .ws-thumbnail').waitFor()
    assert.equal(await page.locator('.ws-selected .ws-family-page').getByText(outcome).count(), 0)
    assert.deepEqual(errors, [])
    await context.close()
    console.log('Channels close: its tapestry drawn, its outcome nowhere, in the stream or its view')
  }
} finally { await browser.close() }
