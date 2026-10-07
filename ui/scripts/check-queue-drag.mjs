/**
 * Exercise queue-row clicks and queue-to-card drops in the offline board.
 * Build first with `npm run harness:board`, then run
 * `node scripts/check-queue-drag.mjs` from ui/.
 *
 * The board itself is the production renderer and stylesheet. This script
 * wraps only the harness's mocked composite response to add a review head, a
 * queued row, and its child; it never contacts a Shuttle daemon or writes to
 * a fiber store. Clicking a row opens its document reader; Chromium performs
 * a native mouse drag for the queue-to-card move.
 */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const headId = 'loom/felt-maintenance/ledger/sweep'
const sourceId = 'work/queue-drag/source'
const childId = 'work/queue-drag/child'
const targetId = 'work/admin/conference-travel-receipts'
const sourceName = 'Requeue this review item'

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1400 }, reducedMotion: 'reduce' })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))

  // Install before the harness bundle. Its local fetch stub constructs a
  // Response from MOCK_FEED; intercept just that shape and add deterministic
  // fibers so this UI path remains isolated from the tour's teaching data.
  await page.addInitScript(({ headId, sourceId, childId }) => {
    const NativeResponse = window.Response
    const makeFiber = (id, name, status, depends_on) => ({
      origin: 'ada-workstation',
      felt_store: '/offline/loom',
      path: `.felt/${id}.md`,
      dir: `/offline/loom/.felt/${id}`,
      fiber: {
        id,
        name,
        status,
        created_at: new Date().toISOString(),
        ...(status === 'closed' ? { closed_at: new Date().toISOString() } : {}),
        tags: [],
        shuttle: { kind: 'oneshot', host: 'ada-workstation', agent: 'claude-opus', project_dir: '/offline/project' },
        ...(depends_on ? { depends_on } : {}),
      },
    })

    window.Response = class extends NativeResponse {
      constructor(body, init) {
        if (typeof body === 'string') {
          try {
            const feed = JSON.parse(body)
            if (Array.isArray(feed.fibers) && feed.fibers.some(row => row?.fiber?.id === headId)) {
              feed.fibers.push(
                makeFiber(sourceId, 'Requeue this review item', 'closed', headId),
                makeFiber(childId, 'Preserve the following item', 'open', sourceId),
              )
              body = JSON.stringify(feed)
            }
          } catch {
            // Responses unrelated to the composite feed are passed through.
          }
        }
        super(body, init)
      }
    }
  }, { headId, sourceId, childId })

  await page.goto(pathToFileURL(resolve('harness-board-dist/index.html')).href)
  const reviewHead = page.locator(`.kbn-card[data-fiber-id="${headId}"]`)
  await reviewHead.waitFor()
  const queueChip = reviewHead.locator('.kbn-card-queued')
  await queueChip.click()
  const sourceRow = reviewHead.locator('.kbn-card-queued-row', { hasText: sourceName })
  await sourceRow.waitFor()
  assert.equal(await queueChip.getAttribute('aria-expanded'), 'true')

  // Queue rows are the only visible representation of some fibers. A click
  // opens that row's own channel, not the review head underneath.
  await sourceRow.click()
  const reader = page.locator('.ws-page.ws-selected')
  await reader.waitFor()
  assert.equal(await page.locator('.ws-channel-title').innerText(), sourceName)
  assert.doesNotMatch(await reader.innerText(), /Felt-maintenance ledger sweep/)
  await page.keyboard.press('Escape')
  await reader.waitFor({ state: 'detached' })
  assert.equal(await queueChip.getAttribute('aria-expanded'), 'true', 'opening the row leaves its queue unfolded')
  await sourceRow.waitFor({ state: 'visible' })

  await queueChip.click()
  await sourceRow.waitFor({ state: 'hidden' })
  assert.equal(await queueChip.getAttribute('aria-expanded'), 'false', 'the queue chip folds its rows')
  await queueChip.click()
  await sourceRow.waitFor({ state: 'visible' })
  assert.equal(await queueChip.getAttribute('aria-expanded'), 'true', 'the queue chip unfolds its rows again')
  const target = page.locator(`.kbn-card[data-fiber-id="${targetId}"]`)
  await target.waitFor()
  await sourceRow.scrollIntoViewIfNeeded()
  await target.scrollIntoViewIfNeeded()

  // The offline harness normally swallows all writes. Observe the actual
  // production request before handing it back to that harmless stub.
  await page.evaluate(() => {
    window.queueDragWrites = []
    window.queueDragEvents = []
    for (const type of ['dragstart', 'dragenter', 'dragover', 'dragleave', 'drop', 'dragend']) {
      document.addEventListener(type, event => {
        const record = {
          type,
          phase: 'capture',
          target: event.target?.outerHTML?.slice(0, 220),
          cardId: event.target?.closest?.('.kbn-card[data-fiber-id]')?.getAttribute('data-fiber-id') ?? null,
          clientX: event.clientX,
          clientY: event.clientY,
          defaultPrevented: event.defaultPrevented,
          types: Array.from(event.dataTransfer?.types ?? []),
        }
        window.queueDragEvents.push(record)
        setTimeout(() => { record.defaultPreventedAfterDispatch = event.defaultPrevented }, 0)
      }, true)
      document.addEventListener(type, event => {
        window.queueDragEvents.push({
          type,
          phase: 'bubble',
          target: event.target?.outerHTML?.slice(0, 220),
          cardId: event.target?.closest?.('.kbn-card[data-fiber-id]')?.getAttribute('data-fiber-id') ?? null,
          clientX: event.clientX,
          clientY: event.clientY,
          defaultPrevented: event.defaultPrevented,
          types: Array.from(event.dataTransfer?.types ?? []),
        })
      })
    }
    const originalFetch = window.fetch
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/api/v1/') && init?.method === 'POST') {
        window.queueDragWrites.push({ url, body: JSON.parse(String(init.body)) })
      }
      return originalFetch(input, init)
    }
  })

  const sourceBox = await sourceRow.boundingBox()
  assert.ok(sourceBox, 'the source row has visible bounds')
  const start = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 18, start.y + 2, { steps: 3 })
  // Picking up a queue row reveals the drag horizon overlay. Wait for it to
  // finish opening before choosing a point in the target's visible area.
  await page.locator('.kbn-draghorizon-open').waitFor({ state: 'attached' })
  await page.waitForFunction(() => {
    const horizon = document.querySelector('.kbn-draghorizon-open .kbn-draghorizon-inner')
    return !!horizon && horizon.getBoundingClientRect().height >= 40
  })
  const end = await page.evaluate((targetId) => {
    const target = document.querySelector(`[data-fiber-id="${targetId}"]`)
    const list = target?.closest('.kbn-col-list')
    const horizon = document.querySelector('.kbn-draghorizon-open .kbn-draghorizon-inner')
    if (!target || !list || !horizon) return null
    const r = target.getBoundingClientRect()
    const clip = list.getBoundingClientRect()
    const horizonBottom = horizon.getBoundingClientRect().bottom
    const top = Math.max(r.top + r.height * 0.2, clip.top, horizonBottom + 2, 1)
    const bottom = Math.min(r.bottom - r.height * 0.2, clip.bottom, window.innerHeight - 1)
    const left = Math.max(r.left + r.width * 0.2, clip.left, 1)
    const right = Math.min(r.right - r.width * 0.2, clip.right, window.innerWidth - 1)
    const center = { x: (left + right) / 2, y: (top + bottom) / 2 }
    if (document.elementFromPoint(center.x, center.y)?.closest('.kbn-card[data-fiber-id]') === target) {
      return { ...center, target: r.toJSON(), clip: clip.toJSON(), horizonBottom }
    }
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 2) {
        if (document.elementFromPoint(x, y)?.closest('.kbn-card[data-fiber-id]') === target) {
          return { x, y, target: r.toJSON(), clip: clip.toJSON(), horizonBottom }
        }
      }
    }
    return { x: null, y: null, target: r.toJSON(), clip: clip.toJSON(), horizonBottom }
  }, targetId)
  if (!end || end.x === null || end.y === null) {
    await page.screenshot({ path: '/private/tmp/queue-drag-failure.png', fullPage: true })
    assert.fail(`No hit-tested point in the visible target card below the drag horizon: ${JSON.stringify(end)}`)
  }
  await page.mouse.move(end.x, end.y, { steps: 2 })
  // Playwright's native HTML DnD can emit dragenter on a newly entered node
  // without producing the next dragover until the pointer moves again.
  await page.mouse.move(end.x + 1, end.y + 1, { steps: 1 })
  await page.waitForFunction(({ targetId }) => {
    const target = document.querySelector(`[data-fiber-id="${targetId}"]`)
    return !!target?.classList.contains('kbn-card-stack-target')
  }, { targetId }, { timeout: 7000 }).catch(async error => {
    await page.screenshot({ path: '/private/tmp/queue-drag-failure.png', fullPage: true })
    const actual = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y)
      return { tag: element?.tagName, className: element?.className, text: element?.textContent?.slice(0, 100) }
    }, end)
    const events = await page.evaluate(() => window.queueDragEvents)
    throw new Error(`Target did not arm at ${JSON.stringify(end)}; actual hit: ${JSON.stringify(actual)}; events: ${JSON.stringify(events)}; ${error.message}`)
  })
  const aim = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y)
    return {
      fiberId: element?.closest('.kbn-card[data-fiber-id]')?.getAttribute('data-fiber-id') ?? null,
      tag: element?.tagName ?? null,
      className: element?.className ?? null,
    }
  }, end)
  assert.equal(aim.fiberId, targetId, `the actual release point is on the intended card, not an overlay: ${JSON.stringify(aim)}`)
  const targetHighlight = await target.evaluate(el => el.className)
  assert.match(targetHighlight, /kbn-card-queue-stack-target|kbn-card-stack-target/, `target card shows a queue drop affordance: ${targetHighlight}`)
  const columnHighlight = await page.locator('.kbn-now-board > section.kbn-col-inFlight').evaluate(el => el.className)
  await page.mouse.up()

  await page.waitForTimeout(1200)
  const debug = await page.evaluate(() => ({ requests: window.queueDragWrites, events: window.queueDragEvents }))
  const drop = debug.events.find(event => event.type === 'drop' && event.phase === 'capture')
  assert.equal(drop?.cardId, targetId, `the native drop event reached the intended card: ${JSON.stringify({ drop, events: debug.events, requests: debug.requests })}`)
  assert.equal(drop?.defaultPreventedAfterDispatch, true, `the card handler claimed the native drop: ${JSON.stringify({ drop, events: debug.events, requests: debug.requests })}`)
  assert.ok(debug.requests.length >= 2, `expected queue edge writes after card drop; events: ${JSON.stringify(debug.events)}`)
  const requests = debug.requests
  assert.ok(requests.every(request => request.url.endsWith('/api/v1/felt-edit')), `the queue drag sends only felt edits: ${JSON.stringify(requests)}`)
  const writes = requests.map(request => request.body)
  const sourceWrite = writes.find(write => write.fiber_id === 'work/queue-drag/source')
  const childWrite = writes.find(write => write.fiber_id === 'work/queue-drag/child')
  assert.deepEqual(sourceWrite?.set, { depends_on: 'work/admin/conference-travel-receipts' }, 'the queued row is reattached behind the card that was aimed at')
  assert.deepEqual(childWrite?.set, { depends_on: 'loom/felt-maintenance/ledger/sweep' }, 'its old child is repaired to preserve the original queue')
  assert.deepEqual(errors, [], `the browser reported no page errors: ${errors.join('; ')}`)

  assert.doesNotMatch(columnHighlight, /kbn-col-drop/, `hovering the individual card does not mark the whole In flight column as the destination: ${columnHighlight}`)
  console.log('Queue row opens its reader and native queue-to-card drop passed; writes:', JSON.stringify(writes))
} finally {
  await browser.close()
}
