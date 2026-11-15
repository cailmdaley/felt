import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchBrowser } from './browser.mjs'

const channels = () => [...document.querySelectorAll('.kbn-ch-pick-name')].map(el => el.textContent)
const lines = () => [...document.querySelectorAll('.kbn-ch > .kbn-ch-stream > .kbn-ch-msg')].map(el => [el.querySelector('.kbn-ch-msg-name').textContent, el.dataset.kind])
const fits = async page => {
  assert.equal(await page.locator('.kbn-channels').evaluate(el => el.scrollWidth <= el.clientWidth), true)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
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
    await page.waitForFunction(() => document.querySelectorAll('.kbn-ch-pick').length === 7)
    await page.evaluate(() => document.fonts.ready)
    // The chaired channels by name, then the lone constitutions; old notes, idle three weeks, only by Jump to.
    assert.deepEqual(await page.evaluate(channels), ['cmbx', 'Composer', 'The Mill', 'UNIONS', 'Vizier', 'Garden plan', 'Moving house'])
    if (phone) {
      // The rail is the first screen; choosing a channel fills it.
      assert.equal(await page.locator('.kbn-ch').isVisible(), false)
      await shot(page, 'phone-rail')
    }
    await page.locator('.kbn-ch-pick', { hasText: 'cmbx' }).click()
    await page.waitForFunction(() => document.querySelector('.kbn-ch-name')?.textContent === 'cmbx' && document.querySelector('.kbn-ch-tapestry'))
    if (phone) assert.equal(await page.locator('.kbn-ch-rail').isVisible(), false)
    // Each worker once, its wait or its latest; the chair in full, its tapestry among its messages; the silent beam window absent.
    await page.waitForFunction(() => document.querySelectorAll('.kbn-ch > .kbn-ch-stream > .kbn-ch-msg').length === 7)
    assert.deepEqual(await page.evaluate(lines), [
      ['cmbx chair', 'post'], ['Joint covariance', 'review'], ['κ × tSZ cross-spectrum', 'post'], ['Cluster foreground mask', 'ask'],
      ['cmbx chair', 'post'], ['You', 'reply'], ['cmbx chair', 'tapestry'],
    ])
    assert.equal(await page.locator('.kbn-ch-reply-to').first().textContent(), 'cmbx chair')
    assert.equal(await page.locator('.kbn-ch-msg', { hasText: '9σ' }).locator('.kbn-ch-image').count(), 1)
    // The stream opens on its newest message, and stays there as images arrive.
    await page.waitForFunction(() => { const el = document.querySelector('.kbn-ch > .kbn-ch-stream'); return el.scrollHeight - el.scrollTop - el.clientHeight <= 24 }, null, { timeout: 5000 })
    await fits(page)
    await shot(page, `${name}-channel`)
    // A message opens its worker's thread: its history, its liveness, a reply to it.
    await page.locator('.kbn-ch-msg', { hasText: '9σ' }).locator('.kbn-ch-replies').click()
    await page.waitForFunction(() => !document.querySelector('.kbn-ch-thread').hidden)
    assert.equal(await page.locator('.kbn-ch-liveness').textContent(), 'working')
    assert.deepEqual(await page.locator('.kbn-ch-thread-list .kbn-ch-msg-name').allTextContents(), ['κ × tSZ cross-spectrum', 'cmbx chair', 'You', 'κ × tSZ cross-spectrum'])
    assert.equal(await page.locator('.kbn-ch-thread .kbn-ch-reply-to').textContent(), 'κ × tSZ cross-spectrum')
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
      await page.keyboard.press('j'); await page.keyboard.press('j'); await page.keyboard.press('j')
      await page.waitForFunction(() => document.querySelector('.kbn-ch-name')?.textContent === 'UNIONS' && document.querySelectorAll('.kbn-ch > .kbn-ch-stream > .kbn-ch-msg').length === 13)
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
    console.log(`Channels ${name}: the recent channels in order, a short stream with each worker once and the chair's tapestry, a worker's thread, ${phone
      ? 'one screen at a time with back to the rail'
      : 'a closed thread\'s conclusion, the tapestry read in place, a busy channel ruled off since the last visit, the rail hidden and shown'}, Jump to finding a hidden channel and a document and bringing the channel back, no overflow; screenshots saved`)
  }
} finally { await browser.close() }
