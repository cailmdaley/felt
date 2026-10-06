// Does the board's DOM grow while it sits idle? Samples, once a minute, the
// attached element count and the Nodes / JS heap counters after a forced GC,
// so garbage awaiting collection is not mistaken for a leak.
//   node scripts/perf/dom-growth.mjs [base] [desk|channel] [minutes]
import { chromium } from 'playwright-core'

const [, , base = 'http://localhost:5186/', view = 'desk', minutesArg = '5'] = process.argv
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
const cdp = await ctx.newCDPSession(page)
await cdp.send('Performance.enable')
await page.goto(base)
await page.waitForSelector('.kbn-desk .kbn-card', { timeout: 60000 })
if (view === 'channel') await page.evaluate(() => document.querySelector('.kbn-desk .kbn-card').click())
await page.waitForTimeout(5000)
const sample = async label => {
  const before = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
  await cdp.send('HeapProfiler.collectGarbage')
  const after = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
  const attached = await page.evaluate(() => document.getElementsByTagName('*').length)
  console.log(JSON.stringify({ t: label, nodesBeforeGC: before.Nodes, nodesAfterGC: after.Nodes, attached, heapMB: +(after.JSHeapUsedSize / 1e6).toFixed(2), listeners: after.JSEventListeners, documents: after.Documents, frames: after.Frames }))
}
await sample(0)
for (let m = 1; m <= Number(minutesArg); m++) { await page.waitForTimeout(60000); await sample(m) }
await browser.close()
