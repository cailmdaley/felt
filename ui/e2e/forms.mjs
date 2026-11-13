import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchBrowser } from './browser.mjs'

const browser = await launchBrowser()
const stage = process.env.FORMS_STAGE ?? 'after'
const shots = resolve('../ui-sdk-shots')
await mkdir(shots, { recursive: true })
try {
  for (const phone of [false, true]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      hasTouch: phone, isMobile: phone, colorScheme: theme, reducedMotion: 'reduce',
    })
    const p = await context.newPage()
    p.setDefaultTimeout(10000)
    await p.goto(`${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=workspace`)
    const shot = async name => p.screenshot({ path: resolve(shots, `${stage}-${phone ? 'phone' : 'desktop'}-${theme}-${name}.png`) })
    await p.getByRole('button', { name: 'Stash a new fiber', exact: true }).click()
    const dialog = p.getByRole('dialog', { name: 'Stash a constitution' })
    await dialog.waitFor()
    if (phone) await p.setViewportSize({ width: 390, height: 844 })
    await shot('stash')
    await p.locator('.form-select').nth(1).selectOption({ label: 'loom' })
    const parent = p.getByRole('combobox', { name: 'Parent fiber' })
    await parent.click()
    await p.locator('.stash-parent-dropdown').waitFor()
    await parent.fill('workspace')
    await p.getByRole('listbox').waitFor()
    await p.keyboard.press('ArrowDown')
    await shot('parent')
    if (stage === 'after') {
      const active = await parent.getAttribute('aria-activedescendant')
      assert.ok(active)
      assert.equal(await p.locator(`[id="${active}"]`).getAttribute('role'), 'option')
      await p.keyboard.press('Enter')
      assert.equal(await parent.evaluate(el => el === document.activeElement), true)
      await p.keyboard.press('ArrowDown')
    }
    await p.keyboard.press('Escape')
    await dialog.waitFor()
    if (stage === 'after') {
      const tags = p.getByRole('combobox', { name: 'Tags', exact: true })
      await tags.fill('work')
      await p.keyboard.press('ArrowDown')
      await shot('tags-suggestions')
      await p.keyboard.press('Escape')
      await tags.fill('custom-tag')
      await p.keyboard.press('Enter')
      await p.getByRole('button', { name: 'Remove tag custom-tag' }).waitFor()
      await shot('tags-chips')
      await p.keyboard.press('Backspace')
      await p.getByRole('button', { name: 'Remove tag custom-tag' }).waitFor({ state: 'detached' })
      await p.keyboard.press('Escape')
    }
    await p.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    await p.getByRole('button', { name: 'Settings', exact: true }).click()
    await p.getByRole('dialog', { name: 'Settings', exact: true }).waitFor()
    await shot('settings')
    await context.close()
  }
} finally { await browser.close() }
