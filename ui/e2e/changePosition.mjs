import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { chromium, webkit } from 'playwright-core'

const source = await readFile(process.env.CHANGE_BUNDLE, 'utf8')
const engine = process.env.ENGINE ?? 'chromium'
const browser = engine === 'webkit'
  ? await webkit.launch({ headless: true })
  : await chromium.connectOverCDP(execFileSync('../bin/shared-browser', ['endpoint'], { encoding: 'utf8' }).trim())
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
try {
  const page = await context.newPage()
  page.setDefaultTimeout(30000)
  await context.addInitScript(() => { if (top === window) localStorage.clear() })
  await page.goto(`${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=change`)
  await page.evaluate(source => {
    const original = window.fetch
    window.fetch = async (input, init) => {
      if (!String(input).includes('family.change.json')) return original(input, init)
      const headers = { etag: `W/"sha256-${'a'.repeat(64)}"`, 'content-type': 'application/json' }
      if (init?.method === 'HEAD') return new Response(null, { headers })
      return new Response(source, { headers })
    }
  }, source)
  await page.locator('.kbn-card').filter({ hasText: 'Calibrate the shear response' }).click()
  const landing = await page.evaluate(() => location.hash)
  const open = () => page.locator('.ws-rail-files .ws-rail-file[data-key$="/family.change.json"]').click()
  await open()
  await page.locator('.ws-selected .change-reader h1').waitFor()
  await page.locator('.ws-selected details.change-file summary').first().click()
  await page.locator('.ws-selected .change-range-toggle').first().click()
  const windows = page.locator('.ws-selected .change-diff-window')
  const deep = windows.nth(Math.floor(await windows.count() * .7))
  await deep.evaluate(host => host.scrollIntoView())
  await page.waitForTimeout(2000)
  const before = await deep.evaluate(host => {
    const rows = host.dataset.renderState === 'highlighted'
      ? [...host.querySelector('diffs-container').shadowRoot.querySelectorAll('[data-line]')]
      : [...host.querySelectorAll('.change-plain-row:not([data-line-type="metadata"])')]
    const row = Math.min(24, rows.length - 1)
    const target = rows[row]
    const scroll = host.closest('.change-scroll')
    scroll.scrollTop += target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 100
    return { window: host.dataset.windowId, row, text: target.textContent, offset: target.getBoundingClientRect().top - scroll.getBoundingClientRect().top, scrollTop: scroll.scrollTop }
  })
  await page.waitForTimeout(1000)
  await page.evaluate(hash => { location.hash = hash }, landing)
  await page.locator('.ws-rail-files .ws-rail-file').first().waitFor()
  assert.equal(await page.locator('.change-reader').count(), 0)
  await open()
  await page.waitForFunction(anchor => {
    const host = [...document.querySelectorAll('.ws-selected .change-diff-window')].find(host => host.dataset.windowId === anchor.window)
    if (!host) return false
    const rows = host.dataset.renderState === 'highlighted'
      ? host.querySelector('diffs-container')?.shadowRoot?.querySelectorAll('[data-line]')
      : host.querySelectorAll('.change-plain-row:not([data-line-type="metadata"])')
    const row = rows?.[anchor.row]
    return row && Math.abs(row.getBoundingClientRect().top - host.closest('.change-scroll').getBoundingClientRect().top - anchor.offset) < 1
  }, before)
  await page.waitForTimeout(2000)
  const after = await page.evaluate(anchor => {
    const host = [...document.querySelectorAll('.ws-selected .change-diff-window')].find(host => host.dataset.windowId === anchor.window)
    const rows = host.dataset.renderState === 'highlighted'
      ? host.querySelector('diffs-container').shadowRoot.querySelectorAll('[data-line]')
      : host.querySelectorAll('.change-plain-row:not([data-line-type="metadata"])')
    return {
      text: rows[anchor.row].textContent,
      offset: rows[anchor.row].getBoundingClientRect().top - host.closest('.change-scroll').getBoundingClientRect().top,
      generatedOpen: document.querySelector('.ws-selected details.change-file').open,
      whole: document.querySelector('.ws-selected .change-range-toggle').textContent,
    }
  }, before)
  assert.equal(after.text, before.text)
  assert.ok(Math.abs(after.offset - before.offset) < 1, JSON.stringify({ before, after }))
  assert.ok(after.generatedOpen)
  assert.equal(after.whole, 'Show chosen range')
  const result = { engine, before, after }
  console.log(JSON.stringify(result, null, 2))
  if (process.env.POSITION_OUTPUT) await writeFile(process.env.POSITION_OUTPUT, JSON.stringify(result, null, 2))
} finally {
  await context.close()
  await browser.close()
}
