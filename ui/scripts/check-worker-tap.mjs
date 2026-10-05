/** Under a finger, the worker pill on a Desk card and in the document reader
 * opens the worker's conversation. Run `npm run harness:board` then
 * `node scripts/check-worker-tap.mjs [shot-dir]`.
 *
 * On a phone and an iPad it checks the Desk card, reader navbar, and fiber-page
 * control-band pills, including their 44px touch targets. At a desktop the
 * terminal pill stays a button.
 */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

async function openControls(page) {
  const controls = page.locator('.ws-selected .ws-dock')
  await controls.waitFor({ state: 'visible' })
  return controls
}

const SHOTS = process.argv[2] ? resolve(process.argv[2]) : null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const LINK = 'https://claude.ai/code/session_harness-waiting'
const CARD = 'File the conference travel reimbursement'

const DEVICES = [
  { name: 'phone', viewport: { width: 390, height: 844 }, touch: true },
  { name: 'ipad', viewport: { width: 1024, height: 1366 }, touch: true },
  { name: 'desktop', viewport: { width: 1440, height: 900 }, touch: false },
]

const browser = await chromium.launch({ headless: true })
const failures = []
try {
  for (const device of DEVICES) {
    const context = await browser.newContext({
      viewport: device.viewport, isMobile: device.touch, hasTouch: device.touch,
      deviceScaleFactor: 2, reducedMotion: 'reduce',
    })
    const page = await context.newPage()
    const landed = []
    await page.route('https://claude.ai/**', (route) => {
      landed.push(route.request().url())
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>claude app</p>' })
    })
    const home = pathToFileURL(resolve('harness-board-dist/index.html')).href
    await page.goto(home)
    const shot = async (what) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${device.name}-${what}.png`) }) }

    /** Tap `dy` px off the pill's centre and report whether the tap reached the link. */
    const tap = async (pill, where, dy = 0) => {
      await pill.scrollIntoViewIfNeeded()
      const box = await pill.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, h: r.height }
      })
      const before = landed.length
      if (device.touch) await page.touchscreen.tap(box.x, box.y + dy)
      else await page.mouse.click(box.x, box.y + dy)
      await page.waitForTimeout(400)
      const reached = landed.length > before
      await shot(`${where.replace(' ', '-')}${dy ? `-dy${dy}` : ''}-tapped`)
      console.log(`${device.name} ${where} (dy=${dy}): height=${box.h.toFixed(1)} reached=${reached}`)
      return reached
    }

    const card = page.locator('.kbn-card').filter({ has: page.getByText(CARD, { exact: true }) })
    const cardPill = card.locator('.kbn-card-worker')
    await shot('desk')
    if (device.touch) {
      assert.equal(await cardPill.evaluate((el) => el.tagName), 'A', `${device.name}: card pill is a link`)
      if (!await tap(cardPill, 'card')) failures.push(`${device.name}: card pill tap did not land`)
      await page.goto(home)
      // A tap on the outcome just above the pill opens the reader, not the
      // worker conversation.
      const outcome = card.locator('.kbn-card-outcome')
      await outcome.scrollIntoViewIfNeeded()
      const point = await cardPill.evaluate((pill, text) => {
        const p = pill.getBoundingClientRect()
        const o = text.getBoundingClientRect()
        const x = Math.min(Math.max(p.x + p.width / 2, o.left + 2), o.right - 2)
        return { x, y: o.bottom - 3, gap: p.y + p.height / 2 - (o.bottom - 3) }
      }, await outcome.elementHandle())
      const before = landed.length
      await page.touchscreen.tap(point.x, point.y)
      await page.waitForTimeout(400)
      await shot('outcome-tapped')
      const reader = page.locator('.ws-page.ws-selected')
      await reader.waitFor({ state: 'visible', timeout: 3000 })
      const opened = await reader.isVisible()
      console.log(`${device.name} outcome ${point.gap.toFixed(1)}px above the pill: navigated=${landed.length > before} reader opened=${opened}`)
      if (landed.length > before) failures.push(`${device.name}: a tap on the outcome opened the session`)
      if (!opened) failures.push(`${device.name}: a tap on the outcome did not open the reader`)
      const outcomeControls = await openControls(page)
      if (!await outcomeControls.locator('.ws-dock-worker .kbn-card-worker').isVisible()) failures.push(`${device.name}: the fiber page did not show the worker pill`)
      const readerPill = page.locator('.ws-worker-pill .kbn-card-worker')
      await readerPill.waitFor({ state: 'visible', timeout: 3000 })
      if (!await tap(readerPill, 'reader-navbar')) failures.push(`${device.name}: reader navbar pill tap did not land`)
      await page.goto(home)
    } else {
      assert.equal(await cardPill.evaluate((el) => el.tagName), 'BUTTON', 'desktop: card pill is a button')
    }

    await card.locator('.kbn-card-name').click()
    const controls = await openControls(page)
    const detailPill = controls.locator('.ws-dock-worker .kbn-card-worker')
    await detailPill.waitFor({ state: 'visible', timeout: 3000 })
    await page.waitForTimeout(400)
    await shot('fiber-page-controls')
    if (device.touch) {
      assert.equal(await detailPill.getAttribute('href'), LINK, `${device.name}: detail pill links to the session`)
      if (!await tap(detailPill, 'fiber-page')) failures.push(`${device.name}: fiber-page pill tap did not land`)
      // A 44px target: a tap 20px below the pill's centre still lands on it.
      await page.goto(home)
      await page.locator('.kbn-card').filter({ has: page.getByText(CARD, { exact: true }) }).locator('.kbn-card-name').click()
      const reopenedControls = await openControls(page)
      const reopenedPill = reopenedControls.locator('.ws-dock-worker .kbn-card-worker')
      await reopenedPill.waitFor({ state: 'visible', timeout: 3000 })
      await page.waitForTimeout(400)
      if (!await tap(reopenedPill, 'fiber-page', 20)) failures.push(`${device.name}: fiber-page pill hit area is under 44px`)
    } else {
      assert.equal(await detailPill.evaluate((el) => el.tagName), 'BUTTON', 'desktop: fiber-page pill is a button')
      assert.equal(await detailPill.evaluate((el) => getComputedStyle(el).pointerEvents), 'auto', 'desktop: fiber-page pill takes clicks')
    }
    await context.close()
  }
} finally { await browser.close() }
if (failures.length) { console.error(failures.join('\n')); process.exit(1) }
console.log('Worker pill taps open the conversation from the Desk card and document reader on phone and iPad')
