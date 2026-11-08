// Captures the board's type across its surfaces: the Desk, a constitution
// under its band, pinned Listen and the settings sheet, at 1440 and 390 in
// both colour schemes.
//
//   npm run harness:board && node e2e/typeCaptures.mjs <out-dir>
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchBrowser } from './browser.mjs'

const out = resolve(process.argv[2] ?? 'type-captures')
const base = pathToFileURL(resolve('harness-board-dist/index.html')).href
const root = 'Calibrate the shear response across independent sky patches and validate each redshift bin'
const viewports = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } }
const settle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))

async function openRoot(page) {
  // Click the row's own name: its crumb leads to the root.
  const name = page.locator(`.kbn-desk .kbn-card:not(.kbn-card-header):has(.kbn-card-name[title*="${root}"])`).first().locator('.kbn-card-name')
  const box = await name.boundingBox()
  await name.click({ position: { x: box.width - 6, y: box.height / 2 } })
  const header = page.locator('.ws-stage-band .ws-band-head')
  await header.waitFor()
  if (await header.locator('h1').textContent() !== root) {
    await header.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.locator('.ws-settings-menu:not([hidden]) .ws-ancestry-link').first().click()
  }
  await page.waitForFunction(name => document.querySelector('.ws-stage-band .ws-band-title')?.textContent === name, root)
}

const surfaces = {
  async desk(page) {
    await page.goto(`${base}?example=threads&long-title`)
    await page.locator('.kbn-desk .kbn-card').first().waitFor()
  },
  async constitution(page) {
    await page.goto(`${base}?example=threads&long-title`)
    await openRoot(page)
    await page.locator('.ws-stage-band').getByRole('button', { name: 'Constitution', exact: true }).click()
    await page.locator('.ws-selected .ws-fiber-prose').waitFor()
  },
  async listening(page) {
    await page.goto(`${base}?example=threads&voice=pinned&long-title`)
    await openRoot(page)
    await page.locator('.ws-stage-band .ws-voice-strip[data-mode="pinned"]').first().waitFor({ timeout: 5000 })
  },
  async settings(page) {
    await page.goto(`${base}?example=threads`)
    await page.locator('.kbn-desk .kbn-card').first().waitFor()
    await page.keyboard.press('Meta+Comma')
    await page.locator('[role="dialog"]').last().waitFor({ timeout: 5000 }).catch(() => {})
  },
}

const only = process.env.SURFACES?.split(',')
await mkdir(out, { recursive: true })
// A local headless browser: the shared one may carry extension targets CDP attaches to.
const browser = await launchBrowser()
try {
  for (const [device, viewport] of Object.entries(viewports)) for (const scheme of ['light', 'dark']) {
    for (const [name, open] of Object.entries(surfaces)) {
      if (only && !only.includes(name)) continue
      const page = await browser.newPage({ viewport, colorScheme: scheme, deviceScaleFactor: 2 })
      try {
        await open(page)
        await page.waitForTimeout(400)
        await settle(page)
        const file = resolve(out, `${name}-${viewport.width}-${scheme}.png`)
        await page.screenshot({ path: file })
        console.log(file)
      } catch (error) {
        console.error(`${name} ${device} ${scheme}: ${error.message}`)
      } finally {
        await page.context().close()
      }
    }
  }
} finally {
  await browser.close()
}
