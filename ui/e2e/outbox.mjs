import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchBrowser } from './browser.mjs'

const browser = await launchBrowser()
try {
  for (const [name, width, height] of [['desktop', 1440, 1000], ['phone', 390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', isMobile: name === 'phone', hasTouch: name === 'phone' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${pathToFileURL(resolve('harness-board-dist/index.html'))}?example=outbox#/outbox`)
    await page.waitForFunction(() => document.querySelectorAll('.kbn-outbox-row').length === 8)
    await page.evaluate(() => document.fonts.ready)
    const names = await page.locator('.kbn-outbox-name').allTextContents()
    assert.equal(names.filter(name => name === 'Shear null tests').length, 4)
    assert(!names.includes('A dismissed question'))
    assert.equal(await page.locator('.kbn-outbox').evaluate(el => el.scrollWidth <= el.clientWidth), true)
    await page.screenshot({ path: resolve(`../outbox-${name}.png`) })
    await page.locator('.kbn-outbox-open').filter({ hasText: '.png' }).click()
    await page.waitForFunction(() => document.querySelector('.ws-reader img')?.complete || document.querySelector('.ws-reader [data-kind="image"]'))
    await page.keyboard.press('5')
    await page.waitForSelector('.kbn-outbox-row')
    await page.locator('.kbn-outbox-dismiss').first().click()
    await page.waitForFunction(() => document.querySelectorAll('.kbn-outbox-row').length === 7)
    assert.deepEqual(errors, [])
    await context.close()
    console.log(`Outbox ${name}: 8 items, dismissed item absent, no overflow, image opens, dismissal persists; screenshot saved`)
  }
} finally { await browser.close() }
