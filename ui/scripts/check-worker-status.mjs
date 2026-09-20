/** Run after npm run harness:board. CHROME_PATH selects Chromium. */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  for (const mobile of [false, true]) {
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1200, height: 900 }, isMobile: mobile, hasTouch: mobile })
    await page.goto(pathToFileURL(resolve('harness-board-dist/index.html')).href)
    const appCard = page.locator('.kbn-card').filter({ has: page.getByText('App conversation continuity', { exact: true }) })
    const appMark = appCard.locator('.kbn-card-worker')
    assert.equal(await appMark.textContent(), 'Aloft')
    assert.ok(await appMark.isVisible())
    await appCard.locator('.kbn-card-name').click()
    assert.equal(await page.locator('.kbn-detail-aloft').textContent(), 'Aloft')
    await page.close()
  }
  console.log('App Aloft marker and detail passed on desktop and phone')
} finally { await browser.close() }
