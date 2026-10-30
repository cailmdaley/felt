// Captures the reader's header and right rail with the root's artifact:
// 1440 with the rail at its default width and at half the window, a
// portrait 900×1200, and a 390 phone, each in both colour schemes.
//
//   npm run harness:board && node e2e/railCaptures.mjs <out-dir>
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getBrowser } from './browser.mjs'

const out = resolve(process.argv[2] ?? 'rail-captures')
const url = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=threads&transcript=warm&long-title`
const root = 'Calibrate the shear response across independent sky patches and validate each redshift bin'
const shots = [
  { name: '1440-default', viewport: { width: 1440, height: 900 } },
  { name: '1440-half', viewport: { width: 1440, height: 900 }, rail: 720 },
  { name: '900x1200', viewport: { width: 900, height: 1200 } },
  { name: '390-phone', viewport: { width: 390, height: 844 } },
]

await mkdir(out, { recursive: true })
const browser = await getBrowser({ sharedBrowser: { status: async () => ({ running: false }) } })
try {
  for (const shot of shots) for (const scheme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: shot.viewport, colorScheme: scheme, deviceScaleFactor: 2 })
    await page.addInitScript(([scheme, rail]) => {
      if (window !== window.top) return
      localStorage.setItem('shuttle.appearance', JSON.stringify({ mode: scheme, dark: 'night-chart' }))
      localStorage.setItem('shuttle:workspace:sidebar', 'false')
      localStorage.setItem('shuttle:workspace:rail', 'true')
      if (rail) localStorage.setItem('shuttle:workspace:thread-rail-width', String(rail))
    }, [scheme, shot.rail ?? 0])
    try {
      await page.goto(url)
      const name = page.locator('.kbn-desk .kbn-card').filter({ hasText: root }).first().locator('.kbn-card-name')
      const box = await name.boundingBox()
      await name.click({ position: { x: box.width - 6, y: box.height / 2 } })
      const header = page.locator('.ws-selected .ws-chat-head')
      for (let depth = 0; depth < 3 && await header.locator('h1').innerText() !== root; depth++) await header.locator('.ws-chat-back').click()
      await header.getByRole('heading', { name: root, exact: true }).waitFor()
      await page.locator('.ws-rail-artifact iframe').first().waitFor({ timeout: 3000 }).catch(() => {})
      await page.waitForTimeout(700)
      const file = resolve(out, `${shot.name}-${scheme}.png`)
      await page.screenshot({ path: file })
      console.log(file)
    } catch (error) {
      console.error(`${shot.name} ${scheme}: ${error.message}`)
    } finally {
      await page.context().close()
    }
  }
} finally {
  await browser.close()
}
