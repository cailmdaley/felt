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
  await page.getByText('Prepare the workshop guide', { exact: true }).waitFor()
  await page.evaluate(() => document.fonts.ready)
  assert.equal(await page.locator('.kbn-card').count(), 6)
  assert.equal(await page.locator('.kbn-card-worker').count(), 2)
  assert.ok(await page.getByText('Use the library meeting room: it seats 30 and is near the station.', { exact: true }).isVisible())
  const assets = resolve('../docs/assets')
  await page.screenshot({ path: resolve(assets, 'shuttle-board-example.png') })
  await page.screenshot({ path: resolve(assets, 'board-desk.jpg'), type: 'jpeg', quality: 90 })
  await page.locator('[data-view="chronicle"]').click()
  await page.getByRole('button', { name: 'Choose a workshop venue', exact: true }).waitFor()
  await page.screenshot({ path: resolve(assets, 'board-chronicle.jpg'), type: 'jpeg', quality: 90 })
  assert.deepEqual(errors, [])
  console.log('Captured workshop Desk and Chronicle screenshots in docs/assets')
} finally {
  await browser.close()
}
