/** Run after npm run harness:board. CHROME_PATH selects Chromium. */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
try {
  for (const mobile of [false, true]) {
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1200, height: 900 }, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' })
    const harness = pathToFileURL(resolve('harness-board-dist/index.html')).href
    await page.route('https://chatgpt.com/open-app', route => route.fulfill({ contentType: 'text/html', body: '<p>App-opening destination</p>' }))
    await page.goto(harness)
    const appCard = page.locator('.kbn-card').filter({ has: page.getByText('App conversation continuity', { exact: true }) })
    const appMark = appCard.locator('.kbn-card-worker')
    assert.equal(await appMark.textContent(), 'Aloft')
    assert.ok(await appMark.isVisible())
    // Compare the real app anchor against the existing terminal button styles.
    await appMark.evaluate(anchor => {
      const original = anchor.className
      const typography = ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'textTransform']
      const baseline = {}
      const button = document.createElement('button')
      button.textContent = 'Aloft'
      anchor.after(button)
      anchor.className = 'kbn-card-worker kbn-card-worker-link kbn-card-worker-aloft'
      for (const property of typography) baseline[property] = getComputedStyle(anchor)[property]
      for (const variant of ['aloft', 'waiting', 'attention', 'blocked']) {
        anchor.className = `kbn-card-worker kbn-card-worker-link kbn-card-worker-${variant}`
        button.className = `kbn-card-worker kbn-card-worker-${variant}`
        const app = getComputedStyle(anchor)
        for (const property of typography) {
          if (getComputedStyle(button)[property] !== app[property]) throw new Error(`${variant}: terminal ${property} differs from app`)
        }
        for (const property of typography) {
          if (app[property] !== baseline[property]) {
            throw new Error(`${variant} ${property}: expected aloft baseline ${baseline[property]}, app ${app[property]}`)
          }
        }
      }
      for (const variant of ['waiting', 'attention', 'blocked']) {
        anchor.className = `kbn-card-phase kbn-card-phase-${variant}`
        for (const property of typography) {
          if (getComputedStyle(anchor)[property] !== baseline[property]) throw new Error(`${variant}: fallback ${property} differs from Aloft`)
        }
      }
      button.remove()
      anchor.className = original
    })
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
    await page.locator('.kbn-detail-aloft').evaluate(detail => {
      const card = document.querySelector('.kbn-card-worker')
      if (!card) throw new Error('card worker marker missing')
      for (const property of ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'textTransform']) {
        if (getComputedStyle(detail)[property] !== getComputedStyle(card)[property]) {
          throw new Error(`detail ${property} differs from card: ${getComputedStyle(detail)[property]} vs ${getComputedStyle(card)[property]}`)
        }
      }
    })
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
