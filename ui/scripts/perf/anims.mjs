// What keeps animating and ticking while the board sits idle: every running
// Web Animation (with its target and whether it is on screen) and every
// setInterval the page registered.
//   node scripts/perf/anims.mjs [base] [desk|channel]
import { chromium } from 'playwright-core'
const [, , base = 'http://localhost:5187/', what = 'desk'] = process.argv
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage()
await ctx.addInitScript(() => { const si = window.setInterval; window.__iv = []; window.setInterval = function (fn, ms, ...r) { window.__iv.push({ ms, src: String(fn).slice(0, 160), stack: new Error().stack.split('\n').slice(2, 5).join(' | ') }); return si.call(this, fn, ms, ...r) } })
await p.goto(base); await p.waitForSelector('.kbn-desk .kbn-card', { timeout: 60000 })
if (what === 'channel') { await p.evaluate(() => document.querySelector('.kbn-desk .kbn-card').click()); await p.waitForTimeout(3000) }
await p.waitForTimeout(3000)
console.log(JSON.stringify(await p.evaluate(() => ({
  anims: document.getAnimations().map(a => ({ name: a.animationName ?? a.constructor.name, state: a.playState, iter: a.effect?.getTiming?.().iterations, target: (t => t ? `${t.tagName}.${[...t.classList].join('.')}` : '')(a.effect?.target), visible: (t => { if (!t) return null; const r = t.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.top < innerHeight && !t.closest('[hidden]') })(a.effect?.target) })),
  iv: window.__iv,
})), null, 1))
await b.close()
