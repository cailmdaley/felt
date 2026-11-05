import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const shots = process.env.SHOTS_DIR ?? '/tmp/change-reader-shots'
await mkdir(shots, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--allow-file-access-from-files', '--mute-audio', '--use-mock-keychain', '--password-store=basic'] })
const results = []
try {
  for (const [device, width, height] of [['desktop', 1440, 1000], ['phone', 390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: 'light', reducedMotion: 'reduce', isMobile: width < 700, hasTouch: width < 700 })
    try {
      await context.addInitScript(() => {
        if (window !== window.top) return
        localStorage.setItem('shuttle.appearance', JSON.stringify({ mode: 'light' }))
        localStorage.setItem('shuttle:workspace:sidebar', 'false')
        localStorage.setItem('shuttle:workspace:rail', 'false')
      })
      const page = await context.newPage(), errors = []
      page.setDefaultTimeout(60_000)
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(`${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=change`, { waitUntil: 'domcontentloaded' })
      await page.locator('.kbn-desk .kbn-card').filter({ hasText: 'Calibrate the shear response' }).click()
      await page.locator('.ws-selected .ws-report-chip[data-document-key$="/family.change.json"]').click()
      const reader = page.locator('.ws-selected .change-reader')
      await reader.locator('diffs-container [data-line-index]').first().waitFor()
      await page.evaluate(() => document.fonts.ready)
      await page.screenshot({ path: `${shots}/real-${device}-overview.png` })
      for (const [index, file] of process.argv.slice(2).entries()) {
        const target = reader.locator(`[data-change-file=${JSON.stringify(file)}]`).first()
        await target.locator('.change-diff-window').last().scrollIntoViewIfNeeded()
        await target.locator('diffs-container [data-line-index]').first().waitFor()
        await page.screenshot({ path: `${shots}/real-${device}-file-${index + 1}.png` })
      }
      await reader.getByRole('button', { name: /^Your review/ }).click()
      await page.screenshot({ path: `${shots}/real-${device}-review.png` })
      const geometry = await reader.evaluate(root => {
        const scroll = root.querySelector('.change-scroll')
        return { title: root.querySelector('h1').textContent, horizontalOverflow: scroll.scrollWidth - scroll.clientWidth, mountedWindows: root.querySelectorAll('diffs-container').length, totalWindows: root.querySelectorAll('.change-diff-window').length }
      })
      assert.equal(geometry.horizontalOverflow, 0)
      assert.deepEqual(errors, [])
      results.push({ device, ...geometry, errors })
    } finally { await context.close() }
  }
} finally { await browser.close() }
await writeFile(`${shots}/real-measurements.json`, JSON.stringify(results, null, 2) + '\n')
console.log(JSON.stringify(results, null, 2))
