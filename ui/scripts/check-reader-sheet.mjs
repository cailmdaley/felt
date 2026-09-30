/** Under a finger, every file the board opens fills the screen; under a mouse
 * it keeps its windows. Run `npm run harness:board` then
 * `node scripts/check-reader-sheet.mjs [shot-dir]`.
 *
 * Four devices — a phone either way up, an iPad, a desktop — through the three
 * doors a file comes in by: the `:::{embed}` attachment in a card's body, the
 * card's sent-files trail, and the Board canvas's ↗. For each it asserts the
 * reader's frame (a sheet covering the viewport, or a window that does not),
 * and that closing it leaves the card open at the scroll it was read at.
 * With a shot directory, each open is photographed there.
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

    // ── A card: its embed, then its sent-files trail ──
    await page.getByText('Daily arXiv digest', { exact: true }).first().click()
    const card = page.locator('.kbn-detail-overlay:not(.kbn-fileview-window)').first()
    await card.waitFor({ state: 'visible' })
    await page.locator('.kbn-detail-attach-card').first().waitFor({ state: 'visible', timeout: 3000 })
    await shot('card')

    const scroller = device.name.startsWith('phone') ? card : card.locator('.kbn-detail-page')
    await scroller.evaluate((el) => { el.scrollTop = 40 })
    const scrollBefore = await scroller.evaluate((el) => el.scrollTop)

    await page.locator('.kbn-detail-attach-card').first().click()
    let win = await expectFrame('embed')
    await win.locator('.kbn-fileview-win-close').click()
    await win.waitFor({ state: 'detached' })
    assert.ok(await card.isVisible(), `${device.name}: the card survives the reader's close`)
    assert.equal(await scroller.evaluate((el) => el.scrollTop), scrollBefore, `${device.name}: card scroll kept`)

    const sent = page.locator('.kbn-detail-sent-file').first()
    await sent.scrollIntoViewIfNeeded()
    await sent.click()
    win = await expectFrame('sent')
    await win.locator('.kbn-fileview-win-close').click()
    await win.waitFor({ state: 'detached' })
    assert.ok(await card.isVisible(), `${device.name}: the card survives the second close`)

    // ── The Board canvas's ↗ ──
    await page.keyboard.press('Escape')
    await card.waitFor({ state: 'hidden' })
    await page.keyboard.press('3')
    const open = page.locator('.kbn-shelf-open:not([hidden])').first()
    await open.waitFor({ state: 'attached', timeout: 3000 })
    await open.evaluate((el) => el.click())
    win = await expectFrame('shelf')
    await win.locator('.kbn-fileview-win-close').click()
    await win.waitFor({ state: 'detached' })

    assert.deepEqual(errors, [], `${device.name}: no page errors`)
    await context.close()
  }
} finally {
  await browser.close()
}
