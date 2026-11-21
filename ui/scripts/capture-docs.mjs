/** Build with npm run harness:board, then run npm run screenshots:docs. */
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
await access(chrome)
const browser = await chromium.launch({ executablePath: chrome, headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 760 },
    reducedMotion: 'reduce', locale: 'en-GB', timezoneId: 'Europe/Paris' })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.clock.install({ time: new Date('2026-10-04T14:00:00Z') })
  await page.goto(`${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=workshop`)
  await page.locator('.kbn-family').first().waitFor()
  await page.evaluate(() => document.fonts.ready)
  const assets = resolve('../docs/assets')
  await page.screenshot({ path: resolve(assets, 'shuttle-board-example.png') })
  await page.screenshot({ path: resolve(assets, 'board-desk.jpg'), type: 'jpeg', quality: 90 })
  assert.deepEqual(errors, [])
  console.log('Captured workshop Desk screenshots in docs/assets')
} finally {
  await browser.close()
}
