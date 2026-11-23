import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchBrowser } from './browser.mjs'

// The thread page alone at its own address: its bar's room on a phone, and a
// live worker stopped only after the page's own question, with the browser's
// answering false as a Rex pane's web view does.
const browser = await launchBrowser()
const url = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=desk&page=thread&f=survey@umber-workstation`
try {
  for (const width of [375, 390, 1280]) {
    const phone = width < 1000
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: phone, isMobile: phone, reducedMotion: 'reduce' })
    await context.addInitScript(() => { window.confirm = () => { window.__asked = true; return false } })
    const p = await context.newPage()
    p.setDefaultTimeout(10000)
    const errors = []
    p.on('pageerror', error => errors.push(error.message))
    await p.goto(url)
    const face = p.locator('.pg-actions .ws-verb-face')
    await face.waitFor()

    const bar = hidden => p.evaluate(hidden => {
      for (const el of document.querySelectorAll('.pg-nav > :is(.pg-actions, .pg-console)')) if (hidden) el.hidden = true
      const box = selector => document.querySelector(selector).getBoundingClientRect()
      return { title: box('.pg-bar-title').width, titleEnd: box('.pg-bar-title').right, overflow: document.documentElement.scrollWidth - innerWidth }
    }, hidden)
    assert.equal(await p.locator('.pg-nav .ws-verb-word').isVisible(), !phone, 'a phone\'s lead verb is its icon')
    const { title, overflow } = await bar(false)
    assert.ok(title >= 120, `the thread's name keeps its room (${title}px at ${width})`)
    assert.equal(overflow, 0, 'nothing runs past the page')

    const written = () => p.evaluate(() => window.__harness.requests.filter(r => r.method !== 'GET' && /transition/.test(r.url)).map(r => JSON.parse(r.body).target))
    const dialog = p.getByRole('dialog')
    for (const key of ['t', 's', 'a', 'x']) await p.keyboard.press(key)
    assert.equal(await dialog.count(), 0, 'no bare letter acts')
    await p.keyboard.press('Alt+Meta+KeyX')
    await dialog.waitFor()
    await p.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    await face.click()
    await dialog.waitFor()
    const bounds = await dialog.locator('.kbn-confirm').boundingBox()
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, 'the question fits the page')
    await p.keyboard.press('Enter')
    await dialog.waitFor({ state: 'detached' })
    await p.waitForFunction(() => window.__harness.requests.some(r => /transition/.test(r.url)))
    assert.deepEqual(await written(), ['awaitingReview'], 'only the confirmed act is written')
    assert.equal(await p.evaluate(() => window.__asked ?? false), false, 'the browser\'s own dialog is never asked')

    const { titleEnd } = await bar(true)
    const inset = await p.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.pg-nav')).paddingRight))
    assert.ok(width - inset - titleEnd < 1, 'hidden buttons leave no gap beside the name')
    assert.deepEqual(errors, [])
    console.log(`PASS thread page (${width})`)
    await context.close()
  }
} finally {
  await browser.close()
}
