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
const docs = (page, selector) => page.evaluate(within => [...document.querySelectorAll(`${within} .kbn-ch-doc-name`)].map(el => el.textContent), selector)
const shot = async (page, name, prefix = 'channels') => {
  await page.waitForFunction(() => document.querySelector('.kbn-ch-tapestry iframe, .kbn-ch-tapestry .kbn-ch-prose, .kbn-ch-files:not([hidden])'))
  await page.evaluate(() => { for (let node = document.querySelector('.kbn-channels'); node; node = node.parentElement) node.scrollTop = 0 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: resolve(`../${prefix}-${name}.png`) })
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
    assert.equal(await page.locator('li.kbn-ch-shelf').textContent(), 'Gone cold')
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
      // The phone's bar has no Find: the rail's own finds channels and files.
      await page.locator('.kbn-ch-finder').fill('north')
      await page.waitForFunction(() => document.querySelectorAll('.kbn-ch-pick').length === 2)
      assert.deepEqual(await docs(page, '.kbn-ch-doclist'), ['north-mask-residuals.svg'])
      await fits(page)
      await page.waitForTimeout(400)
      await page.screenshot({ path: resolve('../library-phone.png') })
      await page.locator('.kbn-ch-finder').fill('')
    } else {
      await page.locator('.kbn-ch').focus()
      await page.keyboard.press('j')
      await page.waitForFunction(() => document.querySelector('.kbn-ch-name')?.textContent === 'Analyst')
      assert.deepEqual(await page.evaluate(lines), [
        ['Rho statistics', ''], ['Methods section', ''], ['PSF leakage', 'turn'], ['Magnitude-cut comparison', 'review'],
        ['Choose the survey mask', 'ask'], ['UNIONS cosmic shear', 'turn'], ['Covariance pipeline', ''],
      ])
      assert.equal(await page.locator('.kbn-ch-file').count(), 5)
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
      // The header shows the channel's files in the tapestry's place: each member's companions, then what its threads sent, newest first.
      assert.equal(await page.locator('.kbn-ch-finder').isVisible(), false)
      await page.locator('.kbn-ch-tab', { hasText: 'Files' }).click()
      await page.waitForFunction(() => document.querySelectorAll('.kbn-ch-files .kbn-ch-doc').length === 7)
      const files = await docs(page, '.kbn-ch-files')
      assert.deepEqual(files.slice(0, 2), ['Tapestry', 'Tapestry'])
      assert.equal(files[2], 'covariance-blocks.svg')
      assert.ok(files.includes('north-mask-residuals.svg') && files.includes('psf-leakage.md'))
      await fits(page)
      await shot(page, 'files', 'library')
      // A file opens in the reader; closing it comes back to the channel, and Read lately keeps it.
      await page.locator('.kbn-ch-files .kbn-ch-doc', { hasText: 'north-mask-residuals.svg' }).click()
      await page.waitForFunction(() => document.querySelector('.ws-selected')?.getAttribute('data-key')?.endsWith('north-mask-residuals.svg'))
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => document.querySelector('.kbn-ch-name')?.textContent === 'UNIONS cosmic shear' || document.querySelector('.kbn-ch-name')?.textContent === 'Analyst')
      assert.equal(new URL(page.url()).hash, '#/channels')
      assert.deepEqual(await docs(page, '.kbn-ch-lately'), ['Choose the survey mask'])
      // The bar's Find reaches every channel by its members and its files, and the files themselves.
      await page.locator('.kbn-viewtabs-find input').fill('north')
      await page.waitForFunction(() => document.querySelectorAll('.kbn-ch-pick').length === 2)
      assert.deepEqual(await page.evaluate(channels), ['Analyst', 'Surveyor'])
      assert.deepEqual(await docs(page, '.kbn-ch-doclist'), ['north-mask-residuals.svg'])
      await page.locator('.kbn-ch-tab', { hasText: 'Tapestry' }).click()
      await fits(page)
      await shot(page, 'desktop', 'library')
      // A quiet channel found is read in place, and pinned from its header.
      await page.locator('.kbn-ch-pick', { hasText: 'Surveyor' }).click()
      await page.waitForFunction(() => document.querySelector('.kbn-ch-name')?.textContent === 'Surveyor')
      await page.locator('.kbn-ch-pin').click()
      await page.locator('.kbn-viewtabs-find input').press('Escape')
      await page.waitForFunction(() => document.querySelectorAll('.kbn-ch-pick').length === 7)
    }
    await page.locator('.kbn-ch-pick', { hasText: 'Editor' }).click()
    await page.locator('.kbn-ch-later').click()
    await page.waitForFunction(() => ![...document.querySelectorAll('.kbn-ch-pick-name')].some(el => el.textContent === 'Editor'))
    assert.deepEqual(errors, [])
    await context.close()
    console.log(`Channels ${name}: six channels in order with a pinned one and a cold shelf, the vizier office as one channel, ${phone
      ? 'the rail a drawer put away and swiped back, the rail\'s own Find across channels and files'
      : 'lines oldest first with their files and held line, a line chosen and back, the rail hidden and shown, a channel\'s files opened in the reader and back, the bar\'s Find across channels and files, a found channel pinned'}, no overflow, set aside; screenshots saved`)
  }
} finally { await browser.close() }
