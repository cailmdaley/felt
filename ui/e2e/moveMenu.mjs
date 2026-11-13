import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchBrowser } from './browser.mjs'

// The Move menu, raised by holding a Roles chip or from a line's menu.
const browser = await launchBrowser()
const url = pathToFileURL(resolve('harness-board-dist/index.html')).href
const shots = process.env.UI_SDK_SHOTS
if (shots) await mkdir(shots, { recursive: true })
try {
  for (const phone of [false, true]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({
      viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      hasTouch: true, isMobile: phone, colorScheme: theme, reducedMotion: 'reduce',
    })
    const p = await context.newPage()
    p.setDefaultTimeout(10000)
    const errors = []
    p.on('pageerror', error => errors.push(error.message))
    await p.goto(url)
    const move = p.getByRole('menu', { name: /^Move / })
    const destinations = move.getByRole('menuitem')
    const shot = async method => {
      if (shots) await p.screenshot({ path: resolve(shots, `after-move-${phone ? 'phone' : 'desktop'}-${theme}-${method}.png`) })
    }
    const focused = async locator => locator.evaluate(el => el === document.activeElement)
    const cdp = await context.newCDPSession(p)
    const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints })

    // A hold opens the menu; the same finger sliding onto a place and lifting chooses nothing.
    const chip = p.locator('.kbn-role-chip').first()
    await chip.scrollIntoViewIfNeeded()
    const held = await chip.boundingBox()
    await touch('touchStart', [{ x: held.x + held.width / 2, y: held.y + held.height / 2 }])
    await p.waitForTimeout(600)
    await move.waitFor()
    await p.evaluate(() => {
      window.__moveClosed = null
      document.querySelector('ui-menu').addEventListener('openchange', event => { if (!event.detail.value) window.__moveClosed = event.detail.reason })
    })
    // The phone sheet rises into place; slide onto a place once it is there.
    let place = await destinations.first().boundingBox()
    for (let settled = false; !settled;) {
      await p.waitForTimeout(80)
      const next = await destinations.first().boundingBox()
      settled = next.y === place.y
      place = next
    }
    await touch('touchMove', [{ x: place.x + 20, y: place.y + place.height / 2 }])
    await touch('touchEnd', [])
    await p.waitForTimeout(300)
    // On the phone sheet a downward slide is the SDK's swipe to dismiss; either way nothing is chosen.
    const closed = await p.evaluate(() => window.__moveClosed)
    assert.ok(closed === null || closed === 'swipe', `the opening hold chooses no destination (closed by ${closed})`)
    if (closed === null) {
      await shot('hold')
      await p.keyboard.press('Escape')
    }
    await move.waitFor({ state: 'detached' })

    // From a line's menu by keyboard: the SDK owns the menu keys.
    const line = p.locator('.kbn-desk .kbn-card[aria-haspopup="menu"]:visible').first()
    await line.click({ button: 'right' })
    await p.getByRole('menu', { name: /^Actions for / }).waitFor()
    await p.keyboard.press('End')
    await p.keyboard.press('Enter')
    await move.waitFor()
    await p.waitForTimeout(600)
    if (phone) assert.equal(await focused(move), true, 'the sheet opens on its surface')
    else assert.equal(await focused(destinations.first()), true, 'the popover opens on its first place')
    await p.keyboard.press('End')
    assert.equal(await focused(destinations.last()), true)
    await p.keyboard.press('Home')
    assert.equal(await focused(destinations.first()), true)
    await shot('keyboard')
    await p.keyboard.press('Escape')
    await move.waitFor({ state: 'detached' })

    // An outside press closes it without reaching the line beneath.
    await line.click({ button: 'right' })
    await p.getByRole('menu', { name: /^Actions for / }).getByRole('menuitem', { name: 'Move…' }).click()
    await move.waitFor()
    await p.waitForTimeout(800)
    await shot('pointer')
    const box = await move.boundingBox()
    assert.ok(box.x >= 0 && box.x + box.width <= p.viewportSize().width, 'menu fits the viewport')
    let outside
    for (const other of await p.locator('.kbn-desk .kbn-card[aria-haspopup="menu"]:visible').all()) {
      const b = await other.boundingBox()
      const point = { x: b.x + 10, y: b.y + b.height / 2 }
      const clear = point.x < box.x - 4 || point.x > box.x + box.width + 4 || point.y < box.y - 4 || point.y > box.y + box.height + 4
      if (clear && point.y > 0 && point.y < p.viewportSize().height) { outside = point; break }
    }
    assert.ok(outside, 'a line lies outside the menu')
    const where = await p.evaluate(() => location.href)
    if (phone) { await touch('touchStart', [outside]); await touch('touchEnd', []) } else await p.mouse.click(outside.x, outside.y)
    await move.waitFor({ state: 'detached' })
    await p.waitForTimeout(300)
    assert.equal(await p.evaluate(() => location.href), where, 'the dismissing press opens nothing')
    assert.deepEqual(errors, [])
    await context.close()
    console.log(`PASS Move menu (${phone ? 'phone' : 'desktop'}, ${theme})`)
  }
} finally { await browser.close() }
