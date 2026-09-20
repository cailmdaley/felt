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

  await page.goto(pathToFileURL(resolve('harness-board-dist/index.html')).href)
  await page.getByText('App conversation continuity', { exact: true }).click()
  await page.locator('.kbn-detail-controls-toggle').click()
  const detailSurface = page.getByRole('combobox', { name: 'Session', exact: true })
  await detailSurface.scrollIntoViewIfNeeded()
  assert.equal(await detailSurface.inputValue(), 'app', 'existing app conversation retains its mode')
  assert.ok(await detailSurface.isVisible(), 'existing task visibly identifies its session type')
  const detailBox = await detailSurface.boundingBox()
  assert.ok(detailBox && detailBox.x >= 0 && detailBox.x + detailBox.width <= 390, 'phone: detail session choice fits')
  if (process.env.SCREENSHOT_DIR) {
    await page.screenshot({ path: resolve(process.env.SCREENSHOT_DIR, 'detail-phone.png') })
  }

  await page.goto(pathToFileURL(resolve('harness-board-dist/index.html')).href)
  await page.getByRole('button', { name: 'Stash a new fiber (n)', exact: true }).click()
  const stashSurface = page.getByRole('combobox', { name: 'Session', exact: true })
  await stashSurface.scrollIntoViewIfNeeded()
  assert.equal(await stashSurface.inputValue(), 'cli', 'default stash visibly uses Terminal')
  assert.equal(await stashSurface.isDisabled(), true)
  const stashAgent = page.locator('select').filter({ has: page.locator('option[value="codex-terra"]') })
  await stashAgent.selectOption('codex-terra')
  assert.equal(await stashSurface.inputValue(), 'app', 'new Codex stash defaults to app')
  await stashSurface.selectOption('cli')
  assert.equal(await stashSurface.inputValue(), 'cli', 'Codex stash still offers Terminal')
  assert.deepEqual(errors, [])
  console.log('Capture, Stash and existing-task session choices; desktop/phone geometry passed')
} finally {
  await browser.close()
}
