import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchBrowser } from './browser.mjs'

const offices = () => [...document.querySelectorAll('.kbn-aud-office-name')].map(el => el.textContent)
const browser = await launchBrowser()
try {
  for (const [name, width, height] of [['desktop', 1440, 1000], ['phone', 390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', isMobile: name === 'phone', hasTouch: name === 'phone' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${pathToFileURL(resolve('harness-board-dist/index.html'))}?example=outbox#/outbox`)
    await page.waitForFunction(() => document.querySelectorAll('.kbn-aud-office').length === 4 && document.querySelector('.kbn-aud-tapestry iframe, .kbn-aud-tapestry .kbn-aud-prose'))
    await page.evaluate(() => document.fonts.ready)
    // Longest waiting first; the set-aside surveyor and the quiet composer stay out.
    assert.deepEqual(await page.evaluate(offices), ['Moving house', 'Analyst', 'Editor', 'Vizier'])
    assert.equal(await page.locator('.kbn-audience').evaluate(el => el.scrollWidth <= el.clientWidth), true)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    await page.keyboard.press('j')
    await page.waitForFunction(() => document.querySelector('.kbn-aud-name')?.textContent === 'Analyst' && document.querySelector('.kbn-aud-tapestry iframe'))
    assert.equal(await page.locator('.kbn-aud-block').count(), 2)
    assert.equal(await page.locator('.kbn-aud-thread').count(), 2)
    assert.equal(await page.locator('.kbn-aud-file').count(), 2)
    assert.equal(await page.locator('.kbn-aud-said').count(), 1)
    await page.waitForTimeout(400)
    await page.screenshot({ path: resolve(`../audience-${name}.png`) })
    await page.locator('.kbn-aud-later').click()
    await page.waitForFunction(() => document.querySelectorAll('.kbn-aud-office').length === 3)
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('kbn-aud-reply-text')), true)
    assert.deepEqual(errors, [])
    await context.close()
    console.log(`Outbox ${name}: four offices oldest first, letter with two blocks, threads, files, held line and tapestry, no overflow, set aside; screenshot saved`)
  }
} finally { await browser.close() }
