import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getBrowser } from '../e2e/browser.mjs'

const out = process.env.SIDEBAR_CAPTURES || '/tmp/sidebar-tree-captures'
await mkdir(out, { recursive: true })
const browser = await getBrowser()
try {
  for (const mode of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', colorScheme: mode })
    const p = await context.newPage()
    await p.addInitScript(mode => {
      localStorage.setItem('shuttle.appearance', JSON.stringify({ mode, dark: 'night-chart' }))
      localStorage.setItem('shuttle:workspace:sidebar', 'true')
    }, mode)
    await p.clock.install({ time: new Date('2026-11-04T20:00:00Z') })
    await p.goto(`${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=sidebar-tree`)
    await p.locator('.kbn-desk .kbn-card[data-fiber-id="chair"]').waitFor()
    await p.screenshot({ path: resolve(out, `${mode}-desk.png`) })
    await p.locator('.kbn-desk .kbn-card[data-fiber-id="chair"]').click()
    const sidebar = p.locator('.ws-sidebar')
    const row = id => sidebar.locator(`.ws-channel-row[data-channel-uid="${id}"]`)
    await row('chair/question').waitFor()
    await p.screenshot({ path: resolve(out, `${mode}-default.png`) })
    await row('chair').getByRole('button', { name: 'Collapse CMB cross-correlations chair', exact: true }).click()
    await p.screenshot({ path: resolve(out, `${mode}-collapsed.png`) })
    await row('chair').getByRole('button', { name: 'Expand CMB cross-correlations chair', exact: true }).click()
    await sidebar.getByRole('button', { name: '+3 more', exact: true }).first().click()
    await sidebar.getByRole('button', { name: 'Working 2', exact: true }).first().click()
    await p.screenshot({ path: resolve(out, `${mode}-expanded.png`) })
    await p.reload()
    await row('chair/analysis/deep').waitFor()
    await p.screenshot({ path: resolve(out, `${mode}-reloaded.png`) })
    await context.close()
  }
} finally { await browser.close() }
console.log(out)
