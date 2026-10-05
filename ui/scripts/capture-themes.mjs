import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

// Accepts a read-only Vite preview or the mocked, file:// workspace harness.
// Theme overrides exist only in Vite's development build and harness fixtures.
const [base, uid, owner, output] = process.argv.slice(2)
if (!base || !uid || !owner || !output) throw new Error('Usage: node scripts/capture-themes.mjs <preview-url> <uid> <owner> <output-dir>')
const directory = resolve(output)
await mkdir(directory, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--allow-file-access-from-files'] })
const themes = ['portolan', 'blueprint', 'laboratory-paper', 'night-chart']
const viewports = [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]
try {
  for (const theme of themes) for (const [device, viewport] of viewports) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' })
    const page = await context.newPage()
    const url = new URL(base)
    url.searchParams.set('theme-preview', `${uid}:${theme}`)
    url.hash = `/board/${encodeURIComponent(uid)}@${encodeURIComponent(owner)}/${encodeURIComponent(`fiber:${owner}:${uid}`)}`
    await page.goto(url.href, { waitUntil: 'domcontentloaded' })
    await page.locator('.ws-selected .ws-prose').waitFor()
    await page.waitForFunction(theme => document.querySelector('.ws-reader')?.dataset.wsThemeName === theme, theme)
    await page.waitForFunction(() => !document.querySelector('.ws-selected .ws-body-status'))
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: resolve(directory, `${theme}-${device}.png`) })
    console.log(`${theme}-${device}`)
    await context.close()
  }
  for (const [device, viewport] of viewports) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' })
    const page = await context.newPage()
    await page.goto(`${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=workspace`)
    await page.locator('[data-view="shelf"]').click()
    await page.locator('.ws-overview-folio[data-ws-theme-name="night-chart"]').waitFor()
    await page.getByRole('radio', { name: 'Hosts', exact: true }).click()
    await page.locator('.ws-overview').evaluate(el => { el.scrollTop = 430 })
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(700)
    await page.screenshot({ path: resolve(directory, `mixed-folios-${device}.png`) })
    await page.locator('.ws-overview-folio[data-uid="01KVBR1F9BWBVKF97473PV67K8"]').click()
    await page.getByRole('tab', { name: 'Constitution', exact: true }).click()
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.ws-reader')).getPropertyValue('--ws-custom-ready').trim() === '1')
    await page.screenshot({ path: resolve(directory, `custom-flourish-${device}.png`) })
    console.log(`mixed-folios-${device}, custom-flourish-${device}`)
    await context.close()
  }
} finally { await browser.close() }
