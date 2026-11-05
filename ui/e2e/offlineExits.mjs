import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getBrowser } from './browser.mjs'

const browser = await getBrowser({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
const shots = await mkdtemp(join(process.env.SHUTTLE_OWNER_DOWN_ARTIFACT_DIR || tmpdir(), 'shuttle-offline-planning-'))
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${pathToFileURL(resolve('harness-board-dist/index.html')).href}?offline=planning`)
  const draft = page.locator('[data-fiber-id="fixtures/offline/draft"]').first()
  await draft.waitFor()
  assert.equal(await draft.getAttribute('draggable'), 'true')
  assert.match(await draft.getAttribute('aria-label'), /An exit can be saved/)
  await draft.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Discard', exact: true }).waitFor()
  await page.getByRole('menuitem', { name: 'Rest', exact: true }).waitFor()
  await page.screenshot({ path: join(shots, 'draft-actions.png') })
  await page.getByRole('menuitem', { name: 'Move…', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Resting', exact: true }).waitFor()
  assert.equal(await page.getByRole('menuitem', { name: 'In flight', exact: true }).count(), 0)
  await page.screenshot({ path: join(shots, 'draft-move.png') })
  await page.keyboard.press('Escape')

  const resting = page.locator('[data-fiber-id="fixtures/offline/resting"]').first()
  await resting.scrollIntoViewIfNeeded()
  assert.equal(await resting.getAttribute('draggable'), 'true')
  await resting.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Discard', exact: true }).waitFor()
  await page.keyboard.press('Escape')

  const standing = page.locator('[data-fiber-id="fixtures/offline/standing"]').first()
  await standing.scrollIntoViewIfNeeded()
  await standing.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /The owner decides/ }).waitFor()
  assert.equal(await page.getByRole('menuitem', { name: 'Discard', exact: true }).count(), 0)
  assert.equal(await page.getByRole('menuitem', { name: 'Rest', exact: true }).count(), 0)
  assert.equal(await page.getByRole('menuitem', { name: 'Temper', exact: true }).count(), 0)
  await page.keyboard.press('Escape')

  const armed = page.locator('[data-fiber-id="fixtures/offline/armed"]').first()
  await armed.scrollIntoViewIfNeeded()
  assert.equal(await armed.getAttribute('draggable'), 'false')
  await armed.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /The owner decides/ }).waitFor()
  assert.equal(await page.getByRole('menuitem', { name: 'Discard', exact: true }).count(), 0)
  await page.screenshot({ path: join(shots, 'armed-explanation.png') })
  await page.keyboard.press('Escape')

  const remoteOnly = page.locator('[data-fiber-id="fixtures/offline/remote-only"]').first()
  await remoteOnly.scrollIntoViewIfNeeded()
  assert.equal(await remoteOnly.getAttribute('draggable'), 'false')
  await remoteOnly.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /The owner decides/ }).waitFor()
  assert.equal(await page.getByRole('menuitem', { name: 'Discard', exact: true }).count(), 0)
  await page.screenshot({ path: join(shots, 'remote-only-explanation.png') })
  await page.keyboard.press('Escape')

  assert.equal(await page.locator('[data-fiber-id="fixtures/offline/removed"]').count(), 0)

  const inconclusive = page.locator('[data-fiber-id="fixtures/offline/unowned-inconclusive"]').first()
  await inconclusive.scrollIntoViewIfNeeded()
  assert.equal(await inconclusive.getAttribute('draggable'), 'true')
  await inconclusive.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rest', exact: true }).waitFor()
  await page.getByRole('menuitem', { name: 'Move…', exact: true }).waitFor()
  await page.keyboard.press('Escape')

  const unowned = page.locator('[data-fiber-id="fixtures/offline/unowned"]').first()
  await unowned.scrollIntoViewIfNeeded()
  await unowned.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Move…', exact: true }).click()
  assert.equal(await page.getByRole('menuitem', { name: 'In flight', exact: true }).count(), 0)
  await page.screenshot({ path: join(shots, 'unowned-move.png') })
  assert.deepEqual(errors, [])
  console.log(`Offline exit browser checks passed; screenshots: ${shots}`)
} finally {
  await browser.close()
}
