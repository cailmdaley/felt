import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchBrowser } from './browser.mjs'

const channels = () => [...document.querySelectorAll('.kbn-ch-pick-name')].map(el => el.textContent)
const lines = () => [...document.querySelectorAll('.kbn-ch-msg')].map(el => [el.querySelector('.kbn-ch-msg-name').textContent, el.dataset.kind ?? ''])
const fits = async page => {
  assert.equal(await page.locator('.kbn-channels').evaluate(el => el.scrollWidth <= el.clientWidth), true)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
}
const shot = async (page, name) => {
  await page.waitForFunction(() => document.querySelector('.kbn-ch-tapestry iframe, .kbn-ch-tapestry .kbn-ch-prose'))
  await page.evaluate(() => { for (let node = document.querySelector('.kbn-channels'); node; node = node.parentElement) node.scrollTop = 0 })
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
    await page.goto(`${pathToFileURL(resolve('harness-board-dist/index.html'))}?example=channels#/channels`)
    await page.waitForFunction(() => document.querySelectorAll('.kbn-ch-pick').length === 6)
    await page.evaluate(() => document.fonts.ready)
    // Newest wait first, then the pinned garden, then moving house gone cold; the set-aside surveyor stays out.
    assert.deepEqual(await page.evaluate(channels), ['Vizier', 'Analyst', 'Editor', 'Composer', 'Garden plan', 'Moving house'])
    assert.equal(await page.locator('.kbn-ch-shelf').textContent(), 'Gone cold')
    // The vizier office's four top-levels are one channel, its seat's tapestry pinned and replied to.
    if (phone) {
      // The rail is a drawer: choosing a channel puts it away.
      await page.locator('.kbn-ch-pick').first().click()
      assert.equal(await page.locator('.kbn-ch-layout[data-rail-hidden]').count(), 1)
    }
    await page.waitForFunction(() => document.querySelector('.kbn-ch-name')?.textContent === 'Vizier' && document.querySelector('.kbn-ch-tapestry iframe'))
    assert.deepEqual(await page.evaluate(lines), [['Morning post', 'review'], ['Sign the deed form', 'ask'], ['Vizier', 'turn']])
    assert.equal(await page.locator('.kbn-ch-reply-to').textContent(), 'Vizier')
    await fits(page)
    if (phone) {
      // The lines and the reply come before the tapestry.
      const [talk, canvas] = await Promise.all(['.kbn-ch-talk', '.kbn-ch-canvas'].map(s => page.locator(s).boundingBox()))
      assert.ok(talk.y < canvas.y)
      await shot(page, 'phone')
      // A real touch drawn rightward across the lines brings the rail back.
      const cdp = await context.newCDPSession(page)
      const { x, y } = await page.locator('.kbn-ch-msg').first().boundingBox()
      const touch = async (type, at) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: x + at, y: y + 10 }] })
      await touch('touchStart', 20)
      for (const at of [60, 110, 170]) await touch('touchMove', at)
      await touch('touchEnd')
      await page.waitForFunction(() => !document.querySelector('.kbn-ch-layout[data-rail-hidden]'))
    } else {
      await page.locator('.kbn-ch').focus()
      await page.keyboard.press('j')
      await page.waitForFunction(() => document.querySelector('.kbn-ch-name')?.textContent === 'Analyst')
      assert.deepEqual(await page.evaluate(lines), [
        ['Rho statistics', ''], ['Methods section', ''], ['PSF leakage', 'turn'], ['Magnitude-cut comparison', 'review'],
        ['Choose the survey mask', 'ask'], ['UNIONS cosmic shear', 'turn'], ['Covariance pipeline', ''],
      ])
      assert.equal(await page.locator('.kbn-ch-file').count(), 2)
      assert.equal(await page.locator('.kbn-ch-said').count(), 1)
      // The analyst's seat is its one top-level; a thread's own office is its label.
      assert.equal(await page.locator('.kbn-ch-reply-to').textContent(), 'UNIONS cosmic shear')
      assert.equal(await page.locator('.kbn-ch-msg-role').textContent(), 'Editor')
      await shot(page, 'desktop')
      // Choosing a line swaps the tapestry and the reply's target, and shows its actions.
      await page.locator('.kbn-ch-msg[data-kind="review"] .kbn-ch-msg-pick').click()
      assert.equal(await page.locator('.kbn-ch-reply-to').textContent(), 'Magnitude-cut comparison')
      assert.equal(await page.locator('.kbn-ch-msg[data-chosen] .kbn-ch-act').evaluateAll(els => els.map(el => el.textContent)).then(words => words.join(' ')), 'Open Temper')
      await page.locator('.kbn-ch-back').click()
      assert.equal(await page.locator('.kbn-ch-reply-to').textContent(), 'UNIONS cosmic shear')
      await page.locator('.kbn-ch').focus()
      await page.keyboard.press('[')
      assert.equal(await page.locator('.kbn-ch-layout[data-rail-hidden]').count(), 1)
      await fits(page)
      await shot(page, 'desktop-hidden')
      await page.locator('.kbn-ch-rail-toggle').click()
      // Adding a channel pins it.
      await page.locator('.kbn-ch-finder').fill('north')
      assert.equal(await page.locator('.kbn-ch-found-pick').textContent(), 'Surveyor')
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => document.querySelector('.kbn-ch-name')?.textContent === 'Surveyor')
      assert.equal(await page.locator('.kbn-ch-pick').count(), 7)
    }
    await page.locator('.kbn-ch-pick', { hasText: 'Editor' }).click()
    await page.locator('.kbn-ch-later').click()
    await page.waitForFunction(() => ![...document.querySelectorAll('.kbn-ch-pick-name')].some(el => el.textContent === 'Editor'))
    assert.deepEqual(errors, [])
    await context.close()
    console.log(`Channels ${name}: six channels in order with a pinned one and a cold shelf, the vizier office as one channel, lines oldest first with their files and held line, a line chosen and back, the rail hidden and shown, a channel added, no overflow, set aside; screenshots saved`)
  }
} finally { await browser.close() }
