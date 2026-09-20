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
    if (mobile) {
      await appMark.click()
      const guide = page.getByRole('dialog', { name: 'Continue in ChatGPT' })
      assert.ok(await guide.isVisible())
      assert.match(await guide.innerText(), /ada-workstation/)
      assert.match(await guide.innerText(), /01a0be38-6c36-7cd1-aec9-53a680d1f693/)
      const box = await guide.boundingBox()
      assert.ok(box && box.x >= 0 && box.x + box.width <= 390)
      await guide.getByRole('button', { name: 'Close', exact: true }).click()
    }
    await appCard.locator('.kbn-card-name').click()
    assert.equal(await page.locator('.kbn-detail-aloft').textContent(), 'Aloft')
    if (mobile) {
      await page.locator('.kbn-detail-aloft').click()
      assert.ok(await page.getByRole('dialog', { name: 'Continue in ChatGPT' }).isVisible())
    }
    await page.close()
  }
  console.log('App Aloft marker and detail passed on desktop and phone')
} finally { await browser.close() }
