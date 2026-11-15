import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

// Vite previews are read-only: theme overrides never edit real constitutions.
// Custom CSS uses the fixture channel, independently of the live capture UID.
const [base, uid, owner, output, mode = 'all'] = process.argv.slice(2)
if (!base || !uid || !owner || !output || !['all', 'bundled', 'custom'].includes(mode)) {
  throw new Error('Usage: node scripts/capture-themes.mjs <preview-url> <uid> <owner> <output-dir> [all|bundled|custom]')
}
const directory = resolve(output)
await mkdir(directory, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--allow-file-access-from-files'] })
const themes = ['portolan', 'blueprint', 'laboratory-paper', 'night-chart']
const viewports = [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]
const harness = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=workspace`
const manifest = []
let complete = false
const isLive = new URL(base).protocol !== 'file:'
async function contextFor(viewport) {
  return browser.newContext({ viewport, reducedMotion: 'reduce', hasTouch: viewport.width <= 700, isMobile: viewport.width <= 700 })
}
async function settle(page) {
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(300)
}
async function capture(page, file, source, extra = {}) {
  await settle(page)
  await page.screenshot({ path: resolve(directory, file) })
  manifest.push({ file, source, ...extra })
  console.log(file)
}
try {
  if (mode !== 'custom') {
    for (const theme of themes) for (const [device, viewport] of viewports) {
      const context = await contextFor(viewport)
      const page = await context.newPage()
      const url = new URL(base)
      url.searchParams.set('theme-preview', `${uid}:${theme}`)
      url.hash = `/board/${encodeURIComponent(uid)}@${encodeURIComponent(owner)}/${encodeURIComponent(`fiber:${owner}:${uid}`)}`
      await page.goto(url.href, { waitUntil: 'domcontentloaded' })
      await page.locator('.ws-selected .ws-prose').waitFor()
      await page.waitForFunction(theme => document.querySelector('.ws-reader')?.dataset.wsThemeName === theme, theme)
      await page.waitForFunction(() => !document.querySelector('.ws-selected .ws-body-status'))
      await capture(page, `${theme}-${device}.png`, isLive ? 'live-vite' : 'fixture-harness', { uid, owner, theme })
      await context.close()
    }
  }
  if (mode !== 'bundled') for (const [device, viewport] of viewports) {
    const context = await contextFor(viewport)
    const page = await context.newPage()
    await page.goto(harness)
    await page.locator('.kbn-desk .kbn-card').filter({ hasText: 'Calibrate the shear response' }).click()
    if (await page.locator('.ws-page-choice').isVisible()) {
      await page.locator('.ws-page-choice').click()
      await page.locator('.ws-page-sheet-row').filter({ has: page.locator('.ws-page-sheet-title', { hasText: 'Constitution' }) }).click()
    } else await page.getByRole('tab', { name: 'Constitution', exact: true }).click()
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.ws-reader')).getPropertyValue('--ws-custom-ready').trim() === '1')
    await capture(page, `custom-flourish-${device}.png`, 'fixture-harness', { uid: '01KVBR1F9BWBVKF97473PV67K8', owner: 'umber-workstation' })
    await context.close()
  }
  complete = true
} finally {
  await browser.close()
  await writeFile(resolve(directory, `capture-${mode}.json`), JSON.stringify({ capturedAt: new Date().toISOString(), complete, preview: base, captures: manifest }, null, 2) + '\n')
}
