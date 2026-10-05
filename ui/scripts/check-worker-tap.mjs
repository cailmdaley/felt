/** Under a finger, the conversation dock's worker pill does what the compact
 * Desk pill does: a bridged session's pill is a link into the Claude app, and a
 * tap on it lands. Run `npm run harness:board` then
 * `node scripts/check-worker-tap.mjs [shot-dir]`.
 *
 * On a phone and an iPad it taps the waiting worker's pill on the Desk card
 * and in the reader's conversation dock, and asserts each tap navigates to the
 * session link through a hit area at least 44px tall. At a desktop the pill stays a button.
 */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

async function openDock(page) {
  const conversation = page.locator('.ws-conversation')
  await conversation.waitFor({ state: 'visible' })
  await conversation.click()
  const dock = page.locator('.ws-dock')
  await dock.waitFor({ state: 'visible' })
  return dock
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
      const conversation = page.locator('.ws-conversation')
      await conversation.waitFor({ state: 'visible', timeout: 3000 })
      const opened = await conversation.isVisible()
      console.log(`${device.name} outcome ${point.gap.toFixed(1)}px above the pill: navigated=${landed.length > before} reader opened=${opened}`)
      if (landed.length > before) failures.push(`${device.name}: a tap on the outcome opened the session`)
      if (!opened) failures.push(`${device.name}: a tap on the outcome did not open the reader`)
      const outcomeDock = await openDock(page)
      if (!await outcomeDock.locator('.kbn-detail-aloft').isVisible()) failures.push(`${device.name}: opening the dock did not show the worker pill`)
      await page.goto(home)
    } else {
      assert.equal(await cardPill.evaluate((el) => el.tagName), 'BUTTON', 'desktop: card pill is a button')
    }

    await card.locator('.kbn-card-name').click()
    const dock = await openDock(page)
    const detailPill = dock.locator('.kbn-detail-aloft')
    await detailPill.waitFor({ state: 'visible', timeout: 3000 })
    await page.waitForTimeout(400)
    await shot('conversation-dock')
    if (device.touch) {
      assert.equal(await detailPill.getAttribute('href'), LINK, `${device.name}: detail pill links to the session`)
      if (!await tap(detailPill, 'dock')) failures.push(`${device.name}: dock pill tap did not land`)
      // A 44px target: a tap 20px below the pill's centre still lands on it.
      await page.goto(home)
      await page.locator('.kbn-card').filter({ has: page.getByText(CARD, { exact: true }) }).locator('.kbn-card-name').click()
      const reopenedDock = await openDock(page)
      const reopenedPill = reopenedDock.locator('.kbn-detail-aloft')
      await reopenedPill.waitFor({ state: 'visible', timeout: 3000 })
      await page.waitForTimeout(400)
      if (!await tap(reopenedPill, 'dock', 20)) failures.push(`${device.name}: dock pill hit area is under 44px`)
    } else {
      assert.equal(await detailPill.evaluate((el) => el.tagName), 'BUTTON', 'desktop: dock pill is a button')
      assert.equal(await detailPill.evaluate((el) => getComputedStyle(el).pointerEvents), 'auto', 'desktop: dock pill takes clicks')
    }
    await context.close()
  }
} finally { await browser.close() }
if (failures.length) { console.error(failures.join('\n')); process.exit(1) }
console.log('Worker pill taps land on the Desk card and in the conversation dock, phone and iPad')
