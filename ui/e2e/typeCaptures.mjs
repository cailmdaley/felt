// Captures the board's type across its surfaces: the Desk, a chat (header,
// a message row, a step group, the composer), the meeting pane and the
// settings sheet, at 1440 and 390 in both colour schemes.
//
//   npm run harness:board && node e2e/typeCaptures.mjs <out-dir>
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getBrowser } from './browser.mjs'

const out = resolve(process.argv[2] ?? 'type-captures')
const base = pathToFileURL(resolve('harness-board-dist/index.html')).href
const root = 'Calibrate the shear response across independent sky patches and validate each redshift bin'
const viewports = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } }
const settle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))

async function openRoot(page) {
  // Click the row's own name: its crumb leads to the root with the rail forced open.
  const name = page.locator('.kbn-desk .kbn-card').filter({ hasText: root }).first().locator('.kbn-card-name')
  const box = await name.boundingBox()
  await name.click({ position: { x: box.width - 6, y: box.height / 2 } })
  const header = page.locator('.ws-selected .ws-chat-head')
  for (let depth = 0; depth < 3 && await header.locator('h1').innerText() !== root; depth++) await header.locator('.ws-chat-back').click()
  await header.getByRole('heading', { name: root, exact: true }).waitFor()
}

const surfaces = {
  async desk(page) {
    await page.goto(`${base}?example=threads&long-title`)
    await page.locator('.kbn-desk .kbn-card').first().waitFor()
  },
  async chat(page, device) {
    await page.goto(`${base}?example=threads&transcript=messages&long-title`)
    await openRoot(page)
    const scroller = page.locator('.ws-selected .ws-transcript-scroll')
    await scroller.waitFor()
    // Bring a message row and a step group into view above the composer.
    const row = page.locator('.ws-selected .ws-transcript-shuttle-message').first()
    if (await row.count()) await row.evaluate((el, block) => el.scrollIntoView({ block }), device === 'phone' ? 'start' : 'center')
  },
  async meeting(page) {
    await page.goto(`${base}?example=threads&meeting=joined&long-title`)
    await openRoot(page)
    await page.locator('.ws-selected .kbn-detail-transcript').first().waitFor({ timeout: 5000 }).catch(() => {})
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
const browser = await getBrowser({ sharedBrowser: { status: async () => ({ running: false }) } })
try {
  for (const [device, viewport] of Object.entries(viewports)) for (const scheme of ['light', 'dark']) {
    for (const [name, open] of Object.entries(surfaces)) {
      if (only && !only.includes(name)) continue
      const page = await browser.newPage({ viewport, colorScheme: scheme, deviceScaleFactor: 2 })
      await page.addInitScript(() => {
        if (window !== window.top) return
        localStorage.setItem('shuttle:workspace:sidebar', 'false')
      })
      try {
        await open(page, device)
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
