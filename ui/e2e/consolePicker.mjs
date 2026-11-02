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
const consoleButton = p => selected(p).locator('.ws-chat-console')
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
  if (!await selected(p).locator('.ws-chat-head').isVisible()) {
    await p.locator('.ws-navbar .ws-channel-title').click()
    await p.locator('.ws-switcher .ws-channel-row[aria-current="true"]').click()
  }
  await consoleButton(p).waitFor({ state: 'visible' })
}
async function headerFits(p) {
  const geometry = await selected(p).locator('.ws-chat-head').evaluate(header => {
    const bounds = header.getBoundingClientRect()
    const controls = [...header.querySelectorAll('.ws-chat-console,.ws-chat-settings,.ws-chat-leave,.ws-chat-identity,.ws-chat-lead')]
      .filter(el => el.checkVisibility()).map(el => ({ name: el.className, rect: el.getBoundingClientRect().toJSON() }))
    const title = header.querySelector('.ws-chat-title').getBoundingClientRect()
    const console = header.querySelector('.ws-chat-console').getBoundingClientRect()
    return { bounds: bounds.toJSON(), controls, titleCenter: title.top + title.height / 2, consoleCenter: console.top + console.height / 2 }
  })
  for (const { name, rect } of geometry.controls) {
    assert.ok(rect.x >= geometry.bounds.x - 1 && rect.x + rect.width <= geometry.bounds.right + 1, `${name} fits header`)
  }
  if (p.viewportSize().width <= 700) assert.ok(Math.abs(geometry.titleCenter - geometry.consoleCenter) < 1, 'the phone title is centered on its Console icon')
  if (p.viewportSize().width <= 700) {
    const columns = await selected(p).locator('.ws-chat-head').evaluate(header => {
      const center = selector => { const el = header.querySelector(selector); if (!el?.checkVisibility()) return null; const b = el.getBoundingClientRect(); return b.x + b.width / 2 }
      return { settings: center('.ws-chat-settings'), leave: center('.ws-chat-leave'), constitution: center('.ws-chat-refs > .ws-chat-constitution'), report: center('.ws-chat-refs > .ws-report-chip') }
    })
    if (columns.constitution !== null) assert.ok(Math.abs(columns.constitution - columns.settings) < 1, 'the phone Constitution icon sits under Settings')
    if (columns.report !== null) assert.ok(Math.abs(columns.report - columns.leave) < 1, 'the phone report icon sits under Close')
  }
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
      localStorage.setItem('shuttle:workspace:sidebar', 'false')
      // Observe external opening without invoking installed apps or leaving the fixture.
      window.__conversationLinks = []
      const click = HTMLAnchorElement.prototype.click
      HTMLAnchorElement.prototype.click = function () {
        if (/^(https:\/\/claude.ai|claude:|codex:|chatgpt:|rex:|https:\/\/chatgpt.com)/.test(this.href)) {
          window.__conversationLinks.push(this.href)
        } else click.call(this)
      }
      document.addEventListener('click', event => {
        const link = event.target.closest?.('a[href]')
        if (link && /^(https:\/\/claude.ai|claude:|codex:|chatgpt:|rex:|https:\/\/chatgpt.com)/.test(link.href)) {
          window.__conversationLinks.push(link.href); event.preventDefault()
        }
      }, true)
    })
    const p = await context.newPage()
    p.setDefaultTimeout(10000)
    await open(p, phone ? 'tmux' : 'rex')
    await headerFits(p)
    assert.equal(await consoleButton(p).getAttribute('aria-label'), 'Open in Claude browser')
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
    assert.equal(await consoleButton(p).getAttribute('aria-label'), phone ? 'Open in Claude browser' : 'Open in Claude app')
    await consoleButton(p).click()
    assert.equal(await p.evaluate(() => window.__conversationLinks.length), 2)
    if (phone) {
      await selected(p).getByRole('button', { name: 'Constitution', exact: true }).click()
      await selected(p).getByRole('heading', { name: 'Validation notes', exact: true }).waitFor()
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
      assert.deepEqual(await p.locator('.set-opening-options input').evaluateAll(inputs => inputs.map(input => input.value)), ['rex', 'browser'])
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
    await open(p, 'chatgpt')
    assert.equal(await consoleButton(p).getAttribute('aria-label'), 'Open in ChatGPT')
    if (phone) await longPress(p, context, consoleButton(p))
    else await consoleButton(p).click({ button: 'right' })
    assert.equal(await items(p).count(), 1)
    await shot(p, phone ? 'phone-picker-chatgpt' : 'desktop-picker-chatgpt')
    const remembered = await p.evaluate(() => localStorage.getItem('shuttle.claude-opening'))
    await items(p).click()
    assert.equal(await p.evaluate(() => localStorage.getItem('shuttle.claude-opening')), remembered, 'a sole ChatGPT destination does not overwrite the Claude preference')
    if (!phone) {
      await open(p, 'tmux')
      await consoleButton(p).click({ button: 'right' })
      assert.match(await items(p).first().innerText(), /Terminal/)
      await shot(p, 'desktop-picker-terminal')
    } else {
      await open(p, 'rex')
      await longPress(p, context, consoleButton(p))
      assert.equal(await items(p).count(), 2)
      await shot(p, 'phone-picker-rex-claude')
      await items(p).filter({ hasText: 'Open in Rex' }).click()
      assert.equal(await p.evaluate(() => localStorage.getItem('shuttle.claude-opening')), 'rex')
      assert.equal(await consoleButton(p).getAttribute('aria-label'), 'Open in Rex')
      await shot(p, 'phone-header-rex')
      // These fixtures omit runtime.terminal: the local version supplies the backend.
      for (const harness of ['pi', 'codex']) {
        await open(p, `rex-${harness}`)
        await selected(p).locator('.ws-chat-console[aria-label="Open in Rex"]').waitFor()
        await consoleButton(p).click()
        assert.equal(await p.evaluate(() => window.__conversationLinks.at(-1)), 'rex://')
        await longPress(p, context, consoleButton(p))
        assert.equal(await items(p).count(), 1)
        assert.match(await items(p).innerText(), /Rex/)
        await shot(p, `phone-picker-rex-${harness}`)
        await p.keyboard.press('Escape')
      }
      await p.goto(`${base}&console=unlinked`)
      await p.locator('.kbn-desk .kbn-card').filter({ hasText: 'Calibrate the shear response' }).click()
      await selected(p).locator('.ws-chat-head').waitFor()
      assert.equal(await consoleButton(p).isVisible(), false)
      await shot(p, 'phone-header-no-destination')
    }
    await context.close()
    console.log(`PASS Console header, picker, remembered opening and ChatGPT (${phone ? 'phone' : 'desktop'})`)
  }
} finally { await browser.close() }
