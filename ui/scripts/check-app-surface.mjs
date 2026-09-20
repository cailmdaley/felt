/** Real Capture form browser check against the offline board harness.
 * Run `npm run harness:board` then `node scripts/check-app-surface.mjs`.
 * CHROME_PATH selects an installed Chromium; SCREENSHOT_DIR saves both sizes.
 */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, reducedMotion: 'reduce' })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(pathToFileURL(resolve('harness-board-dist/index.html')).href)
  await page.getByRole('button', { name: 'New idea — speak it into a card', exact: true }).click()
  const agent = page.locator('select').filter({ has: page.locator('option[value="codex-terra"]') })
  await agent.selectOption('codex-terra')
  const surface = page.locator('select').filter({ has: page.locator('option[value="app"]') })
  assert.equal(await surface.inputValue(), 'app', 'new Codex captures default to app')
  for (const [name, viewport] of [
    ['desktop', { width: 1200, height: 900 }],
    ['phone', { width: 390, height: 844 }],
  ]) {
    await page.setViewportSize(viewport)
    await page.waitForTimeout(200)
    const box = await surface.boundingBox()
    assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width, `${name}: surface selector fits`)
    const submit = await page.getByRole('button', { name: 'Spawn', exact: true }).boundingBox()
    assert.ok(submit && submit.y >= 0 && submit.y + submit.height <= viewport.height, `${name}: submit remains visible`)
    if (process.env.SCREENSHOT_DIR) {
      await mkdir(process.env.SCREENSHOT_DIR, { recursive: true })
      await page.screenshot({ path: resolve(process.env.SCREENSHOT_DIR, `capture-${name}.png`) })
    }
  }
  await surface.selectOption('cli')
  assert.equal(await surface.inputValue(), 'cli')
  await agent.selectOption('claude-opus')
  assert.equal(await surface.inputValue(), 'cli', 'Claude visibly uses Terminal')
  assert.equal(await surface.isDisabled(), true, 'Claude cannot select app mode')
  assert.ok(await page.getByText('Terminal session. Choose a Codex agent to use the ChatGPT app.').isVisible())
  assert.deepEqual(errors, [])
  console.log('Capture app/CLI selection and desktop/phone geometry passed')
} finally {
  await browser.close()
}
