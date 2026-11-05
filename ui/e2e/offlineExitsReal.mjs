import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getBrowser } from './browser.mjs'

const [base, uid, slug, owner = 'worker', mode = 'rest'] = process.argv.slice(2)
assert(base && uid && slug, 'Pass the isolated fixture daemon URL, UID and namespace path')
assert(new URL(base).port && new URL(base).port !== '4000', 'A private fixture port is required')
assert(['rest', 'refuse', 'pending', 'running', 'conflicted'].includes(mode), 'Unknown fixture mode')
const browser = await getBrowser({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
const shots = await mkdtemp(join(process.env.SHUTTLE_OWNER_DOWN_ARTIFACT_DIR || tmpdir(), 'shuttle-owner-down-real-'))
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  page.setDefaultTimeout(15_000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(base)
  const selector = `[data-fiber-id="${uid}"], [data-fiber-id="${slug}"]`
  const drafts = page.locator('[data-column="drafts"]').locator(selector)
  await (['running', 'conflicted'].includes(mode) ? page.locator(selector).first() : drafts.first()).waitFor()

  if (mode === 'conflicted') {
    const card = page.locator(selector).first()
    assert.match(await card.getAttribute('class'), /kbn-card--stale/)
    assert.equal(await card.getAttribute('draggable'), 'false')
    await card.click({ button: 'right' })
    assert.equal(await page.getByRole('menuitem', { name: 'Rest', exact: true }).count(), 0)
    await page.screenshot({ path: join(shots, 'unreadable-owner-before-stop.png') })
    const stopping = page.waitForResponse(reply => reply.url().endsWith('/api/v1/kill') && reply.request().method() === 'POST')
    await page.getByRole('menuitem', { name: 'Stop worker', exact: true }).click()
    const stopped = await stopping
    assert.equal(stopped.status(), 200, await stopped.text())
    assert.deepEqual(stopped.request().postDataJSON(), { fiber_id: uid, origin: owner })
    assert.equal((await stopped.json()).killed, true)
    await page.waitForFunction(async uid => {
      const feed = await (await fetch('/api/v1/fibers/composite')).json()
      const row = feed.fibers.find(row => row.fiber.id === uid || row.fiber.uid === uid)
      return row?.document_stale === true && !row.runtime
    }, uid)
    await page.reload()
    await page.locator(selector).first().waitFor()
    await page.screenshot({ path: join(shots, 'unreadable-owner-after-stop.png') })
  } else if (mode === 'pending') {
    assert.equal(await drafts.first().getAttribute('draggable'), 'true')
    assert.match(await drafts.first().getAttribute('aria-label'), /waiting for Git sync/)
    await drafts.first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: /waiting for Git sync/ }).waitFor()
    await page.getByRole('menuitem', { name: 'Rest', exact: true }).waitFor()
    await page.getByRole('menuitem', { name: 'Discard', exact: true }).waitFor()
    await page.screenshot({ path: join(shots, 'healthy-owner-waiting-for-git.png') })
  } else if (mode === 'running') {
    const card = page.locator(selector).first()
    assert.doesNotMatch(await card.getAttribute('aria-label'), /waiting for Git sync/)
    await card.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rest', exact: true }).click()
    await page.locator('.kbn-rest-popover').waitFor()
    page.on('dialog', dialog => dialog.accept())
    const applying = page.waitForResponse(reply => reply.url().endsWith('/api/v1/lifecycle') && reply.request().method() === 'POST')
    await page.keyboard.press('n')
    const applied = await applying
    assert.equal(applied.status(), 200, await applied.text())
    const output = await applied.text()
    assert.match(output, /worker: stopped/)
    assert.doesNotMatch(output, /Saved a local exit copy/)
    await page.reload()
    await page.locator(selector).first().waitFor()
    const feed = await page.evaluate(async () => (await fetch('/api/v1/fibers/composite')).json())
    const row = feed.fibers.find(row => row.fiber.id === uid || row.fiber.uid === uid)
    assert.equal(row.fiber.horizon, 'stashed')
    assert.notEqual(row.exit_copy_pending, true)
    assert.equal(feed.origins[owner].stale, false)
    await page.screenshot({ path: join(shots, 'healthy-owner-running-rest.png') })
  } else {
    assert.equal(await drafts.first().getAttribute('draggable'), 'true')
    assert.match(await drafts.first().getAttribute('aria-label'), /An exit can be saved/)
    await drafts.first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: /An exit can be saved/ }).waitFor()
    await page.screenshot({ path: join(shots, 'before-rest.png') })
    const applying = page.waitForResponse(reply => reply.url().endsWith('/api/v1/lifecycle') && reply.request().method() === 'POST')
    await page.getByRole('menuitem', { name: 'Rest', exact: true }).click()
    const applied = await applying
    assert.equal(Object.hasOwn(applied.request().postDataJSON(), 'until'), false)

    if (mode === 'refuse') {
      assert.equal(applied.status(), 502, await applied.text())
      await drafts.first().waitFor()
      const banner = page.locator('.kbn-banner-error')
      await banner.waitFor()
      assert.match(await banner.textContent(), /Rest failed:.*HTTP 502/)
      assert.doesNotMatch(await banner.textContent(), /Saved a local exit/)
      const feed = await page.evaluate(async () => (await fetch('/api/v1/fibers/composite')).json())
      const row = feed.fibers.find(row => row.fiber.id === uid || row.fiber.uid === uid)
      assert.notEqual(row.fiber.horizon, 'stashed')
      await page.screenshot({ path: join(shots, 'ambiguous-reply-refused.png') })
    } else {
      assert.equal(applied.status(), 200, await applied.text())
      assert.match(await applied.text(), /Git/)
      assert.match(await applied.text(), /no execution request/)
      await drafts.first().waitFor({ state: 'detached' })
      // Reload removes optimistic UI state: placement must come from the real composite.
      await page.reload()
      await page.locator(selector).first().waitFor()
      assert.equal(await drafts.count(), 0)
      const feed = await page.evaluate(async () => (await fetch('/api/v1/fibers/composite')).json())
      const row = feed.fibers.find(row => row.fiber.id === uid || row.fiber.uid === uid)
      assert.equal(row.fiber.horizon, 'stashed')
      assert.equal(row.origin, owner)
      assert.equal(feed.origins[owner].stale, true)
      await page.screenshot({ path: join(shots, 'after-rest.png') })

      const reading = page.waitForResponse(reply => reply.url().includes('/api/v1/fibers/') && new URL(reply.url()).searchParams.get('body') === 'true')
      await page.locator(selector).first().click()
      const read = await reading
      assert.equal(read.status(), 200, await read.text())
      assert.equal((await read.json()).source, 'local_archive')
      assert.equal((await read.json()).stale, true)
      await page.locator('.ws-reader').waitFor()
      await page.waitForFunction(() => [...document.querySelectorAll('.ws-reader .kbn-ctl-send')].every(button => button.disabled))
      assert.equal(await page.locator('.ws-reader').getByRole('button', { name: 'New session', exact: true }).count(), 0)
      const requests = []
      page.on('request', request => { if (request.method() === 'POST') requests.push(request.url()) })
      await page.locator('.ws-reader textarea').fill('Prepare this for the owner')
      await page.locator('.ws-reader textarea').press('Enter')
      await page.locator('.ws-reader textarea').press('Alt+Enter')
      assert.deepEqual(requests, [])
      await page.locator('.ws-selected').getByRole('button', { name: 'Constitution', exact: true }).click()
      await page.getByText('Body', { exact: true }).waitFor()
      await page.screenshot({ path: join(shots, 'archive-reader.png') })
    }
  }
  assert.deepEqual(errors, [])
  console.log(`Real owner-away ${mode} passed; screenshots: ${shots}`)
} finally {
  await browser.close()
}
