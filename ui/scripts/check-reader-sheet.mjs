/** Under a finger, ShelfReader fills the screen; under a mouse it keeps its
 * windows. Run `npm run harness:board` then
 * `node scripts/check-reader-sheet.mjs [shot-dir]`.
 *
 * Five device sizes — a phone either way up, an iPad, a desktop — open a file
 * from the Board canvas's ↗ and assert the reader's frame (a sheet covering
 * the viewport, or a window that does not). A narrow desktop window also
 * reframes as it widens and narrows. With a shot directory, each open is
 * photographed there.
 */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const SHOTS = process.argv[2] ? resolve(process.argv[2]) : null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

const DEVICES = [
  { name: 'phone-portrait', viewport: { width: 390, height: 844 }, touch: true },
  { name: 'phone-landscape', viewport: { width: 844, height: 390 }, touch: true },
  { name: 'ipad-portrait', viewport: { width: 1024, height: 1366 }, touch: true },
  { name: 'ipad-landscape', viewport: { width: 1366, height: 1024 }, touch: true },
  { name: 'desktop', viewport: { width: 1440, height: 900 }, touch: false },
]

const browser = await chromium.launch({ headless: true })
try {
  for (const device of DEVICES) {
    const context = await browser.newContext({
      viewport: device.viewport,
      isMobile: device.touch,
      hasTouch: device.touch,
      deviceScaleFactor: 2,
      reducedMotion: 'reduce',
    })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(pathToFileURL(resolve('harness-board-dist/index.html')).href)
    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
    assert.equal(coarse, device.touch, `${device.name}: pointer emulation`)

    const shot = async (what) => {
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${device.name}-${what}.png`) })
    }

    /** The reader's frame: does it cover the viewport, and wear the sheet? */
    const expectFrame = async (what) => {
      const win = page.locator('.kbn-fileview-window').last()
      await win.waitFor({ state: 'visible', timeout: 3000 })
      await page.waitForTimeout(400)
      const box = await win.boundingBox()
      const sheet = await win.evaluate((el) => el.classList.contains('kbn-detail-sheet'))
      const { width, height } = device.viewport
      const covers = box.x <= 1 && box.y <= 1 && box.width >= width - 1 && box.height >= height - 1
      assert.equal(sheet, device.touch, `${device.name} ${what}: sheet class`)
      assert.equal(covers, device.touch, `${device.name} ${what}: covers the viewport (${JSON.stringify(box)})`)
      await shot(what)
      console.log(`${device.name} ${what}: ${sheet ? 'full-screen sheet' : 'window'} ${Math.round(box.width)}x${Math.round(box.height)}`)
      return win
    }

    // ── The Board canvas's ↗ ──
    await page.keyboard.press('3')
    const open = page.locator('.kbn-shelf-open:not([hidden])').first()
    await open.waitFor({ state: 'attached', timeout: 3000 })
    await open.evaluate((el) => el.click())
    const win = await expectFrame('shelf')
    await win.locator('.kbn-fileview-win-close').click()
    await win.waitFor({ state: 'detached' })

    assert.deepEqual(errors, [], `${device.name}: no page errors`)
    await context.close()
  }

  // ── Live reframing: an open reader follows the window across 700px ──
  // Under a mouse, a window narrower than a phone gets a sheet; widened with
  // the reader open, the sheet must become a placed window (not a 380x320
  // husk wearing the sheet class), and narrowed again, a sheet.
  {
    const narrow = { width: 600, height: 900 }
    const wide = { width: 1440, height: 900 }
    const context = await browser.newContext({ viewport: narrow, deviceScaleFactor: 2, reducedMotion: 'reduce' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(pathToFileURL(resolve('harness-board-dist/index.html')).href)

    const frame = async (label, expectSheet) => {
      const win = page.locator('.kbn-fileview-window').last()
      await page.waitForTimeout(400)
      const box = await win.boundingBox()
      const sheet = await win.evaluate((el) => el.classList.contains('kbn-detail-sheet'))
      const vp = page.viewportSize()
      const covers = box.x <= 1 && box.y <= 1 && box.width >= vp.width - 1 && box.height >= vp.height - 1
      assert.equal(sheet, expectSheet, `${label}: sheet class`)
      assert.equal(covers, expectSheet, `${label}: covers the viewport (${JSON.stringify(box)})`)
      if (!expectSheet) assert.ok(box.width > 400 && box.height > 400, `${label}: a placed window, not a husk (${JSON.stringify(box)})`)
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `reframe-${label.replace(/\W+/g, '-')}.png`) })
      console.log(`${label}: ${sheet ? 'sheet' : 'window'} ${Math.round(box.width)}x${Math.round(box.height)}`)
    }

    await page.keyboard.press('3')
    const open = page.locator('.kbn-shelf-open:not([hidden])').first()
    await open.waitFor({ state: 'attached', timeout: 3000 })
    await open.evaluate((el) => el.click())
    await frame('shelf reader at 600', true)
    await page.setViewportSize(wide)
    await frame('shelf reader widened to 1440', false)
    await page.setViewportSize(narrow)
    await frame('shelf reader narrowed to 600', true)
    await page.locator('.kbn-fileview-win-close').last().click()

    assert.deepEqual(errors, [], 'reframe: no page errors')
    await context.close()
  }
} finally {
  await browser.close()
}
