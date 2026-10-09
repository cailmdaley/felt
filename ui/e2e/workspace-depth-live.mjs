// Read-only visual and frame-timing probe against a live Vite proxy.
// WORKSPACE_DEPTH_SHOTS is required; no daemon writes are permitted.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getBrowser } from './browser.mjs'
const output = process.env.WORKSPACE_DEPTH_SHOTS
assert.ok(output, 'Set WORKSPACE_DEPTH_SHOTS to the evidence directory')
await mkdir(output, { recursive: true })
const url = process.env.WORKSPACE_LIVE_URL || 'http://localhost:5182'
const name = process.env.WORKSPACE_DEPTH_CARD || 'A light, immediate Shuttle document workspace'
const browser = await getBrowser({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
const evidence = { url, name, screenshots: [], frameSamples: [], errors: [] }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function pageFor(viewport) {
  const page = await browser.newPage({ viewport, reducedMotion: 'no-preference' })
  page.on('pageerror', error => evidence.errors.push(error.message))
  await page.route('**/api/**', route => {
    if (['GET', 'HEAD'].includes(route.request().method())) return route.continue()
    evidence.errors.push(`Blocked ${route.request().method()} ${route.request().url()}`)
    return route.abort()
  })
  await page.goto(url)
  await page.locator('.kbn-desk .kbn-card').filter({ hasText: name }).waitFor()
  await page.waitForTimeout(500)
  return page
}
async function redact(page) {
  // Private fibers keep their silhouette without copying their content into evidence.
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.kbn-card,.kbn-cluster-item,.ws-overview-folio,.ws-channel-row')]
    const privateUids = new Set(window.__workspacePrivateUids || [])
    for (const el of rows) {
      const path = el.dataset.fiberId || el.querySelector('.kbn-card-id')?.textContent || el.title
      if (/(?:^|\/)life\/(?:personal|wedding)\//.test(path || '')) privateUids.add(el.dataset.cardUid)
    }
    window.__workspacePrivateUids = [...privateUids]
    for (const el of rows) {
      const uid = el.dataset.cardUid || el.dataset.uid || el.dataset.channelUid
      if (!uid || !privateUids.has(uid)) continue
      el.style.height = `${el.getBoundingClientRect().height}px`
      el.replaceChildren(document.createTextNode('Private fiber'))
    }
  })
}
async function shot(page, file) {
  await redact(page)
  const path = resolve(output, file)
  await page.screenshot({ path })
  evidence.screenshots.push(path)
}
async function clickCard(page) { await page.locator('.kbn-desk .kbn-card').filter({ hasText: name }).click() }
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    const page = await pageFor(viewport), size = `${viewport.width}x${viewport.height}`
    await shot(page, `${size}-desk.png`)
    await clickCard(page)
    await page.waitForTimeout(50)
    const poses = await page.evaluate(() => {
      const active = document.getAnimations().filter(animation => animation.effect?.getTiming().duration === 280)
      for (const animation of active) { animation.pause(); animation.currentTime = 126 }
      return active.length
    })
    assert.ok(poses, 'mid-open capture pauses real crossings at 45%')
    await shot(page, `${size}-mid-open.png`)
    await page.evaluate(() => { for (const animation of document.getAnimations()) if (animation.playState === 'paused') animation.play() })
    await page.waitForTimeout(550)
    await shot(page, `${size}-sidebar.png`)
    await page.locator('.ws-channel-title').focus()
    await page.keyboard.press('j'); await page.waitForTimeout(350)
    await page.keyboard.press('j'); await page.waitForTimeout(350)
    await shot(page, `${size}-after-j-twice.png`)
    await page.locator('.ws-return').click(); await page.waitForTimeout(400)
    await page.locator('[data-view="shelf"]').click()
    const folio = page.locator('.ws-overview-folio').filter({ hasText: name })
    await folio.waitFor(); await folio.click(); await page.waitForTimeout(500)
    await shot(page, `${size}-from-board.png`)
    await page.close()
  }
  const phone = await pageFor({ width: 390, height: 844 })
  await clickCard(phone); await phone.waitForTimeout(650)
  await shot(phone, '390x844-phone.png')
  assert.equal(await phone.locator('.ws-sidebar').first().isVisible(), false)
  assert.equal(await phone.locator('.ws-veil').evaluate(el => getComputedStyle(el).backdropFilter), 'none')
  await phone.close()

  const page = await pageFor({ width: 1440, height: 900 })
  for (let iteration = 0; iteration < 4; iteration++) for (const phase of ['open', 'close']) {
    const intervals = await page.evaluate(async ({ phase, name }) => {
      const frames = []
      const start = performance.now(); let previous = start
      const finished = new Promise(resolve => {
        function tick(now) {
          frames.push({ at: now - start, ms: now - previous }); previous = now
          if (now - start < 650) requestAnimationFrame(tick)
          else resolve()
        }
        requestAnimationFrame(tick)
      })
      if (phase === 'open') [...document.querySelectorAll('.kbn-desk .kbn-card')].find(el => el.textContent.includes(name)).click()
      else document.querySelector('.ws-return').click()
      await finished
      return frames
    }, { phase, name })
    evidence.frameSamples.push({ iteration, phase, intervals })
    await pause(300)
  }
  const sorted = evidence.frameSamples.flatMap(sample => sample.intervals.slice(1).map(frame => frame.ms)).sort((a, b) => a - b)
  evidence.medianFrameMs = sorted[Math.floor(sorted.length / 2)]
  const dropped = intervals => intervals.filter(frame => frame.ms > evidence.medianFrameMs * 1.5).reduce((count, frame) => count + Math.max(0, Math.round(frame.ms / evidence.medianFrameMs) - 1), 0)
  for (const sample of evidence.frameSamples) {
    sample.estimatedDropped = dropped(sample.intervals)
    sample.transitionDropped = dropped(sample.intervals.filter(frame => frame.at <= 300))
    sample.maxMs = Math.max(...sample.intervals.map(frame => frame.ms))
  }
  await page.close()
} finally { await browser.close() }
await writeFile(resolve(output, 'depth-evidence.json'), JSON.stringify(evidence, null, 2))
console.log(JSON.stringify({ medianFrameMs: evidence.medianFrameMs, samples: evidence.frameSamples.map(({ intervals, ...sample }) => ({ ...sample, frames: intervals.length })), errors: evidence.errors }, null, 2))
assert.deepEqual(evidence.errors, [])
