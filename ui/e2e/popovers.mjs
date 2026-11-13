import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchBrowser } from './browser.mjs'

// The Settings dropdown and the document menu: SDK popovers, by pointer and keyboard, at both widths and in both themes.
const browser = await launchBrowser()
const url = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=workspace&console=rex`
const shots = process.env.UI_SDK_SHOTS
if (shots) await mkdir(shots, { recursive: true })
const focused = locator => locator.evaluate(el => el === document.activeElement)
try {
  for (const phone of [false, true]) for (const theme of ['light', 'dark']) {
    const tag = `${phone ? 'phone' : 'desktop'}-${theme}`
    const context = await browser.newContext({
      viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      hasTouch: phone, isMobile: phone, colorScheme: theme, reducedMotion: 'reduce',
    })
    const p = await context.newPage()
    p.setDefaultTimeout(10000)
    const errors = []
    p.on('pageerror', error => errors.push(error.message))
    const shot = async name => { if (shots) await p.screenshot({ path: resolve(shots, `after-${tag}-${name}.png`) }) }
    await p.goto(url)
    await p.locator('.kbn-desk .kbn-card:not(.kbn-card-header):has(.kbn-card-name[title*="Calibrate the shear response"])').click()
    const { width, height } = p.viewportSize()
    const frame = p.locator('.ws-page.ws-selected iframe').first()

    const gear = p.locator('.ws-page.ws-selected .fp-row[data-selected] > .fp-line .fp-verbs .ws-acts-settings')
    const settings = p.getByRole('dialog', { name: 'Settings' })
    await gear.click(); await settings.waitFor()
    await shot('settings')
    const [g, s] = [await gear.boundingBox(), await settings.boundingBox()]
    assert.ok(s.x >= 8 && s.x + s.width <= width - 8 + 0.5, `${tag}: Settings keeps its gutters`)
    assert.ok(Math.abs(s.y - (g.y + g.height + 6)) <= 1, `${tag}: Settings opens 6px under its row`)
    assert.ok(s.y + s.height <= height - 8 + 0.5, `${tag}: Settings ends above the viewport's bottom gutter`)
    await gear.click(); await settings.waitFor({ state: 'hidden' })
    assert.equal(await gear.getAttribute('aria-expanded'), 'false', `${tag}: the ⚙ toggles Settings closed`)
    await gear.focus(); await p.keyboard.press('Enter'); await settings.waitFor()
    assert.equal(await focused(settings), true, `${tag}: the keyboard lands on the Settings panel`)
    if (!phone) {
      const effort = settings.getByLabel('Effort', { exact: true })
      await effort.focus(); await p.keyboard.press('Enter')
      const list = p.getByRole('listbox', { name: 'Effort' }); await list.waitFor()
      await shot('select')
      await p.keyboard.press('Escape'); await list.waitFor({ state: 'detached' })
      assert.ok(await settings.isVisible(), `${tag}: Escape in a select list leaves Settings open`)
      assert.equal(await focused(effort), true)
      await settings.locator('.kbn-ctl-parent').click()
      const search = settings.getByRole('combobox', { name: 'Search parent fiber' })
      await search.waitFor()
      await search.fill('a')
      await p.waitForFunction(() => document.querySelector('[aria-label="Search parent fiber"]')?.getAttribute('aria-expanded') === 'true')
      await p.keyboard.press('Escape')
      await search.waitFor({ state: 'hidden' })
      assert.ok(await settings.isVisible(), `${tag}: Escape in the parent search leaves Settings open`)
    }
    await p.keyboard.press('Escape'); await settings.waitFor({ state: 'hidden' })
    assert.equal(await focused(gear), true, `${tag}: Escape returns to the ⚙`)
    await gear.focus(); await p.keyboard.press('Enter'); await settings.waitFor()
    for (let i = 0; i < 60 && await settings.isVisible(); i++) await p.keyboard.press('Tab')
    assert.equal(await settings.isVisible(), false, `${tag}: Tab past Settings closes it rather than leave focus beneath it`)
    if (!phone) {
      await gear.click(); await settings.waitFor()
      await frame.click({ position: { x: 20, y: 20 } })
      await settings.waitFor({ state: 'hidden' })
    }

    await p.locator('.ws-page[data-key$="/report.html"]').dispatchEvent('click')
    await p.locator('.ws-page.ws-selected[data-key$="/report.html"]').waitFor()
    const opener = phone ? p.locator('.ws-navbar .ws-phone-document-menu') : p.locator('.ws-page.ws-selected .ws-menu-button')
    const menu = p.getByRole('dialog', { name: 'Document menu' })
    await opener.click(); await menu.waitFor()
    await menu.locator('summary').click()
    await shot('document')
    const [o, m] = [await opener.boundingBox(), await menu.boundingBox()]
    assert.ok(Math.abs(m.x + m.width - (o.x + o.width)) <= 1 || m.x + m.width >= width - 12 - 0.5, `${tag}: the document menu ends at its ⋯`)
    assert.ok(m.y + m.height <= o.y - 5 || m.y >= o.y + o.height + 5, `${tag}: the document menu clears its ⋯`)
    assert.ok(m.y >= 12 - 0.5 && m.y + m.height <= height - 12 + 0.5, `${tag}: the document menu keeps its margin`)
    await opener.click(); await menu.waitFor({ state: 'hidden' })
    await opener.focus(); await p.keyboard.press('Enter'); await menu.waitFor()
    assert.equal(await menu.getByRole('link', { name: 'Open in new tab' }).evaluate(el => el === document.activeElement), true, `${tag}: the keyboard lands on the first action`)
    await p.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' })
    assert.equal(await focused(opener), true, `${tag}: Escape returns to the ⋯`)
    assert.ok(await p.locator('.ws-reader').isVisible(), `${tag}: Escape stays in the reader`)
    await opener.focus(); await p.keyboard.press('Enter'); await menu.waitFor()
    await menu.getByRole('button', { name: 'Refresh' }).focus(); await p.keyboard.press('Enter')
    await menu.waitFor({ state: 'hidden' })
    assert.equal(await focused(opener), true, `${tag}: an action returns focus to the ⋯`)
    await opener.focus(); await p.keyboard.press('Enter'); await menu.waitFor()
    for (let i = 0; i < 20 && await menu.isVisible(); i++) await p.keyboard.press('Tab')
    assert.equal(await menu.isVisible(), false, `${tag}: Tab past the document menu closes it`)
    assert.equal(await p.evaluate(() => document.activeElement !== document.body), true, `${tag}: Tab moves on from the ⋯, not to the page's end`)
    await opener.click(); await menu.waitFor()
    await frame.click({ position: { x: 20, y: phone ? 400 : 20 } })
    await menu.waitFor({ state: 'hidden' })
    assert.deepEqual(errors, [])
    await context.close()
  }
} finally { await browser.close() }
