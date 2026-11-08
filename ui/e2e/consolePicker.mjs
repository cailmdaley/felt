import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchBrowser } from './browser.mjs'

const browser = await launchBrowser()
const base = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=workspace`
const shots = process.env.CONSOLE_PICKER_SHOTS
if (shots) await mkdir(shots, { recursive: true })
const selected = p => p.locator('.ws-page.ws-selected')
const band = p => p.locator('.ws-stage-band')
const pill = p => p.locator('.ws-navbar .ws-head-worker .kbn-card-worker')
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
  await p.locator(`.kbn-desk .kbn-card:not(.kbn-card-header):has(.kbn-card-name[title*="Calibrate the shear response"])`).click()
  await band(p).locator('.ws-band-head').waitFor({ state: 'visible' })
}
async function headerFits(p) {
  const geometry = await band(p).locator('.ws-band-head').evaluate(header => {
    const bounds = header.getBoundingClientRect()
    const controls = [...header.querySelectorAll('.listen-control,.kbn-ctl-verdict,.ws-band-settings,.ws-band-leave,.ws-band-identity')]
      .filter(el => el.checkVisibility()).map(el => ({ name: el.className, rect: el.getBoundingClientRect().toJSON() }))
    return { bounds: bounds.toJSON(), controls, opening: header.querySelectorAll('.ws-band-open').length }
  })
  assert.equal(geometry.opening, 0, 'the console draws no opening; following and c reach the conversation')
  const controls = geometry.controls
  for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
    const a = controls[i].rect, b = controls[j].rect
    assert.ok(Math.min(a.right, b.right) - Math.max(a.x, b.x) <= 1 || Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) <= 1,
      `${controls[i].name} and ${controls[j].name} do not overlap`)
  }
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
    await open(p, 'rex')
    await headerFits(p)
    await shot(p, phone ? 'phone-header' : 'desktop-header')
    // c opens the conversation where the remembered opening says.
    await p.keyboard.press('c')
    assert.equal(await p.evaluate(() => window.__conversationLinks.at(-1)), 'https://claude.ai/code/session_fixture')
    if (phone) {
      await band(p).getByRole('button', { name: 'Constitution', exact: true }).click()
      await selected(p).locator('.ws-fiber-prose').waitFor()
      assert.match(await pill(p).getAttribute('aria-label'), /^\w+\. Open in Claude browser$/, 'the pill names its turn')
      assert.equal(await pill(p).getAttribute('target'), null, 'a phone opens Claude in place so iOS can hand it to the app')
      assert.equal(await pill(p).evaluate(el => getComputedStyle(el).userSelect), 'none', 'the held pill is a picker anchor, not text')
      await shot(p, 'phone-reader-pill')
      assert.equal(await pill(p).locator('.ws-worker-console').textContent(), '›_', 'the plate shows it opens a console')
      await longPress(p, context, pill(p))
      assert.deepEqual(await items(p).locator('.kbn-conversation-label').allTextContents(), ['Open in Claude browser', 'Open in Rex'])
      assert.equal(await items(p).nth(1).getAttribute('href'), 'shortcuts://run-shortcut?name=Rex', 'Rex for iOS opens through its Shortcut')
      await shot(p, 'phone-reader-pill-picker')
      await p.keyboard.press('Escape')
      await p.goto(base)
      await p.locator('.kbn-viewtabs-settings').click()
      await p.getByRole('heading', { name: 'Open conversations in', exact: true }).waitFor()
      assert.deepEqual(await p.locator('.set-opening-options input').evaluateAll(inputs => inputs.map(input => input.value)), ['browser', 'rex'])
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
    await context.close()
    console.log(`PASS Console header, c, picker and remembered opening (${phone ? 'phone' : 'desktop'})`)
  }
} finally { await browser.close() }
