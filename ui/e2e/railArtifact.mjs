import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const url = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=threads&transcript=warm&long-title`
const root = 'Calibrate the shear response across independent sky patches and validate each redshift bin'
const section = page => page.locator('.ws-thread-rail .ws-rail-artifact')
const railFrame = page => section(page).frameLocator('iframe')

async function openRoot(page) {
  const name = page.locator('.kbn-desk .kbn-card').filter({ hasText: root }).first().locator('.kbn-card-name')
  const box = await name.boundingBox()
  await name.click({ position: { x: box.width - 6, y: box.height / 2 } })
  const header = page.locator('.ws-selected .ws-chat-head')
  for (let depth = 0; depth < 3 && await header.locator('h1').innerText() !== root; depth++) await header.locator('.ws-chat-back').click()
  await header.getByRole('heading', { name: root, exact: true }).waitFor()
}
const scale = page => section(page).evaluate(el => Number(el.dataset.scale))
const stageBox = page => page.locator('.ws-stage-column').evaluate(el => { const r = el.getBoundingClientRect(); return [r.left, r.width].map(Math.round) })

export function registerRailArtifactJourneys(test) {
  test('Rail artifact: live beneath the threads, filling the rail between them and the sent files, scrollable in place, folded, scaled by the rail, opened full', async page => {
    await page.addInitScript(() => {
      if (window !== window.top) return
      localStorage.setItem('shuttle:workspace:sidebar', 'false')
      localStorage.setItem('shuttle:workspace:rail', 'true')
    })
    await page.goto(url)
    await openRoot(page)
    // Threads lead the rail, then the artifact, then Sent files.
    await section(page).waitFor()
    const order = await page.locator('.ws-thread-rail').evaluate(rail =>
      [...rail.children].filter(el => el.checkVisibility()).map(el => el.className.split(' ')[0]))
    assert.deepEqual(order.filter(c => c !== 'ws-thread-handle'), ['ws-thread-scroll', 'ws-rail-split', 'ws-rail-artifact', 'ws-rail-files'])
    const before = await stageBox(page)
    await railFrame(page).getByRole('heading', { name: 'Calibration report', exact: true }).waitFor()
    await page.waitForTimeout(200)
    assert.deepEqual(await stageBox(page), before, 'the chat column does not move when the rail artifact loads')

    // The artifact takes the height the threads above and the sent files below leave, and the files' heading stays in view.
    const geometry = await page.evaluate(() => {
      const box = sel => document.querySelector(sel).getBoundingClientRect()
      return { rail: box('.ws-thread-rail'), threads: box('.ws-thread-scroll'), section: box('.ws-rail-artifact'), files: box('.ws-rail-files'), filesHeading: box('.ws-rail-files .ws-thread-heading'), body: box('.ws-rail-artifact-body') }
    })
    assert.ok(Math.abs(geometry.section.top - geometry.threads.bottom) <= 1, `the artifact starts where the threads end: ${JSON.stringify(geometry)}`)
    assert.ok(Math.abs(geometry.files.top - geometry.section.bottom) <= 1, `the sent files start where the artifact ends: ${JSON.stringify(geometry)}`)
    assert.ok(Math.abs(geometry.files.bottom - geometry.rail.bottom) <= 1, `the regions fill the rail's height: ${JSON.stringify(geometry)}`)
    assert.ok(geometry.filesHeading.bottom <= geometry.rail.bottom, `Sent files stays in view: ${JSON.stringify(geometry)}`)
    assert.ok(geometry.body.height >= 0.3 * geometry.rail.height, `the artifact holds the larger share of the rail: ${JSON.stringify(geometry)}`)
    assert.ok(Math.abs(geometry.body.width - (geometry.rail.width - 18)) <= 3, `the artifact fills the rail's width: ${JSON.stringify(geometry)}`)
    const narrow = await scale(page)
    assert.ok(narrow > 0 && narrow < 1, `a default-width rail shows the page in miniature (${narrow})`)

    // Scrollable in place.
    const body = section(page).locator('.ws-rail-artifact-body')
    const box = await body.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, 600)
    // The sandboxed page is another origin: read its scroll from inside.
    const scrolled = () => railFrame(page).locator('body').evaluate(el => el.ownerDocument.scrollingElement.scrollTop)
    for (let i = 0; i < 20 && await scrolled() === 0; i++) await page.waitForTimeout(100)
    assert.ok(await scrolled() > 0, 'the wheel scrolls the page in place')

    // On a short window the threads and files give way; the artifact never paints over the files' heading.
    await page.setViewportSize({ width: 1440, height: 600 })
    await page.waitForTimeout(150)
    const short = await page.evaluate(() => {
      const box = sel => document.querySelector(sel).getBoundingClientRect()
      return { rail: box('.ws-thread-rail'), body: box('.ws-rail-artifact-body'), files: box('.ws-rail-files'), filesHeading: box('.ws-rail-files .ws-thread-heading') }
    })
    assert.ok(short.body.bottom <= short.files.top + 1, `the artifact stays above the sent files at 600px: ${JSON.stringify(short)}`)
    assert.ok(short.filesHeading.top >= short.files.top - 1 && short.filesHeading.bottom <= short.rail.bottom, `the sent files' heading stays in view at 600px: ${JSON.stringify(short)}`)
    assert.ok(short.body.height >= 120, `the artifact keeps a useful height at 600px: ${JSON.stringify(short)}`)
    await page.setViewportSize({ width: 1440, height: 900 })

    // The boundary between the threads and the artifact drags, persists, and resets on double-click.
    const heights = () => page.evaluate(() => ({ threads: document.querySelector('.ws-thread-scroll').getBoundingClientRect().height, body: document.querySelector('.ws-rail-artifact-body').getBoundingClientRect().height }))
    const split = page.locator('.ws-rail-split')
    const start = await heights(), s = await split.boundingBox()
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2)
    await page.mouse.down()
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2 + 60, { steps: 6 })
    await page.mouse.up()
    const dragged = await heights()
    assert.ok(Math.abs(dragged.threads - start.threads - 60) <= 2, `dragging the boundary grows the threads by the drag: ${JSON.stringify({ start, dragged })}`)
    assert.ok(Math.abs((start.body - dragged.body) - 60) <= 2, `the artifact gives up what the threads take: ${JSON.stringify({ start, dragged })}`)
    assert.equal(await page.evaluate(() => localStorage.getItem('shuttle:workspace:thread-rail-threads-height')), String(Math.round(dragged.threads)))
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2 + 60)
    await page.mouse.down()
    await page.mouse.move(s.x + s.width / 2, s.y - 2000, { steps: 6 })
    await page.mouse.up()
    assert.ok((await heights()).threads >= 72 - 1, 'the threads keep a row however far the boundary is dragged up')
    await split.dblclick()
    assert.ok(Math.abs((await heights()).threads - start.threads) <= 1, 'double-click restores the threads to their own height')
    assert.equal(await page.evaluate(() => localStorage.getItem('shuttle:workspace:thread-rail-threads-height')), null)

    // Folding unloads the page and remembers it; unfolding brings it back.
    const toggle = section(page).getByRole('button', { name: 'Artifact', exact: true })
    await toggle.click()
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(await section(page).locator('iframe').count(), 0, 'a folded artifact unloads its page')
    assert.equal(await page.evaluate(() => localStorage.getItem('shuttle:workspace:rail-artifact-open')), 'false')
    await toggle.click()
    await railFrame(page).getByRole('heading', { name: 'Calibration report', exact: true }).waitFor()

    // Widening the rail grows the page toward 1:1, up to half the window.
    const handle = page.locator('.ws-thread-handle')
    const h = await handle.boundingBox()
    await page.mouse.move(h.x + h.width / 2, h.y + 200)
    await page.mouse.down()
    await page.mouse.move(h.x - 200, h.y + 200, { steps: 6 })
    await page.mouse.move(h.x - 2000, h.y + 200, { steps: 6 })
    await page.mouse.up()
    const width = await page.locator('.ws-thread-rail').evaluate(el => el.getBoundingClientRect().width)
    assert.ok(Math.abs(width - 720) <= 1, `the rail widens to half the window (${width})`)
    await page.waitForFunction(n => Number(document.querySelector('.ws-rail-artifact')?.dataset.scale) > n, narrow)
    assert.ok(await scale(page) > narrow, 'a wider rail draws a larger page')
    await railFrame(page).getByRole('heading', { name: 'Calibration report', exact: true }).waitFor()

    // Hiding the rail unloads the page.
    await page.getByRole('button', { name: 'Hide threads and sent files', exact: true }).click()
    assert.equal(await page.locator('.ws-rail-artifact iframe').count(), 0, 'a closed rail holds no artifact page')
    await page.getByRole('button', { name: 'Show threads and sent files', exact: true }).click()
    await railFrame(page).getByRole('heading', { name: 'Calibration report', exact: true }).waitFor()

    // Open full goes to the full page, where the rail stops repeating it.
    await section(page).getByRole('button', { name: 'Open the full artifact', exact: true }).click()
    await page.locator('.ws-page.ws-selected').frameLocator('iframe').getByRole('heading', { name: 'Calibration report', exact: true }).waitFor()
    assert.equal(await section(page).isVisible(), true, 'the section keeps its heading while the artifact fills the stage')
    assert.equal(await section(page).locator('iframe').count(), 0, 'the rail does not draw the staged artifact twice')

    // Back on the chat, the page's own relative links open their documents in the reader, as on the full page.
    await page.locator('.ws-page.ws-selected').getByRole('button', { name: 'Back one level', exact: true }).click()
    await railFrame(page).getByRole('heading', { name: 'Calibration report', exact: true }).waitFor()
    await railFrame(page).locator('body').evaluate(el => el.ownerDocument.scrollingElement.scrollTo(0, 0))
    await railFrame(page).getByRole('link', { name: 'Read the independent validation →', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.ws-page.ws-selected')?.getAttribute('data-key')?.endsWith('/validation.html'))
  }, { width: 1440, height: 900 })
}
