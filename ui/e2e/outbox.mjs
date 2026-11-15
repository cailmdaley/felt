import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchBrowser } from './browser.mjs'

const channels = () => [...document.querySelectorAll('.kbn-ch-pick-name')].map(el => el.textContent)
const settled = () => document.querySelector('.kbn-ch-tapestry iframe, .kbn-ch-tapestry .kbn-ch-prose')
const fits = async page => {
  assert.equal(await page.locator('.kbn-outbox').evaluate(el => el.scrollWidth <= el.clientWidth), true)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
}
const shot = async (page, name) => {
  await page.waitForFunction(settled)
  await page.evaluate(() => { for (let node = document.querySelector('.kbn-outbox'); node; node = node.parentElement) node.scrollTop = 0 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: resolve(`../channels-${name}.png`) })
}
const browser = await launchBrowser()
try {
  for (const [name, width, height] of [['desktop', 1440, 1000], ['phone', 390, 844]]) {
    const phone = name === 'phone'
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', isMobile: phone, hasTouch: phone })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${pathToFileURL(resolve('harness-board-dist/index.html'))}?example=outbox#/outbox`)
    await page.waitForFunction(() => document.querySelectorAll('.kbn-ch-pick').length === 5)
    await page.evaluate(() => document.fonts.ready)
    // Newest wait first; moving house has gone cold; the set-aside campaign and quiet work stay out.
    assert.deepEqual(await page.evaluate(channels), ['UNIONS cosmic shear', 'Vizier', 'Paper II, section 4', 'Second movement', 'Moving house'])
    assert.equal(await page.locator('.kbn-ch-shelf').textContent(), 'Gone cold')
    assert.equal(await page.locator('.kbn-ch-pick[data-cold]').count(), 1)
    if (phone) {
      // The rail is a drawer: choosing a channel puts it away, and a swipe in from the edge brings it back.
      await page.locator('.kbn-ch-pick').first().click()
      assert.equal(await page.locator('.kbn-ch-layout[data-rail-hidden]').count(), 1)
      await page.waitForFunction(() => document.querySelector('.kbn-ch-tapestry iframe'))
      // Threads first, then the tapestry.
      const [side, main] = await Promise.all(['.kbn-ch-side', '.kbn-ch-main'].map(s => page.locator(s).boundingBox()))
      assert.ok(side.y < main.y)
    }
    await page.waitForFunction(() => document.querySelector('.kbn-ch-name')?.textContent === 'UNIONS cosmic shear' && document.querySelector('.kbn-ch-tapestry iframe'))
    assert.equal(await page.locator('.kbn-ch-item').count(), 4)
    assert.deepEqual(await page.locator('.kbn-ch-item').evaluateAll(els => els.map(el => el.dataset.kind)), ['turn', 'ask', 'review', 'turn'])
    assert.equal(await page.locator('.kbn-ch-thread').count(), 4)
    assert.equal(await page.locator('.kbn-ch-file').count(), 2)
    assert.equal(await page.locator('.kbn-ch-said').count(), 1)
    assert.equal(await page.locator('.kbn-ch-reply-to').textContent(), 'UNIONS cosmic shear')
    await fits(page)
    await shot(page, name)
    // Choosing a thread swaps the tapestry and the reply's target.
    await page.locator('.kbn-ch-item[data-kind="ask"] .kbn-ch-item-pick').click()
    assert.equal(await page.locator('.kbn-ch-reply-to').textContent(), 'Choose the survey mask')
    await page.waitForFunction(() => document.querySelector('.kbn-ch-back') && document.querySelector('.kbn-ch-tapestry iframe'))
    await page.locator('.kbn-ch-back').click()
    assert.equal(await page.locator('.kbn-ch-reply-to').textContent(), 'UNIONS cosmic shear')
    if (!phone) {
      await page.locator('.kbn-ch').focus()
      await page.keyboard.press('[')
      assert.equal(await page.locator('.kbn-ch-layout[data-rail-hidden]').count(), 1)
      await fits(page)
      await shot(page, 'desktop-hidden')
      await page.locator('.kbn-ch-rail-toggle').click()
      assert.equal(await page.locator('.kbn-ch-layout[data-rail-hidden]').count(), 0)
      await page.keyboard.press('j')
      await page.waitForFunction(() => document.querySelector('.kbn-ch-name')?.textContent === 'Vizier')
    } else {
      // A real touch drawn in from the left edge brings the rail back.
      const cdp = await context.newCDPSession(page)
      const touch = async (type, x) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: 400 }] })
      await touch('touchStart', 4)
      for (const x of [40, 90, 150]) await touch('touchMove', x)
      await touch('touchEnd')
      await page.waitForFunction(() => !document.querySelector('.kbn-ch-layout[data-rail-hidden]'))
    }
    await page.locator('.kbn-ch-later').click()
    await page.waitForFunction(() => document.querySelectorAll('.kbn-ch-pick').length === 4)
    assert.deepEqual(errors, [])
    await context.close()
    console.log(`Outbox ${name}: five channels newest first with a cold shelf, a family of four waiting and four quiet threads, files, a held line and tapestry, a thread chosen and back, the rail hidden and shown, no overflow, set aside; screenshot saved`)
  }
} finally { await browser.close() }
