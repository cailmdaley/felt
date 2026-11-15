import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchBrowser } from './browser.mjs'

const channels = () => [...document.querySelectorAll('.kbn-ch-pick-name')].map(el => el.textContent)
const lines = () => [...document.querySelectorAll('.kbn-ch > .kbn-ch-stream > .kbn-ch-msg')].map(el => [el.querySelector('.kbn-ch-msg-name')?.textContent ?? null, el.dataset.kind])
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
  await page.screenshot({ path: resolve(`../channels-${name}.png`) })
}
const browser = await launchBrowser()
try {
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
    assert.deepEqual(await page.evaluate(channels), ['cmbx', 'unions', 'vizier', 'Moving house', 'the-mill', 'french', 'science', 'Garden plan'])
    if (phone) {
      // The rail is the first screen; choosing a channel fills it.
      assert.equal(await page.locator('.kbn-ch').isVisible(), false)
    }
    await shot(page, `${name}-rail`)
    // The garden plan is dragged above French: by the mouse, or by a finger held still and then drawn.
    const from = await middle(pick(page, 'Garden plan')), to = await middle(pick(page, 'french'))
    to.y -= 6
    if (phone) await hold(page, from, to)
    else {
      await page.mouse.move(from.x, from.y); await page.mouse.down()
      for (let step = 1; step <= 10; step++) await page.mouse.move(from.x, from.y + (to.y - from.y) * step / 10)
      await page.mouse.up()
    }
    await page.waitForFunction(() => document.querySelectorAll('.kbn-ch-pick-name')[5]?.textContent === 'Garden plan')
    assert.deepEqual(await page.evaluate(channels), ['cmbx', 'unions', 'vizier', 'Moving house', 'the-mill', 'Garden plan', 'french', 'science'])
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
    await page.waitForFunction(() => document.querySelector('.kbn-ch-name')?.textContent === 'cmbx' && document.querySelector('.kbn-ch-tapestry'))
    if (phone) assert.equal(await page.locator('.kbn-ch-rail').isVisible(), false)
    // Each worker once, its latest, marked while it waits; the chair once too, by its latest line, here its tapestry; the silent beam window absent.
    await page.waitForFunction(() => document.querySelectorAll('.kbn-ch > .kbn-ch-stream > .kbn-ch-msg').length === 5)
    assert.deepEqual(await page.evaluate(lines), [
      ['Joint covariance', 'review'], ['κ × tSZ cross-spectrum', 'post'], ['Cluster foreground mask', 'ask'], ['You', 'reply'], ['cmbx chair', 'tapestry'],
    ])
    // The channel's console speaks to its chair.
    assert.equal(await page.locator('.kbn-ch > .ws-dock .ws-band-title').textContent(), 'cmbx chair')
    const spectrum = page.locator('.kbn-ch-msg[data-fiber="cmbx/kappa-tsz"]')
    assert.equal(await spectrum.locator('.kbn-ch-image').count(), 1)
    // Its deck is previewed whole, the page drawn small.
    assert.equal(await spectrum.locator('.kbn-ch-html .ws-thumbnail').count(), 1)
    // The stream opens on its newest message, and stays there as images arrive.
    await page.waitForFunction(() => { const el = document.querySelector('.kbn-ch > .kbn-ch-stream'); return el.scrollHeight - el.scrollTop - el.clientHeight <= 24 }, null, { timeout: 5000 })
    await fits(page)
    await shot(page, `${name}-channel`)
    // A message opens its worker's thread: its history, its liveness, a reply to it.
    await spectrum.locator('.kbn-ch-replies').click()
    await page.waitForFunction(() => !document.querySelector('.kbn-ch-thread').hidden)
    assert.equal(await page.locator('.kbn-ch-liveness').textContent(), 'working')
    // The thread's own worker speaks unnamed; others are named.
    assert.deepEqual(await page.locator('.kbn-ch-thread-list .kbn-ch-msg-name').allTextContents(), ['cmbx chair'])
    // The thread's console speaks to its worker, under the chair's name.
    assert.equal(await page.locator('.kbn-ch-thread > .ws-dock .ws-band-title').textContent(), 'cmbx chair / kappa-tsz')
    if (phone) assert.equal(await page.locator('.kbn-ch').isVisible(), false)
    await fits(page)
    await shot(page, `${name}-thread`)
    if (phone) {
      await page.locator('.kbn-ch-thread-close').click()
      await page.locator('.kbn-ch-back').click()
      assert.ok(await page.locator('.kbn-ch-rail').isVisible())
      await page.locator('.kbn-ch-jump').fill('old')
    } else {
      // A closed fiber's thread leads with its conclusion.
      await page.locator('.kbn-ch-msg', { hasText: 'Joint covariance' }).locator('.kbn-ch-msg-name').click()
      await page.waitForFunction(() => document.querySelector('.kbn-ch-conclusion'))
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.querySelector('.kbn-ch-thread').hidden)
      // The chair's tapestry reads whole in place.
      await page.locator('.kbn-ch-tapestry .kbn-ch-act', { hasText: 'Read it here' }).click()
      await page.waitForFunction(() => document.querySelector('.kbn-ch-tapestry-page iframe, .kbn-ch-tapestry-page .kbn-fileview'))
      await page.locator('.kbn-ch-tapestry .kbn-ch-act', { hasText: 'Fold it' }).click()
      // UNIONS, busy and last read 45 minutes ago, rules off what is new.
      await page.locator('.kbn-ch').focus()
      await page.keyboard.press('j')
      await page.waitForFunction(() => document.querySelector('.kbn-ch-name')?.textContent === 'unions' && document.querySelectorAll('.kbn-ch > .kbn-ch-stream > .kbn-ch-msg').length === 13)
      assert.equal(await page.locator('.kbn-ch-new').count(), 1)
      await shot(page, 'desktop-busy')
      await page.keyboard.press('[')
      assert.equal(await page.locator('.kbn-ch-layout[data-rail-hidden]').count(), 1)
      await page.keyboard.press('[')
      await page.keyboard.press('/')
      await page.keyboard.type('old')
    }
    // Jump to finds a channel the rail no longer lists, and the fleet's documents.
    await page.waitForFunction(() => document.querySelectorAll('.kbn-ch-pick').length === 1)
    assert.deepEqual(await page.evaluate(channels), ['Old lensing notes'])
    assert.deepEqual(await page.locator('.kbn-ch-doclist .kbn-ch-doc-name').allTextContents(), ['lensing-notes.md'])
    await shot(page, `${name}-jump`)
    await page.locator('.kbn-ch-pick').click()
    await page.waitForFunction(() => document.querySelector('.kbn-ch-name')?.textContent === 'Old lensing notes')
    if (phone) await page.locator('.kbn-ch-back').click()
    await page.locator('.kbn-ch-jump').fill('')
    await page.waitForFunction(() => document.querySelectorAll('.kbn-ch-pick').length === 8)
    assert.deepEqual(errors, [])
    await context.close()
    console.log(`Channels ${name}: the recent channels with what waits floated, a channel dragged into place, its menu, a hidden channel found by Jump to, a short stream with each worker once and the chair's tapestry, a worker's thread, ${phone
      ? 'one screen at a time with back to the rail'
      : 'a closed thread\'s conclusion, the tapestry read in place, a busy channel ruled off since the last visit, the rail hidden and shown'}, Jump to finding a hidden channel and a document and bringing the channel back, no overflow; screenshots saved`)
  }
  // Half a screen: a thread opens in the channel's place; a worker's tapestry shows under its line and in its thread.
  const context = await browser.newContext({ viewport: { width: 750, height: 900 }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${pathToFileURL(resolve('harness-board-dist/index.html'))}?example=channels#/channels`)
  await page.waitForFunction(() => document.querySelectorAll('.kbn-ch-pick').length === 8)
  await page.evaluate(() => document.fonts.ready)
  assert.equal(await page.locator('.kbn-ch-layout[data-narrow]').count(), 1)
  await shot(page, 'half-rail')
  await pick(page, 'cmbx').click()
  const spectrum = page.locator('.kbn-ch-msg', { hasText: '9σ' }).locator('.kbn-ch-embed')
  await spectrum.locator('img').waitFor()
  assert.equal(await spectrum.locator('.kbn-ch-embed-title').textContent(), 'κ × tSZ at 9σ')
  await spectrum.scrollIntoViewIfNeeded()
  await fits(page)
  await shot(page, 'half-channel')
  await page.locator('[data-item="replies:cmbx/kappa-tsz"]').click()
  await page.waitForFunction(() => !document.querySelector('.kbn-ch-thread').hidden)
  assert.equal(await page.locator('.kbn-ch').isVisible(), false)
  assert.equal(await page.locator('.kbn-ch-thread-head .kbn-ch-tip').textContent(), 'Back to # cmbx')
  assert.equal(await page.locator('.kbn-ch-thread-head .kbn-ch-embed-title').textContent(), 'κ × tSZ at 9σ')
  await fits(page)
  await shot(page, 'half-thread')
  await page.locator('.kbn-ch-thread-close').click()
  await page.waitForFunction(() => document.querySelector('.kbn-ch-thread').hidden)
  assert.ok(await page.locator('.kbn-ch').isVisible())
  // An asking worker's thread says its ask once, in its head.
  await page.locator('.kbn-ch-msg', { hasText: 'Cluster foreground mask' }).locator('.kbn-ch-msg-name').click()
  await page.waitForFunction(() => document.querySelector('.kbn-ch-thread-ask'))
  assert.equal(await page.locator('.kbn-ch-thread-list .kbn-ch-msg[data-kind="ask"]').count(), 0)
  await shot(page, 'half-ask')
  assert.deepEqual(errors, [])
  await context.close()
  console.log('Channels at half a screen: a thread in the channel\'s place with a way back, a worker\'s tapestry under its line and in its thread, an ask said once; screenshots saved')
  {
    // Unread is seen from anywhere: a fresh post in a channel not being read lights its rail dot and Channels' tab.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${pathToFileURL(resolve('harness-board-dist/index.html'))}?example=channels#/channels`)
    await page.waitForFunction(() => document.querySelectorAll('.kbn-ch-pick').length === 8)
    const tab = page.locator('.kbn-viewtab[data-view="channels"]')
    // Every wait set aside, every channel read, ending in cmbx.
    while (await page.locator('.kbn-ch-pick[data-waiting]').count()) {
      await page.locator('.kbn-ch-pick[data-waiting]').first().click({ button: 'right' })
      await page.locator('[role="menuitem"]', { hasText: 'Not now' }).click()
      await page.waitForTimeout(100)
    }
    for (const name of [...await page.evaluate(channels), 'cmbx']) { await pick(page, name).click(); await page.waitForTimeout(150) }
    assert.equal(await page.locator('.kbn-ch-pick-unread').count(), 0, 'nothing unread once each channel is read')
    await page.evaluate(() => window.__harness.modal.fetchAndRender())
    await page.waitForFunction(() => !document.querySelector('.kbn-viewtab[data-view="channels"]').hasAttribute('data-attention'))
    const post = async text => page.evaluate(text => {
      const board = window.__harness.channels.board, like = board.find(record => record.root === 'french') ?? board[0]
      board.push({ ...like, id: `brd-fresh-${board.length}`, kind: 'post', fiber: 'french', by: { fiber: 'french' }, root: 'french', timestamp: Date.now() + 1000, received_at: Date.now() + 1000, text, files: [] })
    }, text)
    // Inside Channels, on another channel: the rail's quiet dot, and the tab's.
    await post('Leçon trois est prête.')
    await page.evaluate(() => window.__harness.modal.fetchAndRender())
    await pick(page, 'french').locator('.kbn-ch-pick-unread').waitFor()
    assert.equal(await pick(page, 'french').locator('.kbn-ch-pick-mark').count(), 0, 'unread is not the owed dot of waiting')
    await page.waitForFunction(() => document.querySelector('.kbn-viewtab[data-view="channels"]').hasAttribute('data-attention'))
    await shot(page, 'unread-rail')
    await pick(page, 'french').click()
    await page.waitForFunction(() => !document.querySelector('.kbn-viewtab[data-view="channels"]').hasAttribute('data-attention'))
    // From the Desk, the channel last read included.
    await page.locator('.kbn-viewtab[data-view="desk"]').click()
    await post('Et les exercices.')
    await page.evaluate(() => window.__harness.modal.fetchAndRender())
    await page.waitForFunction(() => document.querySelector('.kbn-viewtab[data-view="channels"]').hasAttribute('data-attention'))
    await shot(page, 'unread-tab')
    assert.ok(await tab.isVisible())
    assert.deepEqual(errors, [])
    await context.close()
    console.log('Channels unread: a fresh post in a channel not being read lights its rail dot and the Channels tab, from inside Channels and from the Desk')
  }
} finally { await browser.close() }
