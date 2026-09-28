/** The drawer's Meeting menu picks under both engines' focus rules. Run
 * `npm run harness:board` then `node scripts/check-meeting-menu.mjs`.
 *
 * WebKit gives a clicked button no focus: pressing Room blurs the focused Call
 * to the body before Room's click lands. A menu that closes on that blur hides
 * Room under the pointer and the pick never reaches the daemon — which Chromium,
 * where the pressed button takes focus, cannot show.
 */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, webkit } from 'playwright-core'

for (const engine of [webkit, chromium]) {
  const browser = await engine.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(pathToFileURL(resolve('harness-board-dist/index.html')).href)
    await page.getByText('Run the 2D B-mode null tests', { exact: true }).click()
    await page.locator('.kbn-detail-controls-toggle').click()
    await page.evaluate(() => {
      window.joins = []
      const originalFetch = window.fetch
      window.fetch = (input, init) => {
        if (String(input).endsWith('/api/v1/meeting/join')) window.joins.push(JSON.parse(init.body))
        return originalFetch(input, init)
      }
    })
    const menu = page.getByRole('menu', { name: 'Meeting kind', exact: true })
    await page.getByRole('button', { name: 'Meeting', exact: true }).click()
    assert.ok(await menu.isVisible(), `${engine.name()}: Meeting opens its kinds`)
    await page.getByRole('menuitem', { name: 'Room', exact: true }).click({ timeout: 2000 })
    await page.waitForTimeout(200)
    const joins = await page.evaluate(() => window.joins)
    assert.deepEqual(joins.map(j => j.meeting.mode), ['room'], `${engine.name()}: picking Room starts one room meeting`)
    assert.deepEqual(errors, [], `${engine.name()}: no page errors`)
    console.log(`${engine.name()}: Meeting → Room reaches /api/v1/meeting/join`)
  } finally {
    await browser.close()
  }
}
