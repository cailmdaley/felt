/** The dock's Parent search picks under both engines' focus rules, with a
 * quick click and with a slow press. Run `npm run harness:board` then
 * `node scripts/check-parent-picker.mjs`.
 *
 * WebKit gives a clicked button no focus: pressing a result blurs the search
 * input to the body. A picker that closes once focus has left it hides the
 * result under the pointer when the press outlasts any grace period, and the
 * pick never reaches the daemon — which Chromium, where the pressed button
 * takes focus, cannot show.
 */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, webkit } from 'playwright-core'

const pick = async (page, option, holdMs) => {
  const box = await option.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(holdMs)
  await page.mouse.up()
}

for (const engine of [webkit, chromium]) {
  for (const holdMs of [0, 400]) {
    const browser = await engine.launch({ headless: true })
    const label = `${engine.name()} (press held ${holdMs} ms)`
    try {
      const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, reducedMotion: 'reduce' })
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(pathToFileURL(resolve('harness-board-dist/index.html')).href)
      await page.getByText('Run the 2D B-mode null tests', { exact: true }).click()
      await page.locator('.ws-conversation').click()
      const dock = page.locator('.ws-dock')
      await dock.waitFor({ state: 'visible' })
      await dock.locator('.kbn-detail-controls-toggle').click()
      await page.evaluate(() => {
        window.posts = []
        const originalFetch = window.fetch
        window.fetch = (input, init) => {
          if (init?.body && String(init.body).includes('parent')) window.posts.push(String(init.body))
          return originalFetch(input, init)
        }
      })
      await dock.locator('.kbn-ctl-parent').click()
      const option = dock.locator('.kbn-detail-parent-option:not(.kbn-detail-parent-empty)').first()
      await option.waitFor({ state: 'visible', timeout: 2000 })
      const target = await option.locator('.kbn-detail-parent-option-id').textContent()
      await pick(page, option, holdMs)
      await page.waitForTimeout(300)
      const posts = await page.evaluate(() => window.posts)
      assert.equal(posts.length, 1, `${label}: picking a parent sends one patch`)
      assert.ok(posts[0].includes(target), `${label}: the patch names ${target}`)
      assert.equal(await dock.locator('.kbn-ctl-parent').textContent(), target, `${label}: the control shows the new parent`)
      await dock.locator('.kbn-ctl-parent').click()
      await option.waitFor({ state: 'visible', timeout: 2000 })
      await dock.locator('.kbn-ctl-field', { has: page.locator('.kbn-detail-parent-wrap') }).locator('.kbn-ctl-label').click()
      await page.waitForTimeout(300)
      assert.ok(await dock.locator('.kbn-detail-parent-dropdown').isHidden(), `${label}: a press elsewhere closes the picker`)
      assert.deepEqual(errors, [], `${label}: no page errors`)
      console.log(`${label}: Parent → ${target} reaches the daemon; a press elsewhere closes it`)
    } finally {
      await browser.close()
    }
  }
}
