import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
import { getBrowser } from './browser.mjs'

const bundle = JSON.parse(
  await readFile(
    process.env.CHANGE_BUNDLE ??
      new URL('../harness/fixtures/dogfood.change.json', import.meta.url),
    'utf8',
  ),
)
const dist = fileURLToPath(new URL('../harness-change-dist/', import.meta.url))
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname
    const path = pathname === '/' ? 'index.html' : pathname
    const body = await readFile(join(dist, path))
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end()
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const browser = await getBrowser()
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  reducedMotion: 'reduce',
})
try {
  const page = await context.newPage()
  await page.addInitScript(() => {
    window.__changeObservers = new Set()
    for (const name of ['IntersectionObserver', 'ResizeObserver']) {
      const Observer = window[name]
      window[name] = class extends Observer {
        observe(target, options) {
          window.__changeObservers.add(this)
          super.observe(target, options)
        }
        disconnect() {
          window.__changeObservers.delete(this)
          super.disconnect()
        }
      }
    }
  })
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.waitForFunction(() => typeof window.__mountChange === 'function')
  await page.evaluate((bundle) => window.__mountChange(bundle), bundle)
  await page.locator('diffs-container [data-line-index]').first().waitFor()
  assert.equal(await page.locator('h1').textContent(), bundle.title)
  assert.equal(await page.locator('.change-map').evaluate(map => {
    const box = map.getBoundingClientRect(), scroll = map.closest('.change-scroll').getBoundingClientRect()
    return box.top >= scroll.top && box.bottom <= scroll.bottom
  }), true, 'the whole map fits the visible scroller')
  await page.getByRole('button', { name: /^Tests:/ }).click()
  assert.equal(await page.locator('.change-section').filter({ has: page.getByRole('heading', { name: 'Tests', exact: true }) }).evaluate(section => {
    const box = section.getBoundingClientRect(), scroll = section.closest('.change-scroll').getBoundingClientRect()
    return box.top >= scroll.top && box.top < scroll.bottom
  }), true, 'a role tile reveals its lane')
  await page.locator('.change-scroll').evaluate(scroll => { scroll.dispatchEvent(new Event('wheel', { bubbles: true })); scroll.scrollTop = 100 })
  assert.ok((await page.locator('diffs-container').count()) < 10, 'only nearby windows mount')
  assert.equal(await page.locator('textarea[aria-label="Overall review note"]').count(), 1)
  await page.evaluate(() => window.__disposeChange())
  assert.equal(
    await page.locator('.change-reader, diffs-container, .change-diff-window').count(),
    0,
  )
  assert.equal(
    await page.evaluate(() => window.__changeObservers.size),
    0,
    'dispose disconnects every reader observer',
  )
  assert.equal(
    await page.evaluate(() => window.__changeHighlighterLoaded()),
    false,
    'dispose releases the shared highlighter',
  )
  await page.evaluate((bundle) => window.__mountChange(bundle), bundle)
  await page.locator('diffs-container [data-line-index]').first().waitFor()
  assert.ok(Math.abs(await page.locator('.change-scroll').evaluate(scroll => scroll.scrollTop) - 100) < 2, 'reading position within the map survives remount')
  await page.evaluate(() => window.__disposeChange())
  if (process.env.MEASURE_MARKDOWN && bundle.story) {
    const texts = [
      bundle.story.overview,
      ...bundle.story.flags.map((flag) => flag.text),
      ...bundle.story.chapters.flatMap((chapter) => [
        chapter.narrative,
        ...chapter.stops.map((stop) => stop.note),
      ]),
    ]
    const times = await page.evaluate(
      (texts) =>
        Array.from({ length: 25 }, () => {
          const start = performance.now()
          for (const text of texts) window.__renderMarkdown(text, { untrusted: true })
          return performance.now() - start
        }),
      texts,
    )
    console.log(
      JSON.stringify({
        markdownFields: texts.length,
        markdownCharacters: texts.join('').length,
        fullMarkdownPathMs: times,
      }),
    )
  }
  console.log('PASS real change renders; dispose removes code, windows and observers')
} finally {
  await context.close()
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
