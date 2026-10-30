/** Build with `npm run harness:board`, then run `node scripts/check-meeting-button.mjs`.
 * Checks the visible Meeting arm button against the offline daemon on desktop and phone.
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
    if (mobile) await controls.locator('.kbn-detail-directive').focus()
    await meeting.waitFor({ state: 'visible' })
    const toggle = meeting.getByRole('button', { name: 'Meeting', exact: true })
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false')
    assert.equal(await meeting.getByRole('radio').count(), 0)
    assert.ok((await meeting.textContent()).includes('recorder-host'))
    await page.evaluate(() => {
      window.joins = []
      const original = window.fetch
      window.fetch = (input, init) => {
        if (String(input).endsWith('/api/v1/meeting/join')) window.joins.push(JSON.parse(init.body))
        return original(input, init)
      }
    })
    await toggle.click()
    assert.equal(await meeting.getByRole('radio').count(), 0)
    assert.ok(await meeting.getByRole('button', { name: 'Start meeting', exact: true }).isVisible())
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true')
    assert.deepEqual(await page.evaluate(() => window.joins), [], 'arming records nothing')
    await toggle.click()
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false')
    assert.equal(await meeting.getByRole('button', { name: 'Start meeting', exact: true }).isVisible(), false)
    await toggle.click()
    if (process.env.MEETING_SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.MEETING_SCREENSHOT_DIR}/meeting-${mobile ? 'phone' : 'desktop'}.png` })
    }
    if (!mobile) {
      await meeting.getByRole('button', { name: 'Start meeting', exact: true }).click()
      await page.waitForFunction(() => window.joins?.length === 1)
      const [join] = await page.evaluate(() => window.joins)
      assert.equal(join.meeting.mode, 'call')
      assert.equal(join.recorder, 'recorder-host')
      assert.ok(join.origin && join.origin !== join.recorder)
    }
    url.search = '?capture=meeting&recorder=recorder-host'
    await page.goto(url.href)
    const dialog = page.getByRole('dialog')
    const captureToggle = dialog.getByRole('button', { name: 'Meeting', exact: true })
    const language = dialog.getByRole('combobox', { name: 'Language', exact: true })
    await captureToggle.waitFor({ state: 'visible' })
    assert.equal(await language.count(), 0)
    await captureToggle.click()
    assert.equal(await language.inputValue(), 'auto')
    assert.deepEqual(await language.locator('option').allTextContents(), ['Auto-detect', 'Français', 'English'])
    await language.selectOption('fr')
    await captureToggle.click()
    assert.equal(await language.count(), 0)
    await captureToggle.click()
    if (process.env.MEETING_SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.MEETING_SCREENSHOT_DIR}/capture-language-${mobile ? 'phone' : 'desktop'}.png` })
    }
    if (!mobile) {
      await page.evaluate(() => {
        window.captures = []
        const original = window.fetch
        window.fetch = (input, init) => {
          if (String(input).endsWith('/api/v1/capture')) window.captures.push(JSON.parse(init.body))
          return original(input, init)
        }
      })
      await dialog.getByRole('button', { name: 'Start meeting', exact: true }).click()
      await page.waitForFunction(() => window.captures?.length === 1)
      assert.deepEqual(await page.evaluate(() => window.captures[0].meeting), { mode: 'call', language: 'fr' })
    }
    assert.deepEqual(errors, [])
    console.log(`${mobile ? 'phone' : 'desktop'}: visible Meeting arm button; conditional Capture language select${mobile ? '' : '; call Join and French Capture observed'}`)
    await page.close()
  }
} finally {
  await browser.close()
}
