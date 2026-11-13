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
    await p.locator('.kbn-desk .kbn-card:not(.kbn-card-header)').first().waitFor({ state: 'attached' })

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

    // Role picker: its trap includes links and selects; Escape leaves without writing.
    await p.evaluate(() => {
      const row = document.querySelector('.kbn-desk .kbn-card:not(.kbn-card-header)')
      const transfer = new DataTransfer()
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }))
      document.querySelector('.kbn-section-roles').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }))
      row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }))
    })
    const role = p.getByRole('dialog', { name: /^Choose a role for/ })
    await role.getByRole('button', { name: /Analyst/ }).waitFor(); await boardInert(p)
    const filter = role.getByRole('searchbox', { name: 'Filter roles' })
    assert.equal(await focused(filter), true, 'role picker opens on its filter')
    await p.keyboard.press('ArrowDown')
    assert.equal(await focused(role.getByRole('button', { name: /Analyst/ })), true, 'ArrowDown walks the roles')
    await shot('role')
    await role.evaluate(el => {
      const link = document.createElement('a'); link.href = '#'; link.textContent = 'Role charter'
      const select = document.createElement('select'); select.setAttribute('aria-label', 'Office scope')
      select.append(new Option('All hosts', 'all'))
      el.querySelector('.kbn-role-popover').append(link, select)
    })
    await role.getByRole('button', { name: 'Cancel', exact: true }).focus()
    await p.keyboard.press('Tab'); assert.equal(await focused(role.getByRole('link', { name: 'Role charter' })), true, 'role trap includes links')
    await p.keyboard.press('Tab'); assert.equal(await focused(role.getByRole('combobox', { name: 'Office scope' })), true, 'role trap includes selects')
    await p.keyboard.press('Tab'); assert.equal(await focused(filter), true, 'role trap wraps to the filter')
    await p.keyboard.press('Escape'); await role.waitFor({ state: 'detached' })

    // Rest calendar: the vim keys move its cursor and survive a click on a day.
    await p.keyboard.press('j')
    await p.evaluate(() => document.activeElement.setAttribute('data-rest-opener', ''))
    await p.keyboard.press('s')
    const rest = p.getByRole('dialog', { name: /^Rest / })
    await rest.waitFor(); await boardInert(p)
    const headline = rest.locator('.kbn-rest-headline')
    const tomorrow = await headline.textContent()
    await p.keyboard.press('3'); await p.keyboard.press('j'); await p.keyboard.press('l')
    assert.match(await headline.textContent(), /in 23 days/, '3j then l moves 22 days past tomorrow')
    await p.keyboard.press('t')
    assert.equal(await headline.textContent(), tomorrow, 't jumps back to tomorrow')
    await rest.locator('.kbn-rest-day:not([disabled])').nth(5).click()
    const clicked = await headline.textContent()
    await p.keyboard.press('l')
    assert.notEqual(await headline.textContent(), clicked, 'vim keys still move after a click on a day')
    await shot('rest')
    await rest.getByRole('button', { name: 'Rest', exact: true }).focus()
    await p.keyboard.press('Tab')
    assert.equal(await focused(rest.getByRole('button', { name: 'Tomorrow t', exact: true })), true, 'Tab wraps to the presets')
    await p.keyboard.press('Escape'); await rest.waitFor({ state: 'detached' })
    assert.equal(await focused(p.locator('[data-rest-opener]')), true, 'Escape returns focus to where it was')

    // Sent files, on the phone's reader: the native modal makes the reader inert, Tab wraps, Back closes it.
    if (phone) {
      await p.goto(`${harness}?example=threads`)
      await p.locator('.kbn-desk .kbn-card:not(.kbn-card-header) .kbn-card-name[title*="Calibrate the shear response"]').first().click()
      const opener = p.locator('.ws-navbar .ws-files-toggle')
      await opener.click()
      const files = p.locator('.ws-page-sheet[open]')
      await files.waitFor()
      assert.equal(await p.evaluate(() => {
        const outside = document.querySelector('.ws-navbar button:not(.ws-files-toggle)')
        outside.focus(); return document.activeElement === outside
      }), false, 'the reader behind the sheet takes no focus')
      const controls = files.locator('button:visible')
      await controls.last().focus(); await p.keyboard.press('Tab')
      assert.equal(await focused(controls.first()), true, 'Tab wraps inside the sheet')
      await p.keyboard.press('Shift+Tab')
      assert.equal(await focused(controls.last()), true, 'Shift+Tab wraps inside the sheet')
      await shot('files')
      await p.goBack(); await files.waitFor({ state: 'detached' })
      assert.equal(await focused(opener), true, 'Back returns focus to the opener')
      await opener.click(); await files.waitFor()
      await p.keyboard.press('Escape'); await files.waitFor({ state: 'detached' })
      assert.equal(await focused(opener), true, 'Escape returns focus to the opener')
      assert.equal(await p.evaluate(() => window.history.state?.shuttlePageSheet), undefined, 'Escape spends the sheet history entry')
    }
    await context.close()
    console.log(`PASS modal overlays (${phone ? 'phone' : 'desktop'}, ${theme})`)
  }
} finally { await browser.close() }
