/** Run after npm run harness:board. CHROME_PATH selects Chromium. */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  for (const mobile of [false, true]) {
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1200, height: 900 }, isMobile: mobile, hasTouch: mobile })
    const harness = pathToFileURL(resolve('harness-board-dist/index.html')).href
    await page.route('https://chatgpt.com/open-app', route => route.fulfill({ contentType: 'text/html', body: '<p>App-opening destination</p>' }))
    await page.goto(harness)
    const appCard = page.locator('.kbn-card').filter({ has: page.getByText('App conversation continuity', { exact: true }) })
    const appMark = appCard.locator('.kbn-card-worker')
    assert.equal(await appMark.textContent(), 'Aloft')
    assert.ok(await appMark.isVisible())
    const destination = mobile ? 'https://chatgpt.com/open-app' : 'codex://threads/01a0be38-6c36-7cd1-aec9-53a680d1f693'
    assert.equal(await appMark.getAttribute('href'), destination)
    if (mobile) {
      await appMark.click()
      await page.waitForURL(destination)
      await page.goto(harness)
    }
    await appCard.locator('.kbn-card-name').click()
    assert.equal(await page.locator('.kbn-detail-aloft').textContent(), 'Aloft')
    assert.equal(await page.locator('.kbn-detail-aloft').getAttribute('href'), destination)
    if (mobile) {
      assert.match(await page.locator('.kbn-detail-app-guide').innerText(), /Remote → ada-workstation → loom/)
      assert.equal(await page.locator('.kbn-detail-aloft').getAttribute('aria-label'), 'Open ChatGPT app')
      await page.locator('.kbn-detail-aloft').click()
      await page.waitForURL(destination)
    }
    await page.close()
  }
  console.log('App Aloft marker and detail passed on desktop and phone')
} finally { await browser.close() }
