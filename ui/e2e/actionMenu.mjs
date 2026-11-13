import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchBrowser } from './browser.mjs'

const browser = await launchBrowser()
const url = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=workspace&console=rex`
const shots = process.env.UI_SDK_SHOTS
if (shots) await mkdir(shots, { recursive: true })
try {
  for (const phone of [false, true]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({
      viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      hasTouch: phone, isMobile: phone, colorScheme: theme, reducedMotion: 'reduce',
    })
    const p = await context.newPage()
    p.setDefaultTimeout(10000)
    const errors = []
    p.on('pageerror', error => errors.push(error.message))
    await p.goto(url)
    await p.locator('.kbn-desk .kbn-card:not(.kbn-card-header):has(.kbn-card-name[title*="Calibrate the shear response"])').click()
    const opener = p.locator('.ws-page.ws-selected .fp-row[data-selected] > .fp-line .fp-verbs .ws-acts-console')
    const menu = p.getByRole('menu', { name: 'Open conversation in' })
    const items = p.getByRole('menuitemradio')
    const shot = async method => {
      if (shots) await p.screenshot({ path: resolve(shots, `after-${phone ? 'phone' : 'desktop'}-${theme}-${method}.png`) })
    }
    await opener.click({ button: 'right' })
    await menu.waitFor()
    await shot('pointer')
    const box = await menu.boundingBox()
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= p.viewportSize().width, 'menu fits the viewport')
    await p.keyboard.press('ArrowDown')
    assert.equal(await items.nth(1).evaluate(el => el === document.activeElement), true)
    await p.keyboard.press('End')
    assert.equal(await items.last().evaluate(el => el === document.activeElement), true)
    await p.keyboard.press('Home')
    assert.equal(await items.first().evaluate(el => el === document.activeElement), true)
    await p.keyboard.press('Escape')
    await menu.waitFor({ state: 'detached' })
    assert.equal(await opener.evaluate(el => el === document.activeElement), true, 'Escape returns to the opener, not Desk')
    for (const key of ['Shift+F10', 'ContextMenu']) {
      await opener.focus()
      await p.keyboard.press(key)
      await menu.waitFor()
      await p.keyboard.press('ArrowDown')
      await shot('keyboard')
      await p.keyboard.press('Escape')
      await menu.waitFor({ state: 'detached' })
    }
    if (phone) {
      const bounds = await opener.boundingBox()
      const cdp = await context.newCDPSession(p)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }] })
      await p.waitForTimeout(600)
      await menu.waitFor()
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await cdp.detach()
      await menu.waitFor()
      await p.waitForTimeout(350)
      await shot('hold')
      await p.keyboard.press('Escape')
      await menu.waitFor({ state: 'detached' })
    }
    await opener.click({ button: 'right' })
    await menu.waitFor()
    await p.locator('.ws-worker-message').click()
    await menu.waitFor({ state: 'detached' })
    assert.equal(await p.locator('.ws-worker-message').evaluate(el => el === document.activeElement), true, 'outside focus stays at the pressed control')
    // Observe native link activation without leaving the mocked board or invoking an app.
    await p.evaluate(() => {
      window.__menuLinks = []
      document.addEventListener('click', event => {
        const link = event.target.closest?.('a[href]')
        if (link?.href.startsWith('https://claude.ai')) {
          window.__menuLinks.push(link.href)
        }
      }, true)
    })
    await opener.focus()
    await p.keyboard.press('Shift+F10')
    await menu.waitFor()
    const browserLink = items.filter({ hasText: 'Open in Claude browser' })
    await browserLink.evaluate(el => el.addEventListener('click', event => event.preventDefault()))
    await browserLink.focus()
    await p.keyboard.press('Enter')
    await menu.waitFor({ state: 'detached' })
    assert.deepEqual(await p.evaluate(() => window.__menuLinks), ['https://claude.ai/code/session_fixture'])
    assert.equal(await p.evaluate(() => localStorage.getItem('shuttle.claude-opening')), 'browser')
    await opener.click({ button: 'right' })
    await menu.waitFor()
    assert.equal(await items.filter({ hasText: 'Open in Claude browser' }).evaluate(el => el === document.activeElement), true, 'the remembered destination starts focused')
    await p.keyboard.press('Tab')
    await menu.waitFor({ state: 'detached' })
    assert.equal(await p.evaluate(() => document.activeElement === document.body), false, 'Tab leaves focus on a page control')
    assert.deepEqual(errors, [])
    await context.close()
    console.log(`PASS SDK action menu (${phone ? 'phone' : 'desktop'}, ${theme})`)
  }
} finally { await browser.close() }
