import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { webkit } from 'playwright-core'

// The Channels rail in WebKit, Safari's engine, with motion on: it follows a
// trackpad's sideways swipe, inertia tail and all, and a finger's, and a second
// swipe begun while the first is still settling takes effect.

const url = `${pathToFileURL(resolve('harness-board-dist/index.html'))}?example=channels#/channels`
const hidden = page => page.evaluate(() => document.querySelector('.kbn-ch-layout').hasAttribute('data-rail-hidden'))
/** How much of the rail's width stands on the page, 0 to 1. */
const showing = page => page.evaluate(() => {
  const rail = document.querySelector('.kbn-ch-rail'), box = rail.getBoundingClientRect()
  if (!box.width || getComputedStyle(rail).visibility === 'hidden') return 0
  const layout = document.querySelector('.kbn-ch-layout').getBoundingClientRect()
  return Math.max(0, Math.min(1, (box.right - layout.left) / box.width))
})
const settled = async (page, shown) => {
  await page.waitForFunction(shown => {
    const layout = document.querySelector('.kbn-ch-layout')
    return !layout.hasAttribute('data-rail-moving') && layout.hasAttribute('data-rail-hidden') !== shown
  }, shown, { timeout: 3000 })
  assert.equal(await showing(page), shown ? 1 : 0)
}

/**
 * A two-finger swipe as a Mac trackpad sends it: wheel events every frame
 * while the fingers move (deltaX > 0 as they move leftward), then, unless
 * cut short by the next swipe, an inertia tail that decays over a second.
 */
async function swipe(page, at, deltaX, { frames = 8, tail = 40 } = {}) {
  await page.mouse.move(at.x, at.y)
  for (let frame = 0; frame < frames; frame++) { await page.mouse.wheel(deltaX / frames, 0); await page.waitForTimeout(16) }
  for (let frame = 0, step = deltaX / frames; frame < tail && Math.abs(step) >= 1; frame++, step *= 0.9) { await page.mouse.wheel(step, 0); await page.waitForTimeout(16) }
}

/** A finger drawn sideways from `from` by `dx`, in `moves` steps a frame apart; touch events built in the page, as WebKit's desktop build has no Touch constructor. */
async function drag(page, from, dx, { moves = 10, frame = 16, dy = 0, lift = true, during } = {}) {
  const send = (type, x, y) => page.evaluate(({ type, x, y }) => {
    const target = window.__touchTarget ??= document.elementFromPoint(x, y)
    const point = { identifier: 1, target, clientX: x, clientY: y }
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [point] })
    Object.defineProperty(event, 'changedTouches', { value: [point] })
    target.dispatchEvent(event)
    if (type === 'touchend') delete window.__touchTarget
  }, { type, x, y })
  await send('touchstart', from.x, from.y)
  for (let step = 1; step <= moves; step++) { await page.waitForTimeout(frame); await send('touchmove', from.x + dx * step / moves, from.y + dy * step / moves) }
  await during?.()
  if (lift) await send('touchend', from.x + dx, from.y + dy)
}

const browser = await webkit.launch({ headless: true })
try {
  {
    // A Mac: the rail a column beside the stream, swiped by the trackpad.
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
    const errors = []
    // WebKit refuses the harness's daemon requests over file://; those are not the rail's.
    page.on('pageerror', error => { if (!/access control checks/.test(error.message)) errors.push(error.message) })
    await page.goto(url)
    await page.waitForFunction(() => document.querySelectorAll('.kbn-ch-pick').length === 9 && document.querySelector('.kbn-ch-name'))
    const stream = await page.locator('.kbn-ch-stream').boundingBox()
    const at = { x: stream.x + stream.width / 2, y: stream.y + stream.height / 2 }
    await settled(page, true)

    // Away, back and away again, each swipe begun while the last one's inertia still runs: each takes effect.
    await swipe(page, at, 240, { tail: 6 })
    assert.ok(await showing(page) < 0.2, 'the first swipe carries the rail away')
    await swipe(page, at, -240, { tail: 6 })
    assert.ok(await showing(page) > 0.8, 'a swipe straight after brings it back')
    await swipe(page, at, 240)
    await settled(page, false)
    await swipe(page, at, -240)
    await settled(page, true)

    // The rail moves with the fingers: halfway, it is half drawn; let go there, it settles back by where it stands.
    await swipe(page, at, 90, { tail: 0 })
    const half = await showing(page)
    assert.ok(half > 0.35 && half < 0.75, `the rail stands where the fingers left it (${half.toFixed(2)})`)
    await settled(page, true)

    // A vertical scroll of the stream, drifting a little sideways, scrolls the stream and leaves the rail be.
    const before = await page.locator('.kbn-ch-stream').evaluate(el => el.scrollTop)
    await page.mouse.move(at.x, at.y)
    for (let frame = 0; frame < 12; frame++) { await page.mouse.wheel(frame % 3 ? 2 : -2, -40); await page.waitForTimeout(16) }
    assert.equal(await showing(page), 1)
    assert.notEqual(await page.locator('.kbn-ch-stream').evaluate(el => el.scrollTop), before, 'the stream scrolled')
    assert.deepEqual(errors, [])
  }
  {
    // A phone: the rail is the first screen; a finger brings a channel and the rail back, as quickly as it likes.
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage()
    const errors = []
    // WebKit refuses the harness's daemon requests over file://; those are not the rail's.
    page.on('pageerror', error => { if (!/access control checks/.test(error.message)) errors.push(error.message) })
    await page.goto(url)
    await page.waitForFunction(() => document.querySelectorAll('.kbn-ch-pick').length === 9)
    const railWidth = () => page.evaluate(() => document.querySelector('.kbn-ch-rail').getBoundingClientRect().width)
    const full = await railWidth()
    await page.locator('.kbn-ch-pick').first().click()
    // Leaving for the channel chosen, the rail keeps the screen's width.
    assert.equal(await railWidth(), full)
    await page.waitForFunction(() => document.querySelector('.kbn-ch-name') && !document.querySelector('.kbn-ch-layout[data-rail-moving]'))
    const middle = { x: 195, y: 420 }
    // In, away and in again, each drag begun while the last still settles.
    await drag(page, middle, 220)
    await drag(page, middle, -220)
    await drag(page, middle, 220)
    await settled(page, true)
    await drag(page, middle, -220)
    await settled(page, false)
    // Back on the rail, a leftward peek at the channel last read, let go early, leaves it unread; mid-way the rail keeps its width.
    await drag(page, middle, 220)
    await settled(page, true)
    const seen = () => page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('shuttle.channels.seen:')).sort().join())
    const before = await seen()
    const rest = await page.evaluate(() => document.querySelector('.kbn-ch-rail').getBoundingClientRect().width)
    let width = 0
    await drag(page, middle, -60, { moves: 6, frame: 40, during: async () => { width = await page.evaluate(() => document.querySelector('.kbn-ch-rail').getBoundingClientRect().width) } })
    assert.equal(width, rest, 'the rail keeps the screen\'s width as it moves')
    await page.waitForTimeout(150)
    await settled(page, true)
    assert.equal(await seen(), before, 'a glimpse is not a read')
    // A second finger landing mid-drag lets the rail settle; it is never left half drawn.
    await drag(page, middle, -120, { lift: false })
    await page.evaluate(() => {
      const target = window.__touchTarget, point = { identifier: 2, target, clientX: 300, clientY: 500 }
      const event = new Event('touchstart', { bubbles: true }); Object.defineProperty(event, 'touches', { value: [point, point] }); target.dispatchEvent(event)
      for (const type of ['touchend', 'touchend']) { const end = new Event(type, { bubbles: true }); Object.defineProperty(end, 'touches', { value: [] }); Object.defineProperty(end, 'changedTouches', { value: [point] }); target.dispatchEvent(end) }
      delete window.__touchTarget
    })
    await page.waitForFunction(() => !document.querySelector('.kbn-ch-layout[data-rail-moving]'), null, { timeout: 2000 })
    await drag(page, middle, 220)
    await settled(page, true)
    await drag(page, middle, -220)
    await settled(page, false)
    // A finger that draws a little sideways and mostly down scrolls; it brings no rail.
    await drag(page, middle, 40, { dy: 200 })
    await page.waitForTimeout(400)
    assert.equal(await hidden(page), true)
    assert.deepEqual(errors, [])
  }
  console.log('Rail gesture in WebKit: a trackpad swipe and a finger both carry the rail, a second swipe in the first one\'s inertia takes effect, a half swipe settles back, a vertical scroll leaves it be')
} finally {
  await browser.close()
}
