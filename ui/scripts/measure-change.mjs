import { chromium, webkit } from 'playwright-core'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const source = await readFile(process.env.CHANGE_BUNDLE, 'utf8')
const engine = process.env.ENGINE ?? 'chromium'
const browser =
  engine === 'webkit'
    ? await webkit.launch({ headless: true })
    : await chromium.connectOverCDP(
        execFileSync('../bin/shared-browser', ['endpoint'], { encoding: 'utf8' }).trim(),
      )
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce',
})
const page = await context.newPage()
try {
  page.setDefaultTimeout(120000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await context.addInitScript(() => {
    if (window.top !== window) return
    localStorage.clear()
    window.__measure = { tasks: [], timers: new Map(), fired: {}, reads: 0 }
    if (PerformanceObserver.supportedEntryTypes.includes('longtask'))
      new PerformanceObserver((list) =>
        window.__measure.tasks.push(
          ...list.getEntries().map((e) => ({ start: e.startTime, duration: e.duration })),
        ),
      ).observe({ type: 'longtask' })
    const interval = window.setInterval
    const clear = window.clearInterval
    window.setInterval = (fn, ms, ...args) => {
      const id = interval(() => {
        window.__measure.fired[ms] = (window.__measure.fired[ms] ?? 0) + 1
        fn(...args)
      }, ms)
      window.__measure.timers.set(id, ms)
      return id
    }
    window.clearInterval = (id) => {
      window.__measure.timers.delete(id)
      clear(id)
    }
  })
  if (process.env.LIVE) {
    await page.route('**/api/**', (route) => {
      const method = route.request().method()
      return ['GET', 'HEAD'].includes(method) ? route.continue() : route.abort()
    })
  }
  if (process.env.STATIC_DIST) {
    await page.route('**/*', async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path !== '/' && !path.startsWith('/assets/')) return route.fallback()
      const file = resolve(process.env.STATIC_DIST, path === '/' ? 'index.html' : path.slice(1))
      const body = await readFile(file)
      const ext = file.split('.').at(-1)
      const contentType =
        {
          html: 'text/html',
          js: 'text/javascript',
          css: 'text/css',
          woff: 'font/woff',
          woff2: 'font/woff2',
          wasm: 'application/wasm',
        }[ext] ?? 'application/octet-stream'
      return route.fulfill({ body, contentType })
    })
  }
  await page.goto(
    process.env.LIVE
      ? 'http://127.0.0.1:4000/'
      : `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=change`,
  )
  if (!process.env.LIVE || process.env.STATIC_DIST)
    await page.evaluate(
      ({ source, name }) => {
        const blob = new Blob([source], { type: 'application/json' })
        const fetch = window.fetch
        window.fetch = async (input, init) => {
          if (
            !String(input).includes('/api/v1/file?') ||
            !String(input).includes(`${name}.change.json`)
          )
            return fetch(input, init)
          window.__measure.reads++
          const etag = `W/"sha256-${'a'.repeat(64)}"`
          const headers = {
            'content-type': 'application/json',
            etag,
            'content-length': String(blob.size),
          }
          if (init?.method === 'HEAD') return new Response(null, { headers })
          if (new Headers(init?.headers).get('If-None-Match') === etag)
            return new Response(null, { status: 304, headers })
          const response = new Response(blob, { headers })
          const text = response.text.bind(response)
          response.text = async () => {
            const source = await text()
            window.__measure.bytesReady = performance.now()
            return source
          }
          return response
        }
      },
      { source, name: process.env.LIVE ? 'pr-viewer' : 'family' },
    )
  await page
    .locator('.kbn-desk .kbn-card')
    .filter({
      hasText: process.env.LIVE ? 'A PR viewer in Shuttle' : 'Calibrate the shear response',
    })
    .click()
  const original = new URL(page.url()).hash
  const cdp = engine === 'chromium' ? await context.newCDPSession(page) : null
  if (cdp) await cdp.send('Performance.enable')
  async function snapshot(label) {
    const location = page.url()
    if (cdp) await cdp.send('HeapProfiler.collectGarbage')
    const metrics = cdp
      ? Object.fromEntries(
          (await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]),
        )
      : {}
    const dom = cdp ? await cdp.send('Memory.getDOMCounters') : {}
    const state = await page.evaluate(() => ({
      now: performance.now(),
      lightNodes: document.querySelectorAll('*').length,
      readers: document.querySelectorAll('.change-reader').length,
      diffWindows: document.querySelectorAll('.change-diff-window').length,
      highlighted: document.querySelectorAll('diffs-container').length,
      tasks: window.__measure.tasks.splice(0),
      intervals: [...window.__measure.timers.values()],
      fired: { ...window.__measure.fired },
      reads: window.__measure.reads,
    }))
    const clicks = []
    for (let i = 0; i < 5; i++) {
      clicks.push(
        await page.evaluate(
          () =>
            new Promise((resolve) => {
              const start = performance.now()
              const control =
                document.querySelector('.ws-stage-band .ws-band-settings') ??
                document.querySelector('.ws-selected .ws-menu-button')
              control.click()
              requestAnimationFrame(() =>
                setTimeout(() => {
                  resolve(performance.now() - start)
                }, 0),
              )
            }),
        ),
      )
      await page.keyboard.press('Escape')
    }
    const pointerMenuMs = []
    const railMs = []
    for (let i = 0; i < 5; i++) {
      for (const [selector, samples] of [
        [
          '.ws-stage-band .ws-band-settings:visible, .ws-selected .ws-menu-button:visible, .ws-phone-document-menu:visible',
          pointerMenuMs,
        ],
        ['.ws-rail-toggle:visible', railMs],
      ]) {
        const box = await page.locator(selector).first().boundingBox()
        if (!box) throw new Error(`No visible control: ${selector}`)
        const start = performance.now()
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        )
        samples.push(performance.now() - start)
        if (selector.includes('settings')) await page.keyboard.press('Escape')
        else await page.locator(selector).first().click()
        await page.mouse.move(0, 0)
      }
    }
    const interactionMetrics = cdp
      ? Object.fromEntries(
          (await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]),
        )
      : {}
    const interactionCostMs = cdp
      ? Object.fromEntries(
          ['RecalcStyleDuration', 'LayoutDuration', 'ScriptDuration'].map((key) => [
            key,
            (interactionMetrics[key] - metrics[key]) * 1000,
          ]),
        )
      : undefined
    if (page.url() !== location)
      throw new Error(`A measurement click navigated away during ${label}`)
    return {
      label,
      metrics,
      dom,
      ...state,
      menuMs: clicks,
      pointerMenuMs,
      railMs,
      interactionCostMs,
    }
  }
  await page.waitForTimeout(1500)
  const before = await snapshot('never opened')
  await page.evaluate(
    (name) => {
      window.__measure.tasks.length = 0
      window.__measure.start = performance.now()
      const observer = new MutationObserver(() => {
        if (!document.querySelector('.ws-selected .change-reader h1')) return
        observer.disconnect()
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            window.__measure.paint = performance.now()
          }),
        )
      })
      observer.observe(document, { childList: true, subtree: true })
      document
        .querySelector(`.ws-rail-files .ws-rail-file[data-key$="/${name}.change.json"]`)
        .click()
    },
    process.env.LIVE ? 'pr-viewer' : 'family',
  )
  await page.locator('.ws-selected .change-reader h1').waitFor()
  const openMs = await page.evaluate(() => performance.now() - window.__measure.start)
  await page.waitForFunction(() => window.__measure.paint)
  const paint = await page.evaluate(() => ({
    clickToPaintMs: window.__measure.paint - window.__measure.start,
    bytesToPaintMs: window.__measure.paint - window.__measure.bytesReady,
  }))
  await page.waitForTimeout(3000)
  const opened = await snapshot('open')
  let scrolled
  if (process.env.SWEEP) {
    if (cdp && process.env.PROFILE) {
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.start')
    }
    const cards = page.locator('.ws-selected .change-file')
    for (let i = 0; i < (await cards.count()); i++) {
      await cards.nth(i).evaluate((node) => node.scrollIntoView())
      await page.waitForTimeout(80)
    }
    await page.waitForTimeout(2000)
    scrolled = await snapshot('after visiting every file')
    if (cdp && process.env.PROFILE)
      await writeFile(
        '/tmp/change-profile.json',
        JSON.stringify((await cdp.send('Profiler.stop')).profile),
      )
  }
  await page.screenshot({ path: process.env.CHANGE_SCREENSHOT ?? '/tmp/change-measured.png' })
  await page.evaluate((hash) => {
    location.hash = hash
  }, original)
  await page.locator('.ws-rail-files .ws-rail-file').first().waitFor()
  await page.waitForTimeout(1000)
  const inactive = await snapshot('back to conversation')
  await page.waitForTimeout(9000)
  const after = await snapshot('after close + 10s')
  let ablated
  if (process.env.ABLATE) {
    await page.evaluate(() => {
      for (const reader of document.querySelectorAll('.change-reader')) reader.remove()
    })
    await page.waitForTimeout(1000)
    ablated = await snapshot('retained readers removed, other state unchanged')
  }
  const result = {
    engine,
    bytes: Buffer.byteLength(source),
    openMs,
    paint,
    before,
    opened,
    scrolled,
    inactive,
    after,
    ablated,
    errors,
  }
  await writeFile(
    process.env.CHANGE_OUTPUT ?? '/tmp/change-measurement.json',
    JSON.stringify(result, null, 2),
  )
  console.log(JSON.stringify(result, null, 2))
} finally {
  await context.close()
  await browser.close()
}
