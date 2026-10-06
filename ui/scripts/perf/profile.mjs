// V8 CPU profile of one board scenario, printed as the top self-time and
// inclusive-time functions. Point it at an unminified build for readable names
// (`npx vite build --minify false --outDir <dir>`, then `vite preview` it).
//   node scripts/perf/profile.mjs <base> <load|poll|open|switch> [cpuThrottle]
// CPU profile of a scenario; prints top self-time functions and inclusive time of named ones.
import { chromium } from 'playwright-core'
const [, , base = 'http://localhost:5187/', scenario = 'load', cpuArg = '4'] = process.argv
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage()
const cdp = await ctx.newCDPSession(p)
await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(cpuArg) })
await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
if (scenario !== 'load') { await p.goto(base); await p.waitForSelector('.kbn-desk .kbn-card', { timeout: 60000 }); await p.waitForTimeout(2000) }
await cdp.send('Profiler.start')
if (scenario === 'load') { await p.goto(base); await p.waitForSelector('.kbn-desk .kbn-card', { timeout: 60000 }); await p.waitForTimeout(500) }
if (scenario === 'poll') { await p.waitForTimeout(31000) }
if (scenario === 'switch') { for (let i = 0; i < 3; i++) { await p.evaluate(() => document.querySelector('.kbn-desk .kbn-card').click()); await p.waitForTimeout(1500); await p.keyboard.press('Escape'); await p.waitForTimeout(800) } }
if (scenario === 'open') { await p.evaluate(() => document.querySelector('.kbn-desk .kbn-card').click()); await p.waitForTimeout(4000) }
const { profile } = await cdp.send('Profiler.stop')
await b.close()
const nodes = new Map(profile.nodes.map(n => [n.id, n]))
const parent = new Map(); for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
const dt = profile.timeDeltas; const self = new Map(); const incl = new Map()
const label = n => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber + 1}`
for (let i = 0; i < profile.samples.length; i++) {
  const d = (dt[i + 1] ?? 0) / 1000; let id = profile.samples[i]
  const n = nodes.get(id); self.set(label(n), (self.get(label(n)) ?? 0) + d)
  const seen = new Set(); while (id) { const l = label(nodes.get(id)); if (!seen.has(l)) { incl.set(l, (incl.get(l) ?? 0) + d); seen.add(l) } id = parent.get(id) }
}
const top = (m, k) => [...m].filter(([l]) => !/^\((root|program|idle)\)/.test(l)).sort((a, b) => b[1] - a[1]).slice(0, k)
console.log('--- self'); for (const [l, v] of top(self, 25)) console.log(v.toFixed(0).padStart(6), l)
console.log('--- inclusive'); for (const [l, v] of top(incl, 45)) console.log(v.toFixed(0).padStart(6), l)
