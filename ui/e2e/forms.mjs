import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchBrowser } from './browser.mjs'

// The React form islands: Capture, Stash (kind radios, add-path row, parent
// autocomplete, tag chips) and the settings sheet, by keyboard and pointer.
const browser = await launchBrowser()
const url = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=workspace`
const shots = process.env.UI_SDK_SHOTS
if (shots) await mkdir(shots, { recursive: true })
const focused = locator => locator.evaluate(el => el === document.activeElement)
try {
  for (const phone of [false, true]) for (const theme of ['light', 'dark']) {
    // The Desk's Stash and New idea buttons live at desktop width, so each
    // form opens there and a phone context then narrows to the sheet.
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      hasTouch: phone, isMobile: phone, colorScheme: theme, reducedMotion: 'reduce',
    })
    const p = await context.newPage()
    p.setDefaultTimeout(10000)
    const errors = []
    p.on('pageerror', error => errors.push(error.message))
    await p.goto(url)
    const shot = async name => {
      if (shots) await p.screenshot({ path: resolve(shots, `after-${phone ? 'phone' : 'desktop'}-${theme}-${name}.png`) })
    }

    await p.getByRole('button', { name: 'New idea — speak it into a card', exact: true }).click()
    const capture = p.getByRole('dialog', { name: 'New idea', exact: true })
    await capture.waitFor()
    assert.equal(await focused(capture.locator('textarea').first()), true, 'Capture opens on its yap')
    await p.keyboard.press('Escape')
    await capture.waitFor({ state: 'detached' })

    await p.getByRole('button', { name: 'Stash a new fiber', exact: true }).click()
    const dialog = p.getByRole('dialog', { name: 'Stash a constitution' })
    await dialog.waitFor()
    assert.equal(await p.getByRole('button', { name: 'Stash a new fiber', exact: true })
      .evaluate(el => !!el.closest('[inert]')), true, 'the board is inert under the dialog')
    if (phone) await p.setViewportSize({ width: 390, height: 844 })
    await shot('stash')

    // Tab belongs to the dialog, not to the Desk's column navigation behind it.
    const title = dialog.locator('.stash-title')
    await title.focus()
    await p.keyboard.press('Tab')
    assert.equal(await focused(dialog.locator('textarea')), true, 'Tab moves from Title to Body')

    const oneshot = p.getByRole('radio', { name: 'One-shot lands in Drafts' })
    const standing = p.getByRole('radio', { name: 'Standing on a schedule' })
    await oneshot.focus()
    await p.keyboard.press('ArrowRight')
    assert.equal(await standing.isChecked(), true)
    assert.equal(await focused(standing), true)
    await shot('kind')
    await p.keyboard.press('ArrowLeft')
    assert.equal(await oneshot.isChecked(), true)

    // A field that spends Escape keeps it from the dialog.
    await dialog.locator('.form-select').nth(1).selectOption({ value: '__add_project__' })
    const addPath = dialog.locator('.projpick-addpath-input')
    await addPath.focus()
    await p.keyboard.press('Escape')
    await addPath.waitFor({ state: 'detached' })
    assert.equal(await dialog.isVisible(), true, 'Escape in the add-path row leaves the dialog open')

    await dialog.locator('.form-select').nth(1).selectOption({ label: 'loom' })
    const parent = p.getByRole('combobox', { name: 'Parent fiber' })
    await parent.click()
    await dialog.locator('.stash-parent-dropdown').waitFor()
    await parent.fill('no-such-fiber')
    await p.getByText('No matches', { exact: true }).waitFor()
    await parent.fill('workspace')
    await p.getByRole('option', { name: /calibration-report/ }).waitFor()
    await p.keyboard.press('ArrowDown')
    const active = await parent.getAttribute('aria-activedescendant')
    assert.ok(active, 'the highlighted parent is announced')
    assert.equal(await p.locator(`[id="${active}"]`).getAttribute('role'), 'option')
    await shot('parent')
    await p.keyboard.press('Enter')
    assert.equal(await parent.inputValue(), 'research/workspace/calibration-report')
    assert.equal(await focused(parent), true)
    await p.keyboard.press('ArrowDown')
    assert.equal(await parent.getAttribute('aria-expanded'), 'true')
    await p.keyboard.press('Escape')
    assert.equal(await parent.getAttribute('aria-expanded'), 'false')
    assert.equal(await dialog.isVisible(), true, 'the first Escape closes only the list')

    const tags = p.getByRole('combobox', { name: 'Tags', exact: true })
    await tags.focus()
    assert.equal(await tags.getAttribute('aria-expanded'), 'false', 'no suggestions before typing')
    await tags.fill('work')
    await p.keyboard.press('ArrowDown')
    const option = p.getByRole('option', { name: 'workspace', exact: true })
    await option.waitFor()
    assert.equal(await tags.getAttribute('aria-activedescendant'), await option.getAttribute('id'))
    await shot('tags-suggestions')
    await p.keyboard.press('Enter')
    await tags.fill('custom-tag')
    await p.keyboard.press('Enter')
    await p.getByRole('button', { name: 'Remove tag custom-tag' }).waitFor()
    await shot('tags-chips')
    await p.getByRole('button', { name: 'Remove tag workspace' }).click()
    assert.equal(await focused(tags), true, 'removing a chip returns focus to the field')
    assert.equal(await p.getByRole('button', { name: 'Remove tag workspace' }).count(), 0)

    await p.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })

    await p.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = p.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.waitFor()
    await shot('settings')
    const done = settings.getByRole('button', { name: 'Done', exact: true })
    await done.focus()
    await p.keyboard.press('Tab')
    assert.equal(await settings.evaluate(el => el.contains(document.activeElement)), true, 'Tab stays in settings')
    assert.equal(await focused(done), false, 'Tab moves within settings')
    await p.keyboard.press('Escape')
    await settings.waitFor({ state: 'detached' })

    assert.deepEqual(errors, [])
    console.log(`PASS forms: ${phone ? 'phone' : 'desktop'}, ${theme}`)
    await context.close()
  }
} finally { await browser.close() }
