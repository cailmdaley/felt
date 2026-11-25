import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchBrowser } from './browser.mjs'

// The board's modal overlays in a real browser: the board behind each one is
// inert, Tab stays inside, Escape closes it and focus returns to its opener.
const harness = pathToFileURL(resolve('harness-board-dist/index.html')).href
const shots = process.env.UI_SDK_SHOTS
if (shots) await mkdir(shots, { recursive: true })
const focused = locator => locator.evaluate(el => el === document.activeElement)
const boardInert = page => page.waitForFunction(() => !!document.querySelector('.kbn-desk')?.closest('[inert]'))

/** Press inside a dialog, drag to the page's top-left corner (its scrim) and release there. */
const dragToScrim = async (page, from) => {
  const box = await from.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down(); await page.mouse.move(4, 4, { steps: 4 }); await page.mouse.up()
}

const browser = await launchBrowser()
try {
  for (const phone of [false, true]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({
      viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      hasTouch: phone, isMobile: phone, colorScheme: theme, reducedMotion: 'reduce',
    })
    const p = await context.newPage()
    p.setDefaultTimeout(10000)
    const shot = async name => {
      if (shots) await p.screenshot({ path: resolve(shots, `after-${name}-${phone ? 'phone' : 'desktop'}-${theme}.png`) })
    }
    await p.goto(`${harness}?example=workspace`)
    await p.locator('.kbn-desk .kbn-family').first().waitFor({ state: 'attached' })

    // Keyboard help: Tab cycles every control in the sheet, not only Close.
    await p.keyboard.press('?')
    const help = p.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true })
    await help.waitFor(); await boardInert(p)
    await shot('help')
    await help.evaluate(el => {
      const link = document.createElement('a'); link.href = '#'; link.textContent = 'Help details'
      el.querySelector('header').append(link)
    })
    const helpClose = help.getByRole('button', { name: 'Close', exact: true }), helpLink = help.getByRole('link', { name: 'Help details' })
    assert.equal(await focused(helpClose), true, 'help opens on Close')
    await p.keyboard.press('Tab'); assert.equal(await focused(helpLink), true, 'help Tab reaches a link')
    await p.keyboard.press('Tab'); assert.equal(await focused(helpClose), true, 'help Tab wraps')
    await p.keyboard.press('Shift+Tab'); assert.equal(await focused(helpLink), true, 'help Shift+Tab wraps')
    await p.keyboard.press('Escape'); await help.waitFor({ state: 'detached' })

    // Rest calendar, from a constitution's view: the vim keys move its cursor and survive a click on a day.
    await p.locator('.kbn-desk .kbn-family > :first-child').first().click()
    await p.locator('.ws-page.ws-selected .ov-head').waitFor()
    await p.evaluate(() => document.activeElement.setAttribute('data-rest-opener', ''))
    await p.keyboard.press('s')
    const rest = p.getByRole('dialog', { name: /^Rest / })
    await rest.waitFor(); await boardInert(p)
    const headline = rest.locator('.kbn-rest-headline')
    assert.match(await headline.textContent(), /^No date/, 'the calendar opens on no date')
    await p.keyboard.press('3'); await p.keyboard.press('j'); await p.keyboard.press('l')
    assert.match(await headline.textContent(), /in 23 days/, '3j then l moves 22 days past tomorrow')
    await p.keyboard.press('t')
    assert.match(await headline.textContent(), / tomorrow$/, 't jumps back to tomorrow')
    await p.keyboard.press('L')
    const beforeClick = await headline.textContent()
    await rest.locator('.kbn-rest-day:not([disabled]):not(.kbn-rest-day-cursor)').first().click()
    const clicked = await headline.textContent()
    assert.notEqual(clicked, beforeClick, 'clicking a day selects it')
    await p.keyboard.press('l')
    assert.notEqual(await headline.textContent(), clicked, 'vim keys still move after a click on a day')
    await shot('rest')
    if (!phone) {
      await dragToScrim(p, headline)
      assert.equal(await rest.isVisible(), true, 'a drag from the calendar out onto the scrim leaves it open')
    }
    await rest.getByRole('button', { name: 'Rest', exact: true }).focus()
    await p.keyboard.press('Tab')
    assert.equal(await focused(rest.getByRole('button', { name: 'Tomorrow t', exact: true })), true, 'Tab wraps to the presets')
    await p.keyboard.press('Escape'); await rest.waitFor({ state: 'detached' })
    assert.equal(await focused(p.locator('[data-rest-opener]')), true, 'Escape returns focus to where it was')

    // Sent files, on the phone's reader: the top bar's list takes the focus, and Escape returns it to the opener.
    if (phone) {
      await p.goto(`${harness}?example=threads`)
      await p.locator('.kbn-desk .kbn-family[title*="Calibrate the shear response"] > :first-child').first().click()
      const opener = p.locator('.ws-navbar .ws-files-toggle')
      await opener.click()
      const files = p.locator('.kbn-conversation-menu:has(.uf-file-row)')
      await files.waitFor()
      assert.equal(await files.evaluate(el => el.contains(document.activeElement)), true, 'the list takes the focus')
      await shot('files')
      const entries = await p.evaluate(() => navigation.entries().length)
      await p.keyboard.press('Escape'); await files.waitFor({ state: 'detached' })
      assert.equal(await focused(opener), true, 'Escape returns focus to the opener')
      await opener.click(); await files.waitFor()
      assert.equal(await p.evaluate(() => navigation.entries().length), entries, 'the list keeps no history entry')
      // Back leaves the reader, and the list with it.
      await p.goBack(); await files.waitFor({ state: 'detached' })
      await p.locator('.ws-reader.ws-dormant').waitFor()
    }
    await context.close()
    console.log(`PASS modal overlays (${phone ? 'phone' : 'desktop'}, ${theme})`)
  }
} finally { await browser.close() }
