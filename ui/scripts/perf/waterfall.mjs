// Cold-load request waterfall: when each resource started and finished,
// relative to navigation, and when the first Desk card appeared.
//   node scripts/perf/waterfall.mjs [base] [cpuThrottle]
import { chromium } from 'playwright-core'
const base = process.argv[2] ?? 'http://localhost:5186/'
const cpu = Number(process.argv[3] ?? 1)
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage()
const cdp = await ctx.newCDPSession(p); if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu })
await p.goto(base); await p.waitForSelector('.kbn-desk .kbn-card', { timeout: 60000 })
const desk = await p.evaluate(() => performance.now())
const rows = await p.evaluate(() => performance.getEntriesByType('resource').map(e => [Math.round(e.startTime), Math.round(e.responseStart), Math.round(e.responseEnd), e.encodedBodySize, e.name.replace(location.origin, '').slice(0, 70)]))
console.log('desk', Math.round(desk), 'dcl', await p.evaluate(() => Math.round(performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd)))
for (const r of rows) console.log(r.join('\t'))
console.log(JSON.stringify(await p.evaluate(() => performance.getEntriesByType('longtask').map?.(e => [Math.round(e.startTime), Math.round(e.duration)]))))
await b.close()
