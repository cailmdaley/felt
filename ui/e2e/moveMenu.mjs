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

/** Record the Move menu's box on the first frame it is open. */
const watchFirstFrame = page => page.evaluate(() => {
  window.__firstFrame = null
  const tick = () => {
    const menu = document.querySelector('ui-menu-content.kbn-move-menu')
    if (menu?.hasAttribute('data-open')) { window.__firstFrame = { top: menu.getBoundingClientRect().top }; return }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})

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
    await watchFirstFrame(p)
    await touch('touchStart', [{ x: held.x + held.width / 2, y: held.y + held.height / 2 }])
    await p.waitForTimeout(600)
    await move.waitFor()
    await p.evaluate(() => {
      window.__moveClosed = null
      document.querySelector('ui-menu').addEventListener('openchange', event => { if (!event.detail.value) window.__moveClosed = event.detail.reason })
    })
    const place = await destinations.first().boundingBox()
    if (phone) {
      // Under reduced motion the sheet is at its resting place on its first frame.
      const first = await p.evaluate(() => window.__firstFrame)
      const rest = await move.boundingBox()
      assert.ok(first && Math.abs(first.top - rest.y) < 1, `the sheet does not move after its first frame (${first?.top} then ${rest.y})`)
      assert.ok(Math.abs(rest.y + rest.height - p.viewportSize().height) < 1, 'the sheet rests on the bottom edge')
    }
    await touch('touchMove', [{ x: place.x + 20, y: place.y + place.height / 2 }])
    await touch('touchEnd', [])
    await p.waitForTimeout(300)
    assert.equal(await p.evaluate(() => window.__moveClosed), null, 'the opening hold chooses no destination')
    await shot('hold')
    await p.keyboard.press('Escape')
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

  // A hold whose finger keeps dragging down as the phone sheet opens, with motion on,
  // leaves the menu closed or wholly on screen, never open below the viewport.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  const p = await context.newPage()
  p.setDefaultTimeout(10000)
  await p.goto(url)
  const cdp = await context.newCDPSession(p)
  const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints })
  const chip = p.locator('.kbn-role-chip').first()
  // Hold where the rising sheet will pass under the finger.
  await chip.evaluate(el => {
    el.scrollIntoView({ block: 'start' })
    let scroller = el.parentElement
    while (getComputedStyle(scroller).overflowY === 'visible' || scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement
    scroller.scrollTop += el.getBoundingClientRect().y - 600
  })
  await p.waitForTimeout(300)
  const held = await chip.boundingBox()
  const x = held.x + held.width / 2, y = held.y + held.height / 2
  await touch('touchStart', [{ x, y }])
  const move = p.getByRole('menu', { name: /^Move / })
  await move.waitFor()
  for (const dy of [100, 200]) await touch('touchMove', [{ x, y: y + dy }])
  await touch('touchEnd', [])
  await p.waitForTimeout(1000)
  if (await move.count()) {
    const box = await move.boundingBox()
    assert.ok(box.y >= 0 && box.y + box.height <= p.viewportSize().height + 1, `an open sheet is on screen (top ${box.y})`)
  }
  await context.close()
  console.log('PASS Move menu (phone, drag after hold)')
} finally { await browser.close() }
