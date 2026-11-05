import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getBrowser } from './browser.mjs'

const [base, uid, slug] = process.argv.slice(2)
assert(base && uid && slug, 'Pass the isolated fixture daemon URL, UID and namespace path')
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
  await drafts.first().waitFor()
  assert.equal(await drafts.first().getAttribute('draggable'), 'true')
  await drafts.first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: /Planning changes.*Git sync/ }).waitFor()
  await page.screenshot({ path: join(shots, 'before-rest.png') })
  await page.getByRole('menuitem', { name: 'Rest', exact: true }).click()
  await page.locator('.kbn-rest-popover').waitFor()
  const applying = page.waitForResponse(reply => reply.url().endsWith('/api/v1/lifecycle') && reply.request().method() === 'POST')
  await page.keyboard.press('n')
  const applied = await applying
  assert.equal(applied.status(), 200, await applied.text())
  assert.match(await applied.text(), /Git/)
  assert.match(await applied.text(), /no execution request/)
  await drafts.first().waitFor({ state: 'detached' })

  // Reload removes optimistic UI state: this must come from the real composite.
  await page.reload()
  await page.locator(selector).first().waitFor()
  assert.equal(await drafts.count(), 0)
  const feed = await page.evaluate(async () => (await fetch('/api/v1/fibers/composite')).json())
  const row = feed.fibers.find(row => row.fiber.id === uid || row.fiber.uid === uid)
  assert.equal(row.fiber.horizon, 'stashed')
  assert.equal(row.origin, 'worker')
  assert.equal(feed.origins.worker.stale, true)
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
  const requests=[]
  page.on('request',request=>{if(request.method()==='POST')requests.push(request.url())})
  await page.locator('.ws-reader textarea').fill('Prepare this for the owner')
  await page.locator('.ws-reader textarea').press('Enter')
  await page.locator('.ws-reader textarea').press('Alt+Enter')
  assert.deepEqual(requests,[])
  await page.locator('.ws-selected').getByRole('button', { name: 'Constitution', exact: true }).click()
  await page.getByText('Body', { exact: true }).waitFor()
  await page.screenshot({ path: join(shots, 'archive-reader.png') })
  assert.deepEqual(errors, [])
  console.log(`Real offline Rest and archive reader passed; screenshots: ${shots}`)
} finally {
  await browser.close()
}
