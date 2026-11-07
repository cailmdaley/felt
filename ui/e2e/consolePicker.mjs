import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getBrowser } from './browser.mjs'

const browser = await getBrowser({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--allow-file-access-from-files'] })
const base = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=workspace`
const shots = process.env.CONSOLE_PICKER_SHOTS
if (shots) await mkdir(shots, { recursive: true })
const selected = p => p.locator('.ws-page.ws-selected')
const band = p => p.locator('.ws-stage-band')
const consoleButton = p => band(p).locator('.ws-band-open')
const items = p => p.getByRole('menuitemradio')
async function shot(p, name) {
  if (await items(p).count()) await pickerReadable(p, false)
  if (shots) await p.screenshot({ path: resolve(shots, `${name}.png`) })
}
async function pickerReadable(p, requireFocus = true) {
  const geometry = await items(p).evaluateAll(items => items.map(item => ({
    checked: item.getAttribute('aria-checked') === 'true', focused: item === document.activeElement,
    labelX: item.querySelector('.kbn-conversation-label').getBoundingClientRect().x,
  })))
  if (requireFocus || geometry.some(item => item.focused)) assert.ok(geometry.find(item => item.checked)?.focused, 'the checked destination owns focus')
  assert.ok(Math.max(...geometry.map(item => item.labelX)) - Math.min(...geometry.map(item => item.labelX)) < 1, 'all destination labels share one column')
}
async function open(p, backend) {
  await p.goto(`${base}&console=${backend}`)
  await p.locator('.kbn-desk .kbn-card').filter({ hasText: 'Calibrate the shear response' }).click()
  await consoleButton(p).waitFor({ state: 'visible' })
}
async function headerFits(p) {
  const geometry = await band(p).locator('.ws-band-head').evaluate(header => {
    const bounds = header.getBoundingClientRect()
    const controls = [...header.querySelectorAll('.ws-band-open,.ws-band-settings,.ws-band-leave,.ws-band-identity')]
      .filter(el => el.checkVisibility()).map(el => ({ name: el.className, rect: el.getBoundingClientRect().toJSON() }))
    return { bounds: bounds.toJSON(), controls }
  })
  const controls = geometry.controls
  for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
    const a = controls[i].rect, b = controls[j].rect
    assert.ok(Math.min(a.right, b.right) - Math.max(a.x, b.x) <= 1 || Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) <= 1,
      `${controls[i].name} and ${controls[j].name} do not overlap`)
  }
  const opening = await consoleButton(p).boundingBox()
  assert.ok(opening.x >= geometry.bounds.x - 1 && opening.x + opening.width <= geometry.bounds.right + 1, 'the opening fits the band')
}
async function longPress(p, context, locator) {
  await locator.click({ trial: true })
  await p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const bounds = await locator.boundingBox()
  const cdp = await context.newCDPSession(p)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }] })
  // The gesture being tested is a hold, not a wait for application state.
  await p.waitForTimeout(600)
  await p.getByRole('menu').waitFor()
  await pickerReadable(p)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
  await p.getByRole('menu').waitFor()
}

try {
  for (const phone of [true, false]) {
    const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      hasTouch: phone, isMobile: phone, reducedMotion: 'reduce', colorScheme: 'light' })
    await context.addInitScript(() => {
      localStorage.setItem('shuttle.claude-opening', 'browser')
      // Observe external opening without invoking installed apps or leaving the fixture.
      window.__conversationLinks = []
      const click = HTMLAnchorElement.prototype.click
      HTMLAnchorElement.prototype.click = function () {
        if (/^(https:\/\/claude.ai|claude:|rex:)/.test(this.href)) {
          window.__conversationLinks.push(this.href)
        } else click.call(this)
      }
      document.addEventListener('click', event => {
        const link = event.target.closest?.('a[href]')
        if (link && /^(https:\/\/claude.ai|claude:|rex:)/.test(link.href)) {
          window.__conversationLinks.push(link.href); event.preventDefault()
        }
      }, true)
    })
    const p = await context.newPage()
    p.setDefaultTimeout(10000)
    await open(p, phone ? 'tmux' : 'rex')
    await headerFits(p)
    assert.equal(await consoleButton(p).textContent(), 'Open in Claude browser')
    await shot(p, phone ? 'phone-header' : 'desktop-header')
    if (phone) await longPress(p, context, consoleButton(p))
    else await consoleButton(p).click({ button: 'right' })
    assert.equal(await items(p).count(), phone ? 1 : 3)
    assert.equal(await items(p).filter({ hasText: 'Claude browser' }).getAttribute('aria-checked'), 'true')
    if (!phone) assert.match(await items(p).first().innerText(), /Rex/)
    await shot(p, phone ? 'phone-picker-long-press' : 'desktop-picker-rex')
    await items(p).filter({ hasText: phone ? 'Claude browser' : 'Claude app' }).click()
    assert.equal(await p.evaluate(() => localStorage.getItem('shuttle.claude-opening')), phone ? 'browser' : 'app')
    assert.equal(await p.evaluate(() => window.__conversationLinks.at(-1)), phone ? 'https://claude.ai/code/session_fixture' : 'claude://claude.ai/code/session_fixture')
    assert.equal(await consoleButton(p).textContent(), phone ? 'Open in Claude browser' : 'Open in Claude app')
    const opened = await p.evaluate(() => window.__conversationLinks.length)
    await consoleButton(p).click()
    assert.equal(await p.evaluate(() => window.__conversationLinks.length), opened + 1)
    if (phone) {
      await band(p).getByRole('button', { name: 'Constitution', exact: true }).click()
      await selected(p).locator('.ws-fiber-prose').waitFor()
      const pill = p.locator('.ws-navbar .ws-head-worker .kbn-card-worker')
      assert.match(await pill.getAttribute('aria-label'), /^\w+\. Open in Claude browser$/, 'the pill names its turn')
      assert.equal(await pill.getAttribute('target'), null, 'a phone opens Claude in place so iOS can hand it to the app')
      assert.equal(await pill.evaluate(el => getComputedStyle(el).userSelect), 'none', 'the held pill is a picker anchor, not text')
      await shot(p, 'phone-reader-pill')
      await longPress(p, context, pill)
      assert.equal(await items(p).count(), 1)
      await shot(p, 'phone-reader-pill-picker')
      await p.keyboard.press('Escape')
      await p.goto(base)
      await p.locator('.kbn-viewtabs-settings').click()
      await p.getByRole('heading', { name: 'Open conversations in', exact: true }).waitFor()
      assert.deepEqual(await p.locator('.set-opening-options input').evaluateAll(inputs => inputs.map(input => input.value)), ['browser'])
      await shot(p, 'phone-settings')
      await p.keyboard.press('Escape')
    } else {
      await p.locator('.kbn-viewtabs-settings').click()
      await p.getByRole('heading', { name: 'Open conversations in', exact: true }).waitFor()
      await shot(p, 'desktop-settings')
      await p.locator('.set-opening-tip').scrollIntoViewIfNeeded()
      await shot(p, 'desktop-settings-guidance')
      await p.keyboard.press('Escape')
    }
    if (!phone) {
      await open(p, 'tmux')
      await consoleButton(p).click({ button: 'right' })
      assert.match(await items(p).first().innerText(), /Terminal/)
      await shot(p, 'desktop-picker-terminal')
    }
    await context.close()
    console.log(`PASS Console header, picker and remembered opening (${phone ? 'phone' : 'desktop'})`)
  }
} finally { await browser.close() }
