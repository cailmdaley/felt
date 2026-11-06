import { chromium } from 'playwright-core'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const shots = process.env.SHOTS_DIR ?? '/tmp/shuttle-change-shots'
await mkdir(shots, { recursive: true })
const harness = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=change`
const familyTitle = 'Keep a family’s root visible, and its requests close'
const largeTitle = 'A 5,000-line changed file'
const measurements = { method: 'Self-contained harness; fresh page/realm per cold sample; identical hash navigation after the board is ready. Warm samples retain the page, highlighter, and adjacent-document prefetch. No production network downloads are included.', visuals: [], timings: [], largeScroll: null, bundles: [] }
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--allow-file-access-from-files', '--mute-audio', '--use-mock-keychain', '--password-store=basic'] })
const context = (width = 1440, height = 1000, mode = 'light') => browser.newContext({ viewport: { width, height }, colorScheme: mode, reducedMotion: 'reduce', isMobile: width < 700, hasTouch: width < 700 })
async function prepare(ctx, mode = 'light') {
  await ctx.addInitScript(mode => {
    if (window.top !== window) return
    localStorage.setItem('shuttle.appearance', JSON.stringify({ mode, dark: 'night-chart' }))
    localStorage.setItem('shuttle:workspace:sidebar', 'false')
    localStorage.setItem('shuttle:workspace:rail', 'false')
  }, mode)
  const page = await ctx.newPage()
  page.setDefaultTimeout(30_000)
  await page.goto(harness)
  await page.locator('.kbn-desk .kbn-card').filter({ hasText: 'Calibrate the shear response' }).click()
  return page
}
async function switchReader(page, hash, title) {
  return page.evaluate(({ hash, title }) => new Promise((resolve, reject) => {
    const renderedBeforeNavigation = [...document.querySelectorAll('.change-reader')].some(root => root.querySelector('h1')?.textContent === title && [...root.querySelectorAll('diffs-container')].some(diff => diff.shadowRoot?.querySelector('[data-line-index]')))
    const start = performance.now()
    let shellMs, frame
    const deadline = setTimeout(() => { cancelAnimationFrame(frame); reject(new Error(`No code rendered for ${title}`)) }, 30_000)
    const check = () => {
      const root = document.querySelector('.ws-selected .change-reader')
      if (root?.querySelector('h1')?.textContent === title) {
        shellMs ??= performance.now() - start
        const diffs = [...root.querySelectorAll('diffs-container')]
        if (diffs.some(diff => diff.shadowRoot?.querySelector('[data-line-index]'))) {
          clearTimeout(deadline)
          resolve({ renderedBeforeNavigation, shellMs: Math.round(shellMs), firstCodeMs: Math.round(performance.now() - start), mounted: diffs.length, windows: root.querySelectorAll('.change-diff-window').length })
          return
        }
      }
      frame = requestAnimationFrame(check)
    }
    location.hash = hash
    frame = requestAnimationFrame(check)
  }), { hash, title })
}
try {
  // Discover the reader address through the actual header entry, not a synthetic document key.
  let familyHash
  for (const [device, width, height] of [['desktop', 1440, 1000], ['phone', 390, 844]]) for (const mode of ['light', 'dark']) {
    const ctx = await context(width, height, mode)
    try {
      const page = await prepare(ctx, mode), errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.locator('.ws-rail-files .ws-rail-file[data-key$="/family.change.json"]').click()
      await page.locator('.ws-selected .change-file diffs-container [data-line-index]').first().waitFor()
      familyHash = new URL(page.url()).hash
      await page.mouse.move(0, 0)
      await page.screenshot({ path: `${shots}/${device}-${mode}-overview.png` })
      await page.locator('.ws-selected .change-chapter-link').first().click()
      await page.locator('.ws-selected .change-file diffs-container [data-line-index]').first().waitFor()
      await page.screenshot({ path: `${shots}/${device}-${mode}-diff.png` })
      await page.locator('.ws-selected .change-file').first().locator('diffs-container [data-column-number]').first().click()
      await page.locator('.ws-selected .change-file').first().getByRole('textbox', { name: /^Comment on/ }).fill('Does the root exclude itself here?')
      await page.screenshot({ path: `${shots}/${device}-${mode}-comment.png` })
      const geometry = await page.locator('.ws-selected .change-reader').evaluate(root => {
        const scroll = root.querySelector('.change-scroll'), tabs = root.querySelector('.change-contents').getBoundingClientRect()
        const icon = document.querySelector('.ws-navbar .ws-rail-toggle')?.getBoundingClientRect()
        return { horizontalOverflowPx: scroll.scrollWidth - scroll.clientWidth, contentsIconBottom: icon?.bottom ?? null, chapterTabsTop: tabs.top }
      })
      measurements.visuals.push({ device, mode, ...geometry, errors })
    } finally { await ctx.close() }
  }
  const largeHash = familyHash.replace('family.change.json', 'large.change.json')
  for (let repeat = 0; repeat < 3; repeat++) for (const [fixture, hash, title] of [['normal', familyHash, familyTitle], ['large', largeHash, largeTitle]]) {
    const ctx = await context()
    try {
      const page = await prepare(ctx)
      measurements.timings.push({ fixture, temperature: 'cold', repeat, ...await switchReader(page, hash, title) })
      if (fixture === 'normal') measurements.timings.push({ fixture: 'large', temperature: 'warm-after-normal', repeat, ...await switchReader(page, largeHash, largeTitle) })
      if (fixture === 'large' && repeat === 0) {
        const scroll = await page.locator('.ws-selected .change-scroll').evaluate(async node => {
          const samples = []
          for (let i = 0; i < 30; i++) {
            const requested = 1500 + i * 6000, start = performance.now()
            node.scrollTop = requested
            await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame)
            samples.push({ requested, actual: node.scrollTop, twoFramesMs: Math.round(performance.now() - start) })
          }
          return samples
        })
        await page.locator('.ws-selected diffs-container [data-line-index]').first().waitFor()
        const dom = await page.locator('.ws-selected .change-reader').evaluate(node => ({ mounted: node.querySelectorAll('diffs-container').length, totalWindows: node.querySelectorAll('.change-diff-window').length, lightDomNodes: node.querySelectorAll('*').length, shadowDomNodes: [...node.querySelectorAll('diffs-container')].reduce((sum, diff) => sum + (diff.shadowRoot?.querySelectorAll('*').length ?? 0), 0) }))
        measurements.largeScroll = { ...dom, samples: scroll }
        await page.screenshot({ path: `${shots}/large-scrolled.png` })
      }
    } finally { await ctx.close() }
  }
} finally { await browser.close() }
for (const file of await readdir('dist/assets')) {
  if (!/^(?:ChangeReader-|typescript-|engine-javascript-).*\.(?:js|css)$/.test(file)) continue
  const bytes = await readFile(`dist/assets/${file}`)
  measurements.bundles.push({ file, bytes: bytes.length, gzipBytes: gzipSync(bytes).length })
}
await writeFile(`${shots}/measurements.json`, JSON.stringify(measurements, null, 2) + '\n')
console.log(JSON.stringify(measurements, null, 2))
