import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getBrowser } from './browser.mjs'
import { checkChangeSecurity } from './changeSecurity.mjs'
import { buildShuttle, bakeChange } from '../scripts/bake-change-fixture.mjs'
import { createChangeGitFixture } from '../scripts/change-git-fixture.mjs'
import { gitChangedRows, collectDOMWindows, readDOMWindow, assertDOMConservation } from '../scripts/change-dom-contract.mjs'

const dist = process.env.CHANGE_HARNESS_DIST || fileURLToPath(new URL('../harness-change-dist/', import.meta.url))
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }
const dir = mkdtempSync(join(tmpdir(), 'change-dom-'))
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname
    const body = await readFile(join(dist, path === '/' ? 'index.html' : path))
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'text/html' }); res.end(body)
  } catch { res.writeHead(404); res.end() }
})
let browser
try {
  const { repo, base, head, story, hostile } = createChangeGitFixture(dir)
  const truth = gitChangedRows(repo, base, head)
  assert.ok(truth.size > 300, 'The independent Git oracle must include the multi-window change')
  for (const file of hostile) assert.ok([...truth.keys()].some(key => JSON.parse(key)[0] === file), `No Git rows for ${JSON.stringify(file)}`)
  const binary = buildShuttle(dir)
  const plain = bakeChange(binary, repo, base, head).bundle
  const authored = bakeChange(binary, repo, base, head, story).bundle
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await getBrowser({ executablePath: process.env.CHROME_PATH || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined) })
  const cases = [
    { name: 'plain desktop', bundle: plain, width: 1440 },
    { name: 'story phone', bundle: authored, width: 390 },
    { name: 'story desktop with blocked Go grammar', bundle: authored, width: 1440, blockGrammar: true },
  ]
  for (const { name, bundle, width, blockGrammar } of process.env.CHANGE_SECURITY_ONLY === '1' ? [] : cases) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
    try {
      const page = await context.newPage()
      let blocked = 0
      if (blockGrammar) await page.route(/\/assets\/go-[^/]*\.js(?:\?.*)?$/, route => { blocked++; return route.abort() })
      await page.goto(`http://127.0.0.1:${server.address().port}/`)
      await page.waitForFunction(() => typeof window.__mountChange === 'function')
      await page.evaluate(bundle => window.__mountChange(bundle), bundle)
      await page.locator('.change-diff-window').first().waitFor({ state: 'attached' })
      const windows = await collectDOMWindows(page)
      if (blockGrammar) assert.ok(blocked > 0, 'The blocked-chunk case must actually request and abort a Go grammar asset')
      // Optional end-to-end failure injection removes a real, rendered source row before
      // collection. Use this to verify that the gate itself exits nonzero.
      if (process.env.CHANGE_DOM_INJECT_LOSS === '1') {
        const last = page.locator('.change-diff-window').last()
        await last.evaluate(host => {
          const hide = root => {
            for (const node of root.querySelectorAll('*')) {
              if (node.matches('[data-line-type="change-addition"], [data-line-type="change-deletion"]')) node.remove()
              else if (node.shadowRoot) hide(node.shadowRoot)
            }
          }
          hide(host)
        })
        // Snapshot immediately, before virtual scrolling could remount the damaged window.
        const damaged = [...windows]
        damaged[damaged.length - 1] = await readDOMWindow(last, damaged.length - 1)
        assertDOMConservation(truth, damaged)
        assert.fail('Failure injection did not remove a conserved source row')
      }
      const result = assertDOMConservation(truth, windows)
      assert.ok(windows.some(window => window.renderer === 'highlighted'), 'The gate must inspect actual highlighted shadow-DOM rows')
      if (blockGrammar) assert.ok(windows.filter(window => window.file === 'main.go').every(window => window.renderer === 'plain'), 'Blocked Go grammar must retain plain rows')
      assert.ok(windows.some(window => window.file === 'large.txt'), 'The virtual large-file windows must be visited')
      if (bundle.story) {
        for (const lane of ['Story', 'Tests', 'Remaining']) assert.ok(windows.some(window => window.lane === lane), `${lane} must be inspected`)
        assert.ok(windows.some(window => window.file === 'generated.ts'), 'Folded generated files must be opened and inspected')
      }
      console.log(`PASS change DOM conservation: ${name} (${result.rows} Git rows, ${result.windows} rendered windows${blocked ? `, ${blocked} grammar requests blocked` : ''})`)
    } finally { await context.close() }
  }
  await checkChangeSecurity(browser, `http://127.0.0.1:${server.address().port}/`)
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
  rmSync(dir, { recursive: true, force: true })
}
