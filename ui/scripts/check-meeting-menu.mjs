/** Build with `npm run harness:board`, then run `node scripts/check-meeting-menu.mjs`.
 * Checks recorder-addressed Join controls against the offline daemon on desktop and phone.
 */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getBrowser } from '../e2e/browser.mjs'

const browser = await getBrowser({ executablePath: process.env.CHROME_PATH })
try {
  for (const mobile of [false, true]) {
    const page = await browser.newPage({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1200, height: 900 },
      isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce',
    })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const url = pathToFileURL(resolve('harness-board-dist/index.html'))
    url.search = '?recorder=recorder-host'
    await page.goto(url.href)
    await page.getByText('Run the 2D B-mode null tests', { exact: true }).click()
    const controls = page.locator('.ws-selected .ws-dock')
    await controls.waitFor({ state: 'visible' })
    const meeting = controls.locator('.kbn-ctl-meet')
    await meeting.waitFor({ state: 'visible' })
    await meeting.getByRole('switch').check()
    assert.deepEqual(await meeting.getByRole('radio').allTextContents(), mobile ? ['Phone'] : ['Call', 'Room', 'Phone'])
    assert.ok((await meeting.textContent()).includes('recorder-host'))
    if (!mobile) {
      await page.evaluate(() => {
        window.joins = []
        const original = window.fetch
        window.fetch = (input, init) => {
          if (String(input).endsWith('/api/v1/meeting/join')) window.joins.push(JSON.parse(init.body))
          return original(input, init)
        }
      })
      await meeting.getByRole('radio', { name: 'Room', exact: true }).click()
      await meeting.getByRole('button', { name: 'Start meeting', exact: true }).click()
      await page.waitForFunction(() => window.joins?.length === 1)
      const [join] = await page.evaluate(() => window.joins)
      assert.equal(join.meeting.mode, 'room')
      assert.equal(join.recorder, 'recorder-host')
      assert.ok(join.origin && join.origin !== join.recorder)
    }
    if (process.env.MEETING_SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.MEETING_SCREENSHOT_DIR}/meeting-${mobile ? 'phone' : 'desktop'}.png` })
    }
    assert.deepEqual(errors, [])
    console.log(`${mobile ? 'phone' : 'desktop'}: selected recorder visible; supported Join modes only`)
    await page.close()
  }
} finally {
  await browser.close()
}
