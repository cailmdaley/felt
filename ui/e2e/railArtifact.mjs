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
  test('Rail artifact: live at the head of the rail, scrollable in place, folded, scaled by the rail, opened full', async page => {
    await page.addInitScript(() => {
      if (window !== window.top) return
      localStorage.setItem('shuttle:workspace:sidebar', 'false')
      localStorage.setItem('shuttle:workspace:rail', 'true')
    })
    await page.goto(url)
    await openRoot(page)
    // The artifact heads the rail, above Threads and Sent files.
    await section(page).waitFor()
    const order = await page.locator('.ws-thread-rail').evaluate(rail =>
      [...rail.children].filter(el => el.checkVisibility()).map(el => el.className.split(' ')[0]))
    assert.deepEqual(order.filter(c => c !== 'ws-thread-handle'), ['ws-rail-artifact', 'ws-thread-scroll', 'ws-rail-files'])
    const before = await stageBox(page)
    await railFrame(page).getByRole('heading', { name: 'Calibration report', exact: true }).waitFor()
    await page.waitForTimeout(200)
    assert.deepEqual(await stageBox(page), before, 'the chat column does not move when the rail artifact loads')

    // The Threads heading stays in view beneath it.
    const geometry = await page.evaluate(() => {
      const rail = document.querySelector('.ws-thread-rail').getBoundingClientRect()
      const heading = document.querySelector('.ws-thread-scroll .ws-thread-heading').getBoundingClientRect()
      const body = document.querySelector('.ws-rail-artifact-body').getBoundingClientRect()
      return { rail, heading, body }
    })
    assert.ok(geometry.heading.bottom <= geometry.rail.bottom, `Threads stays in view: ${JSON.stringify(geometry)}`)
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

    // The page's own relative links open their documents in the reader, as on the full page.
    await railFrame(page).locator('body').evaluate(el => el.ownerDocument.scrollingElement.scrollTo(0, 0))
    await railFrame(page).getByRole('link', { name: 'Read the independent validation →', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.ws-page.ws-selected')?.getAttribute('data-key')?.endsWith('/validation.html'))
    await page.locator('.ws-selected .ws-document-back, .ws-selected .ws-chat-back').first().waitFor({ state: 'attached' })
    await page.goBack().catch(() => {})
    await page.waitForFunction(() => document.querySelector('.ws-page.ws-selected')?.getAttribute('data-key')?.startsWith('chat:'), null, { timeout: 5000 }).catch(() => {})
    if (!await page.locator('.ws-page.ws-selected[data-key^="chat:"]').count()) await page.keyboard.press('Escape')
    await railFrame(page).getByRole('heading', { name: 'Calibration report', exact: true }).waitFor()

    // Open full goes to the full page, where the rail stops repeating it.
    await section(page).getByRole('button', { name: 'Open the full artifact', exact: true }).click()
    await page.locator('.ws-page.ws-selected').frameLocator('iframe').getByRole('heading', { name: 'Calibration report', exact: true }).waitFor()
    assert.equal(await section(page).isVisible(), true, 'the section keeps its heading while the artifact fills the stage')
    assert.equal(await section(page).locator('iframe').count(), 0, 'the rail does not draw the staged artifact twice')
  }, { width: 1440, height: 900 })
}
