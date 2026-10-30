import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getBrowser } from './browser.mjs'
import { frames, layoutShift, unexpected } from './layoutShift.mjs'
import { registerLivingReportJourneys } from './livingReport.mjs'
import { registerHeaderBarJourneys } from './headerBar.mjs'

const browser = await getBrowser({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required'] })
const url = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=workspace`
const name = 'Calibrate the shear response'
const tests = []
const test = (name, run, viewport, sidebarChoice = 'false', reducedMotion = 'reduce', touch = false) => tests.push({ name, run, viewport, sidebarChoice, reducedMotion, touch })
const selected = p => p.locator('.ws-page.ws-selected')
const plainThemeLabel = "Plain (drop this constitution's theme)"
const displayLabel = label => ({ 'calibration-report': 'Calibration report', 'brief.md': 'Field note' })[label] ?? label
const pageFor = (p, label) => {
  if (label === 'Chat') return p.locator('.ws-page:not(.ws-parked)[data-key^="chat:"]')
  if (label === 'Constitution') return p.locator('.ws-page:not(.ws-parked)[data-key^="fiber:"]')
  return p.locator(`.ws-page[data-key$="/${label === 'calibration-report' ? 'report.html' : label}"]`)
}
const isSelected = async (p, label) => await pageFor(p, label).and(p.locator('.ws-selected')).count() === 1
async function openPlainThemeMenu(p) {
  if (await isSelected(p, 'Chat')) await choose(p, 'calibration-report')
  const plain = p.getByRole('button', { name: plainThemeLabel, exact: true })
  if (await plain.isVisible()) return plain
  const menu = p.viewportSize().width <= 700 ? p.locator('.ws-navbar .ws-phone-document-menu') : selected(p).getByRole('button', { name: 'Document menu', exact: true })
  if (p.viewportSize().width <= 700) await menu.focus()
  await menu.click()
  return p.getByRole('button', { name: plainThemeLabel, exact: true })
}
async function open(p, expected = 'calibration-report') {
  await p.locator('.kbn-desk .kbn-card').filter({ hasText: name }).click()
  await selected(p).waitFor()
  await choose(p, expected)
}
async function headerAction(p, label) {
  const button = selected(p).getByRole('button', { name: label, exact: true })
  if (!await button.isVisible()) await selected(p).getByRole('button', { name: 'Settings', exact: true }).click()
  await button.click()
}
async function chatMenu(p, label) {
  const sheet = p.locator('.ws-page-sheet[open], .ws-settings-menu:not([hidden])')
  if (['Settings', 'Sessions'].includes(label) && await sheet.count()) {
    await p.keyboard.press('Escape'); await sheet.waitFor({ state: 'hidden' }); return
  }
  await choose(p, 'Chat')
  await headerAction(p, ['Settings', 'Sessions'].includes(label) ? 'Settings' : label)
}
/** Sent-file rows: the desktop rail's region beneath the threads, or the phone's sheet. */
async function sentFiles(p) {
  if (p.viewportSize().width > 700) {
    const sheet = p.locator('.ws-page-sheet[open], .ws-settings-menu:not([hidden])')
    if (await sheet.count()) { await p.keyboard.press('Escape'); await sheet.waitFor({ state: 'hidden' }) }
    if (await p.locator('.ws-reader.ws-rail-off').count()) await p.locator('.ws-rail-toggle').click()
    await p.locator('.ws-rail-files').waitFor()
    return p.locator('.ws-rail-files .ws-rail-file')
  }
  const rows = p.locator('.ws-page-sheet[open] .ws-sent-file')
  if (await p.locator('.ws-page-sheet[open]').count()) return rows
  const chat = await isSelected(p, 'Chat')
  if (!chat) {
    const menu = p.locator('.ws-navbar .ws-phone-document-menu')
    await menu.focus(); await menu.click()
  } else await p.locator('.ws-rail-toggle').click()
  if (!chat) await p.getByRole('button', { name: 'Sent files', exact: true }).click()
  await p.locator('.ws-page-sheet[open]').waitFor()
  return rows
}

test('The layout-shift guard ignores hidden geometry but catches visible movement', async p => {
  await p.evaluate(() => {
    const root = document.createElement('div'); root.id = 'layout-shift-fixture'
    root.style.cssText = 'position:fixed;top:100px;left:100px;width:100px;height:100px'
    root.innerHTML = '<div class="visible" style="width:10px;height:10px"></div><div class="hidden" style="visibility:hidden;width:10px;height:10px"></div>'
    document.body.append(root)
  })
  const move = cls => p.locator(`#layout-shift-fixture .${cls}`).evaluate(el => { el.style.transform = 'translateX(10px)' })
  assert.deepEqual(await layoutShift(p, { regions: ['#layout-shift-fixture'], act: () => move('hidden') }), [])
  const visible = await layoutShift(p, { regions: ['#layout-shift-fixture'], act: () => move('visible') })
  assert.equal(visible.length, 1); assert.equal(visible[0].dx, 10)
  await p.locator('#layout-shift-fixture').evaluate(el => el.remove())
})

for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  test(`Role charter holds assigned constitutions without model holders (${device})`, async p => {
    await open(p); await choose(p, 'Constitution')
    const office = selected(p).locator('.ws-fiber-role a.kbn-wikilink-live')
    assert.equal((await office.innerText()).trim().toLowerCase(), 'surveyor')
    await office.click()
    const ledger = selected(p).locator('[data-part="role-ledger"]')
    await ledger.waitFor()
    assert.deepEqual(await ledger.locator('.ws-role-caption').allTextContents(), ['Holds'])
    assert.deepEqual(await ledger.locator('.ws-role-hold-name').allTextContents(), ['Calibrate the shear response', 'Weekly shear summary'])
    assert.equal(await ledger.locator('[data-part="role-holders"]').count(), 0)
    await ledger.locator('.ws-role-hold').first().click()
    await choose(p, 'Constitution')
    await selected(p).locator('.ws-fiber-role').waitFor()
    assert.match(await selected(p).locator('[data-part="fiber-title"]').innerText(), /Calibrate the shear response/)
  }, viewport)
}

test('The chat follows a live transcript by byte offset', async p => {
  await p.goto(`${url}&transcript=live`)
  await p.locator('.kbn-card').filter({ hasText: name }).click()
  await choose(p, 'Chat')
  const band = selected(p).locator('.ws-transcript')
  await band.waitFor()
  await band.getByText(/Run the remaining validation batches/).waitFor()
  await band.locator('.ws-transcript-working-inline').waitFor()
  const first = await p.evaluate(() => window.__harness.requests.find(r => r.url.includes('/api/v1/transcript/raw')))
  const firstUrl = new URL(first.url, 'file:///')
  assert.equal(firstUrl.searchParams.get('session'), 'c1a5e0d2-5b8f-4c1e-9a7e-2f3d4b5c6a71')
  assert.equal(firstUrl.searchParams.get('offset'), '0')
  assert.equal(firstUrl.searchParams.get('host'), 'umber-workstation')
  await p.clock.fastForward(3100)
  const requests = await p.evaluate(() => window.__harness.requests.filter(r => r.url.includes('/api/v1/transcript/raw')))
  assert.ok(requests.length >= 2)
  await band.getByText('Live worker update 1: the next fictional validation batch is in progress.').waitFor()
  assert.ok(Number(new URL(requests.at(-1).url, 'file:///').searchParams.get('offset')) > 0)
})

for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) test(`Shuttle messages are separate expandable chat rows (${device})`, async p => {
  await p.goto(`${url}&transcript=messages`)
  await p.locator('.kbn-card').filter({ hasText: name }).click()
  await choose(p, 'Chat')
  const transcript = selected(p).locator('.ws-transcript')
  const scroller = transcript.locator('.ws-transcript-scroll')
  await scroller.waitFor()
  await scroller.evaluate((scroll, bottom) => { scroll.scrollTop = bottom ? scroll.scrollHeight : 0 }, device === 'desktop')
  await frames(p)

  // Representative before/after captures use desktop light and phone dark.
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme })
    await frames(p)
    const rows = transcript.locator('.ws-transcript-shuttle-message')
    assert.equal(await rows.count(), 3, 'the sent message and both kinds of incoming message have their own rows')
    assert.equal(await rows.nth(0).getAttribute('data-direction'), 'sent')
    assert.equal(await rows.nth(1).getAttribute('data-direction'), 'received')
    assert.equal(await rows.nth(0).locator('.ws-transcript-message-detail').isVisible(), false, 'sent text starts collapsed')
    assert.equal(await rows.nth(1).locator('.ws-transcript-message-detail').isVisible(), false, 'received text starts collapsed')
    assert.ok(!(await rows.nth(0).innerText()).includes('shuttle://'), 'the compact row hides the raw session address')
    assert.ok(!(await rows.nth(1).innerText()).includes('msg-abcdef'), 'the compact row hides the message id')
    const capture = process.env.WORKSPACE_SHOTS && (device === 'desktop' && scheme === 'light' || device === 'phone' && scheme === 'dark')
    if (capture) {
      await mkdir(process.env.WORKSPACE_SHOTS, { recursive: true })
      await p.screenshot({ path: resolve(process.env.WORKSPACE_SHOTS, `messages-${device}-collapsed.png`) })
    }
  }

  const sent = transcript.locator('.ws-transcript-shuttle-message[data-direction="sent"]')
  const incoming = transcript.locator('.ws-transcript-shuttle-message[data-direction="received"]')
  assert.equal(await incoming.count(), 2, 'both the thread and session delivery remain visible')
  const received = incoming.nth(0)
  const sessionMessage = incoming.nth(1)
  assert.ok(!(await sent.evaluate(row => row.closest('.ws-transcript-steplist'))), 'the sent row sits outside tool groups')
  assert.ok(!(await received.evaluate(row => row.closest('.ws-transcript-steplist'))), 'the received row sits outside tool groups')
  await sent.locator('.ws-transcript-message-peer.ws-constitution-chip').waitFor()
  assert.equal(await sent.locator('.ws-transcript-message-peer.ws-constitution-chip').count(), 1, 'the destination resolves as a thread chip')
  await sent.locator('.ws-transcript-message-direction').click()
  assert.match(await sent.locator('.ws-transcript-message-text:not(.ws-transcript-message-source)').innerText(), /north patch residual is in the new table/)
  await received.locator('.ws-transcript-message-direction').click()
  assert.match(await received.locator('.ws-transcript-message-text:not(.ws-transcript-message-source)').innerText(), /follow-up reviewed the north patch residual/)
  assert.equal(await received.locator('.ws-transcript-message-preview').isVisible(), false, 'expanding replaces the preview with the full message')
  await received.locator('.ws-transcript-message-peer.ws-constitution-chip').waitFor()
  assert.equal(await received.locator('.ws-transcript-message-peer.ws-constitution-chip').getAttribute('data-fiber'), 'research/workspace/validation-follow-up', 'the sender resolves to its thread chip')
  const sessionChip = sessionMessage.locator('.ws-transcript-session-chip')
  await sessionChip.waitFor()
  assert.ok(!(await sessionMessage.innerText()).includes('shuttle://'), 'the compact session row hides its address')
  assert.equal(await sessionChip.locator('.ws-transcript-session-id').evaluate(node => node.textContent), ' · …123456', 'the short session id remains visible')
  const sessionChipBox = await sessionChip.boundingBox()
  assert.ok(sessionChipBox && sessionChipBox.width <= viewport.width * 0.6 + 1, 'the session chip stays within the row width')
  assert.equal(await sessionChip.locator('.ws-transcript-session-label').evaluate(node => getComputedStyle(node).textOverflow), 'ellipsis', 'the host part clips with an ellipsis')

  assert.equal(await transcript.locator('.ws-transcript-steps').filter({ hasText: 'Bash 1' }).count(), 0, 'a pure send does not repeat as a tool group')
  assert.match(await sent.locator('.ws-transcript-message-command').innerText(), /shuttle message research\/workspace\/validation-follow-up/, 'the expanded message retains the source command')
  if (process.env.WORKSPACE_SHOTS) {
    await p.emulateMedia({ colorScheme: device === 'desktop' ? 'light' : 'dark' })
    await frames(p)
    await p.screenshot({ path: resolve(process.env.WORKSPACE_SHOTS, `messages-${device}-expanded.png`) })
  }
}, viewport)

test('The chat never moves under a reader through live polls and snapshot refreshes, and follows at the bottom', async p => {
  await p.goto(`${url}&transcript=live`)
  await p.locator('.kbn-card').filter({ hasText: name }).click()
  await choose(p, 'Chat')
  const scroller = selected(p).locator('.ws-transcript-scroll')
  await scroller.getByText(/Run the remaining validation batches/).waitFor()
  const geometry = () => scroller.evaluate(s => ({ top: s.scrollTop, height: s.scrollHeight, bottom: s.scrollHeight - s.clientHeight - s.scrollTop }))
  // Pinned to the bottom, the view follows each live update as it lands (the fixture grows for 20 reads).
  for (let i = 0; i < 4; i++) {
    const before = await geometry()
    await p.clock.fastForward(3100)
    await p.waitForFunction(height => document.querySelector('.ws-selected .ws-transcript-scroll').scrollHeight > height, before.height, { timeout: 5000 })
    await frames(p)
    const after = await geometry()
    assert.ok(after.bottom <= 2, `follows the newest message (${after.bottom}px short of the bottom)`)
  }
  // The board's snapshot feed changes the worker's checklist between polls.
  const setTasks = tasks => p.evaluate(tasks => {
    const entry = window.__harness.MOCK_FEED.fibers.find(row => row.runtime?.tmux_session === 'fixture-transcript-worker')
    entry.runtime.tasks = tasks
  }, tasks)
  // Parked mid-transcript: count every write of the scroller's position.
  await scroller.evaluate(s => {
    s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) / 2)
    const native = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
    window.__scrollWrites = []
    Object.defineProperty(s, 'scrollTop', { configurable: true, get() { return native.get.call(this) }, set(value) {
      window.__scrollWrites.push({ from: native.get.call(this), to: value })
      native.set.call(this, value)
    } })
  })
  await frames(p)
  const anchorTop = () => scroller.evaluate(s => {
    const edge = s.getBoundingClientRect().top
    window.__anchor ??= [...s.querySelectorAll('.ws-transcript-msg')].find(node => node.getBoundingClientRect().top > edge + 40)
    const key = window.__anchor.dataset.readingKey
    const node = window.__anchor.isConnected ? window.__anchor : s.querySelector(`[data-reading-key="${CSS.escape(key)}"]`)
    return node.getBoundingClientRect().top
  })
  const start = await anchorTop()
  const checklists = [
    [{ id: '1', subject: 'Validate the batches', status: 'in_progress', activeForm: 'Validating the batches' }],
    [{ id: '1', subject: 'Validate the batches', status: 'completed' }, { id: '2', subject: 'Write the report', status: 'in_progress', activeForm: 'Writing the report' }, { id: '3', subject: 'Review the figures', status: 'pending' }],
    [],
  ]
  for (const tasks of checklists) {
    await setTasks(tasks)
    // Several live transcript polls and one snapshot poll of the board.
    for (let i = 0; i < 5; i++) { await p.clock.fastForward(3100); await frames(p) }
    const drift = await anchorTop() - start
    assert.ok(Math.abs(drift) <= 1, `the message under the reader stays put (moved ${drift}px)`)
  }
  const writes = await p.evaluate(() => window.__scrollWrites)
  assert.deepEqual(writes.filter(write => Math.abs(write.to - write.from) < 0.5), [], 'no refresh rewrites the position it already has: each write would stop a scroll in flight')
})

test('A refresh never changes a painted frame of the chat: no jolt, no pass through the top, nothing above the reader rebuilt', async p => {
  await p.goto(`${url}&transcript=live`)
  await p.locator('.kbn-card').filter({ hasText: name }).click()
  await choose(p, 'Chat')
  const scroller = selected(p).locator('.ws-transcript-scroll')
  await scroller.getByText(/Run the remaining validation batches/).waitFor()
  // Let the live fixture grow to its full length, then wait for the spawned thread's chip to resolve.
  for (let i = 0; i < 22; i++) { await p.clock.fastForward(3100); await frames(p) }
  await scroller.locator('.ws-transcript-spawn-chip:not([hidden])').first().waitFor()
  const log = await scroller.evaluate(s => {
    s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) / 2)
    const edge = () => s.getBoundingClientRect().top
    const chip = s.querySelector('.ws-transcript-spawn-chip:not([hidden])')
    const anchor = [...s.querySelectorAll('.ws-transcript-msg')].find(node => node.getBoundingClientRect().top > edge() + 40)
    if (!(chip.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING)) throw new Error('the spawn chip must sit above the reader')
    const notice = s.querySelector('.ws-transcript-thread-notice')
    const sent = [...s.querySelectorAll('.ws-transcript-sent-file')].find(row => row.textContent.includes('response.pdf'))
    if (!notice || !(notice.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING)) throw new Error('the thread notice must sit above the reader')
    if (!sent || !(sent.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING)) throw new Error('the sent file must sit above the reader')
    const log = { anchor: anchor.dataset.readingKey, frames: [], removed: [], touched: [] }
    // Every frame: where the message under the reader sits, and where the scroller is.
    const sample = () => {
      const current = document.querySelector('.ws-selected .ws-transcript-scroll')
      const node = current?.querySelector(`[data-reading-key="${CSS.escape(log.anchor)}"]`)
      log.frames.push({ same: current === s, top: node ? node.getBoundingClientRect().top - current.getBoundingClientRect().top : null, scrollTop: current?.scrollTop ?? null })
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
    // A node above the reader taken out of the document is a subtree torn down and rebuilt;
    // with nothing new to read, a refresh touches nothing in the chat at all.
    new MutationObserver(records => {
      for (const record of records) log.touched.push(`${record.type} ${record.target.className ?? record.target.nodeName}${record.attributeName ? ` @${record.attributeName}` : ''}`)
      for (const record of records) for (const node of record.removedNodes) {
        if (node instanceof Element && !node.isConnected && (node.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING || record.target.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING)) log.removed.push(`${record.target.className} − ${node.className}`)
      }
    }).observe(s, { childList: true, subtree: true, attributes: true, characterData: true })
    window.__jolt = log
    return null
  })
  await frames(p)
  const shot = async label => { if (process.env.WORKSPACE_SHOTS) await scroller.screenshot({ path: `${process.env.WORKSPACE_SHOTS}/jolt-${label}.png` }) }
  await shot('before-polls')
  // Live reads every 3 s and the board's 15 s snapshot poll, over three snapshot cycles.
  for (let i = 0; i < 15; i++) { await p.clock.fastForward(3100); await frames(p) }
  await shot('after-polls')
  const { frames: seen, removed, touched } = await p.evaluate(() => window.__jolt)
  assert.ok(seen.length > 30, `sampled every frame (${seen.length})`)
  assert.ok(seen.every(frame => frame.same), 'the chat keeps its scroller element')
  assert.ok(seen.every(frame => frame.scrollTop > 0), 'the chat never passes through the top while the reader is parked mid-transcript')
  const start = seen[0].top
  const worst = Math.max(...seen.map(frame => Math.abs(frame.top - start)))
  assert.ok(worst <= 1, `the message under the reader holds on every frame (moved up to ${worst}px)`)
  assert.deepEqual(removed, [], 'no refresh removes anything above the reader')
  assert.deepEqual([...new Set(touched)], [], 'a refresh that brings nothing new changes nothing in the chat')
})

test('The large transcript pages earlier turns inline, retains them across files and leaves the board live', async p => {
  await p.goto(`${url}&transcript=large`)
  await p.locator('.kbn-card').filter({ hasText: name }).click()
  const band = selected(p).locator('.ws-transcript')
  await band.getByText('Fixture bin 3000 is within the review tolerance; retain the measured value and continue.').waitFor()
  const before = await band.locator('.ws-transcript-turn').count()
  assert.equal(before, 8)
  const earlier = band.locator('.ws-transcript-earlier')
  assert.match(await earlier.innerText(), /12 earlier turns/i)
  await earlier.click()
  assert.equal(await band.locator('.ws-transcript-turn').count(), 20)
  assert.equal(await p.locator('dialog[open], .ws-transcript-dialog').count(), 0)
  await choose(p, 'calibration-report'); await choose(p, 'Chat')
  assert.equal(await band.locator('.ws-transcript-turn').count(), 20)
  await appFocus(p); await p.keyboard.press('Escape')
  await poll(p, () => !document.querySelector('.kbn-reader-open'))
})

async function choose(p, label) {
  const sheet = p.locator('.ws-page-sheet[open], .ws-settings-menu:not([hidden])')
  if (await sheet.count() && ['Chat', 'Constitution', 'calibration-report'].includes(label)) {
    await p.keyboard.press('Escape'); await sheet.waitFor({ state: 'hidden' })
  }
  if (await isSelected(p, label)) return
  if (label === 'Chat' || label === 'Constitution') {
    if (!await isSelected(p, 'Chat')) {
      if (await p.locator('.ws-navbar .ws-channel-title').isVisible()) {
        await p.locator('.ws-navbar .ws-channel-title').click()
        const current = p.locator('.ws-switcher .ws-channel-row[aria-current="true"]')
        await current.waitFor({ state: 'visible' })
        await current.click()
      } else {
        const toggle = p.locator('.ws-reader .ws-sidebar-toggle:not(.ws-rail-toggle)')
        const reveal = await toggle.getAttribute('aria-expanded') !== 'true'
        if (reveal) await toggle.click()
        const current = p.locator('.ws-sidebar .ws-channel-row[aria-current="true"]')
        await current.waitFor({ state: 'visible' })
        await current.click()
        if (reveal) await toggle.click()
      }
      await pageFor(p, 'Chat').and(p.locator('.ws-selected')).waitFor()
    }
    if (label === 'Constitution') {
      await headerAction(p, 'Constitution')
    }
  } else if (label === 'calibration-report' && await isSelected(p, 'Chat')) {
    await selected(p).locator('.ws-report-chip').click()
  } else {
    const rows = await sentFiles(p)
    const target = rows.and(p.locator(`[data-key$="/${label === 'calibration-report' ? 'report.html' : label}"]`))
    if (!await target.count()) {
      const more = p.locator('[data-part="sent-files-more"]:visible')
      if (await more.count()) await more.click()
    }
    await target.click()
    await poll(p, () => !document.querySelector('.ws-page-sheet')?.open)
  }
  await pageFor(p, label).and(p.locator('.ws-selected')).waitFor()
  await p.waitForTimeout(100)
}
async function poll(p, fn, arg) { await p.waitForFunction(fn, arg, { timeout: 15000, polling: 40 }) }
// The board bar: one row of view tabs, Find, the view's centre and Settings, on every view.
const barTab = (p, view) => p.locator(`.kbn-viewtabs .kbn-viewtab[data-view="${view}"]`)
// Hand the keyboard back to the app (no field, no frame holds it).
const appFocus = p => p.evaluate(() => document.activeElement?.blur())
const activeBarView = p => p.evaluate(() => document.querySelector('.kbn-viewtabs .kbn-viewtab-active')?.dataset.view ?? null)
const barFind = p => p.locator('.kbn-viewtabs-find input')
// Leave the reader: the phone's back chevron, or on the desktop the bar's
// origin tab (the view the reader was opened from), which closes it back there.
async function leave(p) {
  const sheet = p.locator('.ws-page-sheet[open], .ws-settings-menu:not([hidden])')
  if (await sheet.count()) { await p.keyboard.press('Escape'); await sheet.waitFor({ state: 'hidden' }) }
  if (p.viewportSize().width <= 700) {
    for (let step = 0; step < 32 && await p.locator('.kbn-reader-open').count(); step++) {
      await appFocus(p); await p.keyboard.press('Escape'); await p.waitForTimeout(30)
    }
    await poll(p, () => !document.querySelector('.kbn-reader-open')); return
  }
  await p.locator('.kbn-viewtabs .kbn-viewtab-active').click()
  await poll(p, () => !document.querySelector('.kbn-reader-open'))
}
async function chooseDeskColumn(p, index) {
  const segment = p.locator(`.kbn-folio-seg[data-folio="${index}"]`)
  if (!await segment.isVisible()) return
  await segment.click()
  await poll(p, index => document.querySelector(`.kbn-folio-seg[data-folio="${index}"]`)?.getAttribute('aria-selected') === 'true', index)
  // The strip marks the leaf before the pager's scroll lands on it; wait for the leaf itself.
  await poll(p, index => {
    const leaf = document.querySelectorAll('.kbn-now-board > .kbn-col')[index]?.getBoundingClientRect()
    return !!leaf && leaf.left >= 0 && leaf.right <= innerWidth
  }, index)
}
test('Phone 375 Desk folio keeps its full label and count clear of the active action', async p => {
  const tab = p.locator('.kbn-folio-seg-active')
  await tab.waitFor()
  const layout = await tab.evaluate(segment => {
    const name = segment.querySelector('.kbn-folio-name')
    const count = segment.querySelector('.kbn-folio-count')
    const action = segment.querySelector('.kbn-col-action')
    const label = action?.querySelector('.kbn-col-action-label')
    const rect = el => { const box = el.getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth } }
    return {
      tabName: name?.textContent,
      tabLabel: segment.getAttribute('aria-label'),
      count: count?.textContent,
      actionLabel: action?.getAttribute('aria-label'),
      actionTextDisplay: label ? getComputedStyle(label).display : null,
      tab: rect(segment), name: rect(name), countBox: rect(count), action: rect(action),
    }
  })
  assert.equal(layout.tabName, 'In flight')
  assert.match(layout.tabLabel, /^In flight \(/)
  assert.equal(layout.actionLabel, 'New idea — speak it into a card')
  assert.equal(layout.actionTextDisplay, 'none')
  assert.ok(layout.name.scrollWidth <= layout.name.clientWidth + 1, 'the full tab name fits')
  assert.ok(layout.name.right <= layout.countBox.left + 1, 'the count follows the name')
  assert.ok(layout.countBox.right <= layout.action.left + 1, 'the action follows the count')
  assert.ok(layout.action.right <= layout.tab.right + 1, 'the action stays inside the tab')
}, { width: 375, height: 667 })
async function revealLatestFiles(p) {
  const latest = p.locator('.ws-overview-latest')
  await latest.waitFor()
  const summary = latest.locator('summary')
  await summary.getByText('Latest files', { exact: true }).waitFor()
  assert.equal(await latest.evaluate(details => details.open), false, 'Latest files starts folded')
  await summary.click()
  const ribbon = latest.locator('.ws-overview-ribbon')
  await ribbon.waitFor({ state: 'visible' })
  return ribbon
}
const reportPage = p => p.locator('.ws-page[data-key="umber-workstation:/fixture-store/workspace/.felt/research/workspace/calibration-report/report.html"]')
const report = p => reportPage(p).locator('iframe')
async function reportReady(p) {
  if (!(await isSelected(p, 'calibration-report'))) await choose(p, 'calibration-report')
  await report(p).contentFrame().locator('#report-sentinel').waitFor()
  await poll(p, () => { const viewer = document.querySelector('.ws-selected .ws-document-viewer'); return viewer && getComputedStyle(viewer).opacity === '1' })
  return report(p)
}
async function reportDocument(p) { return (await report(p).elementHandle()).contentFrame() }
async function reportY(p) { return (await reportDocument(p)).evaluate(() => document.scrollingElement.scrollTop) }
async function pollReport(p, fn, arg) { await (await reportDocument(p)).waitForFunction(fn, arg, { timeout: 2500, polling: 40 }) }
function innerHeightGap(box, viewport) { return viewport.height - (box.y + box.height) }
async function records(p) { return p.evaluate(() => window.__harness.requests) }

test('Oversized embedded media fit report and constitution text columns', async p => {
  await open(p)
  await reportReady(p)
  const frame = await reportDocument(p)
  await frame.locator('#oversized-report-image').waitFor()
  const reportSize = await frame.evaluate(async () => {
    const img = document.querySelector('#oversized-report-image')
    await img.decode()
    return { width: img.width, height: img.height, natural: img.naturalWidth, column: document.body.clientWidth }
  })
  assert.equal(reportSize.natural, 3000)
  assert.ok(reportSize.width <= reportSize.column)
  assert.ok(Math.abs(reportSize.height / reportSize.width - .2) < .01)
  const authored = await frame.evaluate(() => {
    const img = document.querySelector('#oversized-report-image')
    img.classList.add('authored-media')
    const css = getComputedStyle(img), result = { maxWidth: css.maxWidth, height: css.height }
    img.classList.remove('authored-media')
    return result
  })
  assert.deepEqual(authored, { maxWidth: '42%', height: '123px' }, 'authored cascade layers override reader defaults')
  await choose(p, 'Constitution')
  const image = selected(p).locator('.kbn-detail-prose img')
  await image.waitFor({ state: 'attached' })
  const proseSize = await image.evaluate(async img => {
    await img.decode()
    const parent = img.closest('.kbn-detail-prose')
    const css = getComputedStyle(parent)
    return { width: img.width, height: img.height, column: parent.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight) }
  })
  // img.width rounds to whole pixels; a percentage padding leaves the column fractional.
  assert.ok(proseSize.width <= Math.ceil(proseSize.column), JSON.stringify(proseSize))
  assert.ok(Math.abs(proseSize.height / proseSize.width - .2) < .01)
  await choose(p, 'brief.md')
  const markdownImage = selected(p).locator('.kbn-detail-prose img')
  await markdownImage.waitFor()
  assert.ok(await markdownImage.evaluate(async img => {
    await img.decode()
    const parent = img.closest('.kbn-detail-prose'), css = getComputedStyle(parent)
    return img.width <= Math.ceil(parent.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight)) && Math.abs(img.height / img.width - .2) < .01
  }), 'Markdown deliverables fit their padded text column')
})

test('Fresh Desk leaves focus alone; the first j selects awaiting review and Enter opens first', async p => {
  assert.ok(await p.evaluate(() => document.activeElement !== document.querySelector('.kbn-col-head')), 'load must not focus a column head')
  assert.equal(await p.locator('.kbn-key-selected').count(), 0)
  await p.keyboard.press('j')
  assert.match(await p.locator('.kbn-card.kbn-key-selected').innerText(), /Calibrate the shear response/)
  await p.keyboard.press('Enter')
  await reportReady(p)
  assert.equal(await isSelected(p, 'calibration-report'), true)
  assert.ok(await p.evaluate(() => document.activeElement?.tagName !== 'IFRAME' && !document.activeElement?.closest('.ws-content')), 'keyboard entry must keep app-level focus')
})

for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) test(`Workspace type distinguishes names, verbs and data (${device})`, async p => {
  // Each element is checked against its type role, resolved from type.css.
  const type = async (selector, role, family) => {
    const actual = await p.locator(selector).first().evaluate((el, role) => {
      const style = getComputedStyle(el)
      return { size: style.fontSize, role: style.getPropertyValue(`--type-${role}`).trim(), family: style.fontFamily }
    }, role)
    assert.equal(actual.size, actual.role, `${selector} is set at ${role}`)
    assert.ok(actual.family.includes(family), `${selector}: ${actual.family}`)
  }
  await open(p); await reportReady(p)
  if (device === 'desktop') {
    await type('.ws-selected .ws-label-title', 'label', 'EB Garamond')
    await type('.ws-selected .ws-provenance', 'meta', 'IBM Plex Mono')
  } else {
    await type('.ws-channel-title', 'label', 'EB Garamond')
  }
  await choose(p, 'Constitution')
  await type('.ws-selected .ws-prose-status', 'label', 'EB Garamond')
  if (device === 'desktop') await type('.ws-selected .ws-fiber-prose h1', 'display', 'EB Garamond')
  assert.equal(await selected(p).locator('.kbn-detail-lede').count(), 0, 'the reading page draws no outcome')
  await choose(p, 'Chat')
  await type('.ws-selected .kbn-ctl-send', 'label', 'EB Garamond')
  await chatMenu(p, 'Settings')
  await type('.ws-selected .kbn-ctl-strip', 'meta', 'IBM Plex Mono')
  await choose(p, 'tone.mp3')
  await p.waitForFunction(() => document.querySelector('.ws-selected audio')?.readyState >= 1)
  await type('.ws-selected .ws-audio-play', 'label', 'EB Garamond')
  await type('.ws-selected .ws-audio-clock', 'meta', 'IBM Plex Mono')
  await type('.ws-selected .ws-audio-compare button > span:first-child', 'label', 'EB Garamond')
  await p.keyboard.press('?')
  assert.equal(await p.locator('.kbn-keymap-dialog header button').textContent(), '×')
  await p.keyboard.press('Escape')
  assert.equal(await p.locator('.kbn-keymap-overlay').count(), 0)
}, viewport)

test('Desk action menus preserve row layout and native keyboard focus through Enter and Space', async p => {
  const review = p.locator('[data-column="awaitingReview"] .kbn-card').first()
  await p.mouse.move(0, 0)
  const before = await review.boundingBox()
  const words = await review.innerText()
  await review.hover()
  assert.deepEqual(await review.boundingBox(), before)
  assert.equal(await review.innerText(), words)
  assert.equal(await p.getByRole('menu').count(), 0)
  await review.click({ button: 'right' })
  assert.deepEqual(await p.getByRole('menu').getByRole('menuitem').allTextContents(), ['Rest', 'Temper', 'Discard', 'Move…'])
  await p.keyboard.press('Escape')
  await p.keyboard.press('Escape'); await p.keyboard.press('j')
  assert.ok(await review.evaluate(el => el === document.activeElement && el.classList.contains('kbn-key-selected')))
  for (const key of ['Enter', 'Space']) {
    await review.press('Shift+F10')
    const menu = p.getByRole('menu')
    await menu.waitFor()
    assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['Rest', 'Temper', 'Discard', 'Move…'])
    assert.equal(await menu.getByRole('menuitem').first().evaluate(el => el === document.activeElement), true)
    await p.keyboard.press('ArrowDown')
    assert.equal(await menu.getByRole('menuitem', { name: 'Temper', exact: true }).evaluate(el => el === document.activeElement), true)
    await p.keyboard.press('End')
    assert.equal(await menu.getByRole('menuitem', { name: 'Move…', exact: true }).evaluate(el => el === document.activeElement), true)
    await p.keyboard.press('Escape')
    assert.equal(await p.getByRole('menu').count(), 0)
    assert.equal(await review.evaluate(el => el === document.activeElement), true)
    await review.press('Shift+F10')
    await p.getByRole('menu').getByRole('menuitem', { name: 'Temper', exact: true }).press(key)
    await p.getByRole('menu').waitFor({ state: 'detached' })
    assert.equal(await p.getByRole('button', { name: /Undo verdict on/ }).count(), 1)
    await p.keyboard.press('z')
  }
  await review.press('Shift+F10')
  await p.getByRole('menu').getByRole('menuitem', { name: 'Rest', exact: true }).press('Space')
  await p.locator('.kbn-rest-popover').waitFor()
  await p.keyboard.press('Escape')
}, undefined, undefined, 'reduce')

test('Desk action menus open on a phone long press without hover', async p => {
  await chooseDeskColumn(p, 2)
  const review = p.locator('[data-column="awaitingReview"] .kbn-card').first()
  const touch = await p.context().newCDPSession(p)
  const hold = async row => {
    await row.scrollIntoViewIfNeeded()
    const box = await row.boundingBox()
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] })
    await p.clock.runFor(500)
    await p.getByRole('menu').waitFor()
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  await hold(review)
  const menu = p.getByRole('menu')
  assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['Rest', 'Temper', 'Discard', 'Move…'])
  for (const item of await menu.getByRole('menuitem').all()) {
    const reach = await item.boundingBox()
    assert.ok(reach.height >= 44 && reach.width > 0)
    assert.ok(reach.x >= 0 && reach.x + reach.width <= 390)
    assert.equal(await item.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }), true)
  }
  await p.keyboard.press('Escape')
  await chooseDeskColumn(p, 1)
  const inFlight = p.locator('[data-column="inFlight"] .kbn-card').first()
  await hold(inFlight)
  assert.deepEqual(await p.getByRole('menu').getByRole('menuitem').allTextContents(), ['Close for review', 'Rest', 'Temper', 'Discard', 'Open terminal', 'Move…'])
}, { width: 390, height: 844 }, undefined, 'reduce', true)

test('Desk family action menus preserve native activation and Resting row stacking', async p => {
  const fixture = new URL(url); fixture.searchParams.set('example', 'threads'); await p.goto(fixture.href)
  const family = p.locator('.kbn-desk .kbn-card').filter({ hasText: name })
  await family.waitFor()
  await p.keyboard.press('j'); await p.keyboard.press('h'); await p.keyboard.press('Home')
  for (let row = 0; row < 10 && !await family.evaluate(el => el.classList.contains('kbn-key-selected')); row++) await p.keyboard.press('j')
  assert.ok(await family.evaluate(el => el === document.activeElement && el.classList.contains('kbn-key-selected')))
  for (const key of ['Enter', 'Space']) {
    await family.focus(); await family.press('Shift+F10'); await p.getByRole('menu').waitFor()
    assert.deepEqual(await p.getByRole('menu').getByRole('menuitem').allTextContents(), ['Close for review', 'Rest', 'Temper', 'Discard', 'Move…'])
    await p.keyboard.press('Escape'); assert.ok(await family.evaluate(el => el === document.activeElement))
    await family.press('Shift+F10')
    await p.getByRole('menu').getByRole('menuitem', { name: 'Temper', exact: true }).press(key)
    await p.getByRole('menu').waitFor({ state: 'detached' })
    await p.keyboard.press('z')
  }
  await p.evaluate(async () => {
    for (const row of window.__harness.MOCK_FEED.fibers) if (row.fiber.id.startsWith('research/workspace/calibration-report')) {
      row.fiber.status = 'open'; row.fiber.horizon = 'stashed'; row.runtime = null
      delete row.fiber.shuttle.ask
    }
    await window.__harness.modal.fetchAndRender()
  })
  const resting = p.locator('.kbn-cluster-item').filter({ hasText: name })
  const geometry = await resting.evaluate(row => {
    const title = row.querySelector('.kbn-cluster-item-title').getBoundingClientRect()
    const rect = row.getBoundingClientRect()
    return { titleInside: title.left >= rect.left && title.right <= rect.right, rowHasMenuTarget: row.getAttribute('aria-haspopup') === 'menu' }
  })
  assert.deepEqual(geometry, { titleInside: true, rowHasMenuTarget: true })
  await resting.click({ button: 'right' })
  assert.deepEqual(await p.getByRole('menu').getByRole('menuitem').allTextContents(), ['Rest', 'Temper', 'Discard', 'Move…'])
})

test('Pointer, stepping, HTML scrolling, persistent iframe, expansion and resize', async p => {
  await open(p)
  const iframe = await reportReady(p)
  await mkdir(shots, { recursive: true })
  await p.screenshot({ path: resolve(shots, 'sandbox-report-desktop.png') })
  await iframe.evaluate(f => { window.__reportFrame = f; window.__reportWindow = f.contentWindow })
  const inner = await reportDocument(p)
  const identity = await inner.evaluate(() => { window.__sentinel = 'kept'; return document.querySelector('#report-identity').textContent })
  await choose(p, 'brief.md')
  await appFocus(p); await p.keyboard.press('Escape')
  assert.equal(await isSelected(p, 'calibration-report'), true)
  await choose(p, 'brief.md')
  await choose(p, 'calibration-report')
  await inner.evaluate(() => {
    const querySelectorAll = document.querySelectorAll.bind(document)
    window.__workspaceBodyWalks = 0
    document.querySelectorAll = selector => {
      if (selector === 'body *') window.__workspaceBodyWalks++
      return querySelectorAll(selector)
    }
  })
  for (const [down, up] of [['ArrowDown', 'ArrowUp'], ['d', 'u'], ['Space', 'Shift+Space']]) {
    await inner.evaluate(() => window.scrollTo(0, 0))
    await p.keyboard.press(down)
    await pollReport(p, () => document.scrollingElement.scrollTop > 0)
    const before = await reportY(p)
    await p.keyboard.press(up)
    await pollReport(p, before => document.scrollingElement.scrollTop < before, before)
  }
  await p.keyboard.down('ArrowDown')
  await p.keyboard.press('ArrowDown')
  await p.keyboard.up('ArrowDown')
  assert.ok(await reportY(p) > 0, 'held arrow scrolling repeats')
  assert.ok(await inner.evaluate(() => window.__workspaceBodyWalks) <= 1, 'report scroller is cached')
  const readingY = await reportY(p)
  await choose(p, 'brief.md'); await choose(p, 'calibration-report')
  assert.equal(await reportY(p), readingY, 'reading position survives tab selection')
  await choose(p, 'brief.md')
  await selected(p).locator('.ws-labelbar').dblclick()
  assert.ok(await p.locator('.ws-page.ws-expanded').count())
  await p.locator('.ws-page.ws-expanded .ws-labelbar').dblclick()
  assert.equal(await p.locator('.ws-page.ws-expanded').count(), 0)
  await choose(p, 'brief.md')
  // One frame: the page fills the stage, and no corner toggle lands on the header line's contents.
  const frame = await selected(p).evaluate(el => {
    const box = r => { const b = r.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom } }
    const stage = box(el.closest('.ws-stage')), page = box(el)
    const parts = [...el.querySelectorAll('.ws-labelbar > :not([hidden])')].map(box).filter(b => b.r > b.l)
    const toggles = [...document.querySelectorAll('.ws-reader > .ws-sidebar-toggle')].filter(t => getComputedStyle(t).display !== 'none').map(box)
    const overlaps = toggles.flatMap(t => parts.filter(b => b.l < t.r && t.l < b.r && b.t < t.b && t.t < b.b))
    return { fills: Math.abs(page.l - stage.l) < 1 && Math.abs(page.r - stage.r) < 1, overlaps: overlaps.length }
  })
  assert.ok(frame.fills, 'the selected page fills the stage')
  assert.equal(frame.overlaps, 0, 'corner toggles keep their own places in the header line')
  await choose(p, 'calibration-report')
  await p.setViewportSize({ width: 1250, height: 760 })
  assert.ok(await iframe.evaluate(f => f === window.__reportFrame && f.contentWindow === window.__reportWindow), 'browser resize must retain the iframe')
  assert.equal(await inner.evaluate(() => window.__sentinel), 'kept')
  await leave(p)
  await open(p)
  assert.ok(await iframe.evaluate(f => f === window.__reportFrame && f.contentWindow === window.__reportWindow))
  assert.equal(await inner.evaluate(() => document.querySelector('#report-identity').textContent), identity)
  assert.equal(await reportY(p), readingY)
})

test('Hostile report keys cannot queue verdicts or open controls; trusted and posted navigation still work', async p => {
  await open(p); await reportReady(p)
  const inner = await reportDocument(p)
  const key = await selected(p).getAttribute('data-key')
  const before = (await records(p)).filter(r => r.method === 'POST').length
  await inner.evaluate(() => {
    for (const key of ['x', 't', 'z', '.', 'c', 'r', 'p', ',', '>', 'Enter', 'o']) {
      parent.postMessage({ protocol: 'shuttle-document', version: 1, type: 'key', payload: { key } }, '*')
    }
  })
  await p.waitForTimeout(150)
  assert.equal(await p.locator('.ws-verdict-undo').count(), 0)
  assert.equal(await selected(p).getAttribute('data-key'), key)
  assert.equal(await p.locator('.ws-expanded').count(), 0)
  assert.equal((await records(p)).filter(r => r.method === 'POST').length, before)
  assert.equal(await p.evaluate(() => window.__harness.events.filter(e => e.type === 'open-worker').length), 0)
  await inner.evaluate(() => {
    document.body.tabIndex = -1; document.body.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true }))
  })
  await p.waitForTimeout(100)
  assert.equal(await selected(p).getAttribute('data-key'), key, 'untrusted report key events are ignored')
  await p.keyboard.press('ArrowDown')
  await pollReport(p, () => document.scrollingElement.scrollTop > 0)
  await p.keyboard.press('Escape')
  assert.notEqual(await selected(p).getAttribute('data-key'), key)
  await choose(p, 'calibration-report')
  await inner.evaluate(() => parent.postMessage({ protocol: 'shuttle-document', version: 1, type: 'key', payload: { key: 'Escape' } }, '*'))
  await poll(p, key => document.querySelector('.ws-selected')?.dataset.key !== key, key)
})

test('Report reference batches are size-capped and limited to four responses a second', async p => {
  await open(p); await reportReady(p)
  const inner = await reportDocument(p)
  // Keep ordinary scanner decoration out of the malicious sender's rate budget.
  await inner.evaluate(() => document.querySelectorAll('code,a[href]').forEach(element => element.remove()))
  // The parent defers an over-budget batch until its window reopens, so the
  // scanner's last batch can hold a slot for up to two windows.
  await p.waitForTimeout(2100)
  await inner.evaluate(() => {
    window.__referenceResponses = 0
    window.addEventListener('message', event => { if (event.data?.type === 'references:resolved') window.__referenceResponses++ })
    for (let i = 0; i < 20; i++) parent.postMessage({ protocol: 'shuttle-document', version: 1, type: 'references', payload: { candidates: ['brief.md'] } }, '*')
  })
  await p.waitForTimeout(100)
  assert.equal(await inner.evaluate(() => window.__referenceResponses), 4)
  await p.waitForTimeout(1100)
  await inner.evaluate(() => {
    window.__referenceResponses = 0
    for (const candidates of [Array(501).fill('brief.md'), ['a'.repeat(257)]]) parent.postMessage({ protocol: 'shuttle-document', version: 1, type: 'references', payload: { candidates } }, '*')
  })
  await p.waitForTimeout(100)
  assert.equal(await inner.evaluate(() => window.__referenceResponses), 0)
})

test('Channel references select from HTML, markdown, plain text and the fiber with coherent history', async p => {
  await open(p); await reportReady(p)
  const key = await selected(p).getAttribute('data-key')
  const inner = await reportDocument(p)
  await inner.locator('a.ws-channel-reference').filter({ hasText: 'brief.md' }).waitFor()
  await inner.evaluate(() => {
    parent.postMessage({ protocol: 'shuttle-document', version: 1, type: 'select', payload: { candidate: 'unresolved.html' } }, '*')
    parent.postMessage({ protocol: 'shuttle-document', version: 1, type: 'select', payload: { candidate: 'umber-workstation:/fixture-store/workspace/deliverables/brief.md' } }, '*')
  })
  await p.waitForTimeout(150)
  assert.equal(await selected(p).getAttribute('data-key'), key, 'unresolved strings and document keys cannot select')
  await inner.getByRole('link', { name: 'the field note', exact: true }).click()
  await poll(p, () => document.querySelector('.ws-selected .ws-label-title')?.textContent === 'Field note')
  assert.ok(await selected(p).locator('.ws-label-title').innerText() === 'Field note')
  await selected(p).getByRole('link', { name: 'the report', exact: true }).click()
  await reportReady(p)
  assert.equal(await selected(p).getAttribute('data-key'), key)
  await p.goBack()
  await poll(p, () => document.querySelector('.ws-reader')?.classList.contains('ws-dormant'))
  await open(p)
  await choose(p, 'readme.txt')
  await selected(p).getByRole('link', { name: 'tone.mp3', exact: true }).click()
  assert.equal(await isSelected(p, 'tone.mp3'), true)
  await choose(p, 'Constitution')
  await selected(p).getByRole('link', { name: 'brief.md', exact: true }).click()
  assert.equal(await isSelected(p, 'brief.md'), true)
})

for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) test(`Inline channel audio plays and pauses in HTML and markdown without selecting (${device})`, async p => {
  await open(p); await reportReady(p)
  const inner = await reportDocument(p)
  const initial = await selected(p).getAttribute('data-key')
  const play = inner.getByRole('button', { name: 'Play tone.mp3', exact: true })
  const audio = p.locator('.ws-page[data-key="umber-workstation:/fixture-store/workspace/deliverables/tone.mp3"] audio')
  assert.equal(await inner.locator('button[aria-pressed="true"]').count(), 0, 'references never autoplay')
  if (device === 'desktop') { await play.focus(); await p.keyboard.press('Enter') }
  // Chromium offsets synthesized touch clicks inside opaque frames by the frame's top.
  // Exercise report activation here; the markdown controls below retain real phone taps.
  else await play.click()
  await poll(p, () => { const audio = document.querySelector('.ws-page[data-key$="/tone.mp3"] audio'); return audio && !audio.paused && audio.currentTime > 0 })
  assert.equal(await selected(p).getAttribute('data-key'), initial)
  await inner.getByRole('button', { name: 'Pause tone.mp3', exact: true }).waitFor()
  await inner.waitForFunction(() => parseFloat(document.querySelector('.ws-reference-play').style.getPropertyValue('--ws-reference-progress')) > 0)
  await audio.evaluate(audio => { window.__inlineAudio = audio })
  await mkdir(shots, { recursive: true }); await p.screenshot({ path: resolve(shots, `links-${device}-inline-playing.png`) })
  await inner.getByRole('button', { name: 'Play tone.wav', exact: true }).click()
  await poll(p, () => document.querySelector('.ws-page[data-key$="/tone.mp3"] audio').paused && !document.querySelector('.ws-page[data-key$="/tone.wav"] audio').paused)
  await inner.getByRole('button', { name: 'Pause tone.wav', exact: true }).click()
  await poll(p, () => document.querySelector('.ws-page[data-key$="/tone.wav"] audio').paused)
  assert.equal(await selected(p).getAttribute('data-key'), initial)
  await choose(p, 'brief.md')
  const markdownPlay = selected(p).getByRole('button', { name: 'Play tone.mp3', exact: true })
  if (device === 'phone') await markdownPlay.tap()
  else await markdownPlay.click()
  await poll(p, () => !document.querySelector('.ws-page[data-key$="/tone.mp3"] audio').paused)
  assert.equal(await isSelected(p, 'brief.md'), true)
  const markdownPause = selected(p).getByRole('button', { name: 'Pause tone.mp3', exact: true })
  if (device === 'phone') await markdownPause.tap()
  else await markdownPause.click()
  await poll(p, () => document.querySelector('.ws-page[data-key$="/tone.mp3"] audio').paused)
  await selected(p).getByRole('button', { name: 'Play tone.mp3', exact: true }).click()
  await choose(p, 'tone.mp3')
  assert.ok(await audio.evaluate(audio => audio === window.__inlineAudio && audio.paused), 'selection uses the same audio page element and pauses inline playback')
  await choose(p, 'calibration-report')
  await inner.getByRole('button', { name: 'Play tone.mp3', exact: true }).click()
  await leave(p)
  await poll(p, () => document.querySelector('.ws-page[data-key$="/tone.mp3"] audio').paused)
}, viewport)

test('Ambiguous code basenames stay unlinked while an explicit path still selects', async p => {
  await open(p); await reportReady(p)
  await p.evaluate(() => {
    const original = window.fetch
    window.fetch = async (...args) => {
      const response = await original(...args)
      if (!String(args[0]).includes('/api/v1/sent-files?')) return response
      const data = await response.json()
      data.files.push({ ...data.files.find(file => file.basename === 'tone.mp3'), fullPath: '/other/tone.mp3' })
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
    }
  })
  await leave(p)
  await open(p); await reportReady(p)
  const inner = await reportDocument(p)
  await inner.waitForFunction(() => ![...document.querySelectorAll('a.ws-channel-reference')].some(link => link.textContent === 'tone.mp3'))
  const ambiguous = inner.locator('code').filter({ hasText: /^tone\.mp3$/ })
  assert.equal(await ambiguous.evaluate(code => code.parentElement.tagName), 'P')
  await inner.evaluate(() => {
    const code = document.createElement('code'); code.textContent = '/fixture-store/workspace/deliverables/tone.mp3'; document.body.prepend(code)
  })
  await inner.getByRole('link', { name: '/fixture-store/workspace/deliverables/tone.mp3', exact: true }).click()
  await poll(p, () => document.querySelector('.ws-selected')?.dataset.key === 'umber-workstation:/fixture-store/workspace/deliverables/tone.mp3')
})

test('Opaque report denies parent DOM and same-origin API reads; links open outside the frame', async p => {
  const requests = []
  const html = await readFile(resolve('harness-board-dist/index.html'))
  const server = createServer(async (req, res) => {
    const rawPath = new URL(req.url, 'http://file.test').searchParams.get('path')
    if ((req.url.startsWith('/api/v1/file-assets/') && req.url.endsWith('/opaque-popup.html')) || (req.url.startsWith('/api/v1/file?') && rawPath?.endsWith('.html'))) {
      res.setHeader('Content-Type', 'text/html')
      if (!process.env.WORKSPACE_UNSAFE_FILES) res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-forms')
      res.end('<!doctype html><html><body>Hostile file probe<script>(async()=>{let storageDenied=false,apiDenied=false;try{window.sentinel=localStorage.getItem("opaque-board-sentinel")}catch{storageDenied=true}try{await fetch("' + base + '/api/v1/version")}catch{apiDenied=true}window.__access={storageDenied,apiDenied,sentinel:window.sentinel??null}})()</script></body></html>')
    } else if (req.url.startsWith('/api/v1/file-assets/') && /opaque-probe\.(css|js|svg)$/.test(req.url)) {
      const ext = req.url.split('.').at(-1)
      res.setHeader('Content-Type', { css: 'text/css', js: 'application/javascript', svg: 'image/svg+xml' }[ext])
      res.end({ css: 'body { --opaque-asset: loaded; }', js: 'window.__opaqueAsset = true', svg: '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>' }[ext])
    } else if (req.url.startsWith('/api/v1/')) {
      requests.push({ url: req.url, origin: req.headers.origin })
      res.setHeader('Content-Type', 'application/json')
      res.end('{"private":true}')
    } else if (['/harness-board.js', '/shuttle-ui.css'].includes(req.url)) {
      res.setHeader('Content-Type', req.url.endsWith('.js') ? 'application/javascript' : 'text/css')
      res.end(await readFile(resolve('harness-board-dist' + req.url)))
    } else { res.setHeader('Content-Type', 'text/html'); res.end(html) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    await p.goto(base + '/?example=workspace')
    await open(p); const iframe = await reportReady(p)
    assert.equal(await iframe.getAttribute('sandbox'), 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-forms')
    assert.equal(await iframe.evaluate(f => f.contentDocument), null, 'parent cannot access opaque frame DOM')
    const inner = await reportDocument(p)
    const access = await inner.evaluate(async base => {
      let parentDenied = false, apiDenied = false
      try { void parent.document.body } catch { parentDenied = true }
      try { await fetch(base + '/api/v1/version') } catch { apiDenied = true }
      return { parentDenied, apiDenied }
    }, base)
    assert.deepEqual(access, { parentDenied: true, apiDenied: true })
    assert.ok(requests.some(request => request.url === '/api/v1/version' && request.origin === 'null'), 'opaque fetch sends Origin: null, never parent origin')
    const assets = await inner.evaluate(async () => {
      const load = element => new Promise((resolve, reject) => { element.onload = resolve; element.onerror = reject; document.head.append(element) })
      const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'opaque-probe.css'
      const script = document.createElement('script'); script.src = 'opaque-probe.js'
      const image = document.createElement('img'); image.src = 'opaque-probe.svg'
      await Promise.all([load(css), load(script), load(image)])
      return { css: getComputedStyle(document.body).getPropertyValue('--opaque-asset').trim(), script: window.__opaqueAsset, image: image.naturalWidth, url: script.src }
    })
    assert.equal(assets.css, 'loaded')
    assert.equal(assets.script, true)
    assert.equal(assets.image, 8)
    assert.match(assets.url, /\/api\/v1\/file-assets\/umber-workstation\/.*\/opaque-probe.js$/, 'relative assets retain the owning host')
    const link = await inner.evaluate(() => {
      const link = document.createElement('a'); link.href = 'https://example.com/paper'; link.textContent = 'External paper'
      document.body.prepend(link)
      link.addEventListener('click', event => event.preventDefault())
      link.click()
      return { target: link.target, rel: link.rel }
    })
    assert.deepEqual(link, { target: '_blank', rel: 'noopener noreferrer' })
    const local = await inner.evaluate(() => {
      localStorage.setItem('plot-theme', 'dark')
      sessionStorage.setItem('slide', '1')
      history.replaceState({ slide: 1 }, '', document.baseURI + '#/slide-1')
      return { theme: localStorage.getItem('plot-theme'), slide: sessionStorage.getItem('slide'), state: history.state }
    })
    assert.deepEqual(local, { theme: 'dark', slide: '1', state: { slide: 1 } })
    const key = await selected(p).getAttribute('data-key')
    await inner.evaluate(() => {
      document.addEventListener('keydown', event => {
        if (event.key !== 'ArrowRight') return
        // Deck navigation must reach preventDefault even with an opaque URL.
        history.replaceState({ slide: 2 }, '', document.baseURI + '#/slide-2')
        sessionStorage.setItem('slide', '2')
        event.preventDefault()
      })
      document.body.tabIndex = -1
    })
    // A real click activates the opaque document; DOM focus alone need not
    // make it Chrome's keyboard target.
    await inner.locator('#report-sentinel').click()
    await inner.locator('body').press('ArrowRight')
    await inner.waitForFunction(() => sessionStorage.getItem('slide') === '2', undefined, { polling: 40 })
    assert.equal(await inner.evaluate(() => sessionStorage.getItem('slide')), '2')
    assert.equal(await selected(p).getAttribute('data-key'), key, 'deck-owned arrows never step workspace documents')
    assert.equal(await p.evaluate(() => localStorage.getItem('plot-theme')), null, 'report preferences cannot leak to board storage')
    await p.evaluate(() => localStorage.setItem('opaque-board-sentinel', 'private-board-state'))
    await inner.evaluate(() => {
      const link = document.createElement('a'); link.href = new URL('opaque-popup.html', document.baseURI).href; link.textContent = 'Sibling hostile HTML'; document.body.prepend(link)
    })
    const checkPopup = async (click, expectedURL) => {
      const opened = p.context().waitForEvent('page')
      await click()
      const popup = await opened
      try {
        // The page event can precede navigation, and noopener popups need not
        // paint. Wait for the intended document, then poll its network result
        // without depending on animation frames.
        await popup.waitForURL(expectedURL, { waitUntil: 'domcontentloaded' })
        await popup.waitForFunction(() => window.__access, undefined, { polling: 40 })
        const access = await popup.evaluate(() => window.__access)
        assert.deepEqual(access, { storageDenied: true, apiDenied: true, sentinel: null }, 'raw HTML popups cannot regain the board origin')
        return access
      } finally { await popup.close() }
    }
    const siblingURL = await inner.getByRole('link', { name: 'Sibling hostile HTML', exact: true }).evaluate(link => link.href)
    const siblingPopup = await checkPopup(() => inner.getByRole('link', { name: 'Sibling hostile HTML', exact: true }).click(), siblingURL)
    await selected(p).getByRole('button', { name: 'Document menu', exact: true }).click()
    const rawFile = p.getByRole('link', { name: 'Open in new tab', exact: true })
    const rawFilePopup = await checkPopup(() => rawFile.click(), await rawFile.evaluate(link => link.href))
    await mkdir(shots, { recursive: true })
    await writeFile(resolve(shots, 'security-probes.json'), JSON.stringify({ iframe: access, relativeAssets: assets, siblingPopup, rawFilePopup, requests }, null, 2))
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('Embedded HTML media pauses on recede and park without reloading or auto-resuming', async p => {
  await open(p); await reportReady(p)
  const inner = await reportDocument(p)
  const audio = `data:audio/wav;base64,${(await readFile(resolve('harness/fixtures/sine.wav'))).toString('base64')}`
  await inner.evaluate(async src => {
    const media = document.createElement('audio'); media.id = 'embedded-audio'; media.controls = true; media.src = src
    document.body.prepend(media); window.__mediaIdentity = media
    await media.play()
  }, audio)
  await pollReport(p, () => !document.querySelector('audio').paused && document.querySelector('audio').currentTime > 0)
  await choose(p, 'brief.md')
  await pollReport(p, () => document.querySelector('audio').paused)
  const position = await inner.evaluate(() => document.querySelector('audio').currentTime)
  await choose(p, 'calibration-report')
  assert.ok(await inner.evaluate(position => document.querySelector('audio') === window.__mediaIdentity && document.querySelector('audio').paused && document.querySelector('audio').currentTime === position, position))
  await inner.evaluate(() => document.querySelector('audio').play())
  await leave(p)
  await pollReport(p, () => document.querySelector('audio').paused)
  await open(p)
  assert.ok(await inner.evaluate(() => document.querySelector('audio') === window.__mediaIdentity && document.querySelector('audio').paused))
})

test('Late nested report layout retains its restore and then accepts reader scrolling', async p => {
  // The bridge clamps an unsatisfied restore after 3 s. Model layout arriving
  // before that deadline explicitly, independently of CPU scheduling.
  await p.clock.pauseAt(new Date('2026-10-04T14:00:30Z'))
  await open(p); await reportReady(p)
  await report(p).evaluate(frame => new Promise(resolve => {
    const bridge = new DOMParser().parseFromString(frame.srcdoc, 'text/html').querySelector('[data-shuttle-workspace-bridge]').outerHTML
    frame.addEventListener('load', resolve, { once: true })
    frame.srcdoc = `<!doctype html><html><head>${bridge}</head><body>
      <p id="early">Short initial layout</p>
      <script>
        window.addEventListener('message', event => {
          if (event.source === parent && event.data?.protocol === 'shuttle-document' && event.data.type === 'active') {
            window.__active = event.data.payload.active
          }
        })
        window.addEventListener('load', () => setTimeout(() => window.__shortReady = true, 0))
      </script>
    </body></html>`
  }))
  const inner = await reportDocument(p)
  await p.clock.runFor(1)
  await inner.waitForFunction(() => window.__shortReady, undefined, { polling: 40 })
  const command = async (type, payload) => report(p).evaluate((frame, data) => frame.contentWindow.postMessage(data, '*'), { protocol: 'shuttle-document', version: 1, type, payload })
  await command('restore', { x: 0, y: 160 })
  await command('active', { active: false })
  await inner.waitForFunction(() => window.__active === false, undefined, { polling: 40 })
  const saved = () => p.evaluate(() => JSON.parse(sessionStorage.getItem('shuttle:workspace:scroll:' + document.querySelector('.ws-selected').dataset.key))?.y)
  await p.waitForFunction(() => JSON.parse(sessionStorage.getItem('shuttle:workspace:scroll:' + document.querySelector('.ws-selected').dataset.key))?.y === 160, undefined, { polling: 40 })
  await p.clock.runFor(1000)
  assert.equal(await inner.evaluate(() => document.scrollingElement.scrollTop), 0, 'short layout cannot yet hold the restore')
  assert.equal(await saved(), 160, 'pending restore is not overwritten by a clamped zero')
  await inner.evaluate(() => {
    document.querySelector('#early').remove()
    const main = document.createElement('main'); main.id = 'late'; main.tabIndex = 0; main.style.cssText = 'height:280px;overflow:auto;line-height:20px'
    main.innerHTML = '<div style="height:6000px">Late asynchronous report content</div>'
    document.body.append(main)
  })
  await inner.waitForFunction(() => document.querySelector('#late').scrollTop === 160, undefined, { polling: 40 })
  await command('active', { active: true })
  // postMessage returns before the bridge processes activation. The fixture's
  // listener runs after the bridge's listener, acknowledging delivery.
  await inner.waitForFunction(() => window.__active === true, undefined, { polling: 40 })
  const scroller = inner.locator('#late')
  await scroller.click()
  await inner.waitForFunction(() => document.hasFocus(), undefined, { polling: 40 })
  await scroller.press('ArrowDown')
  // Reader ArrowDown advances three 20 px lines; native scrolling alone is
  // not enough to satisfy this assertion.
  await inner.waitForFunction(() => document.querySelector('#late').scrollTop === 220, undefined, { polling: 40 })
  await p.waitForFunction(() => JSON.parse(sessionStorage.getItem('shuttle:workspace:scroll:' + document.querySelector('.ws-selected').dataset.key))?.y === 220, undefined, { polling: 40 })
  assert.equal(await saved(), 220)
})

test('Desk-opened channel reload and Back restore its Desk origin in the bar', async p => {
  const deskOrigin = () => poll(p, () => document.querySelector('.kbn-reader-open') && document.querySelector('.kbn-viewtabs .kbn-viewtab-active')?.dataset.view === 'desk')
  await open(p); await reportReady(p)
  await choose(p, 'brief.md')
  await p.reload()
  await pageFor(p, 'brief.md').waitFor()
  await deskOrigin()
  assert.ok(await p.locator('.kbn-modal').count(), 'Desk stays behind the reader')
  await appFocus(p)
  await p.keyboard.press('j')
  await poll(p, () => document.querySelector('.ws-channel-title')?.textContent !== 'Calibrate the shear response')
  await p.goBack()
  await poll(p, () => document.querySelector('.ws-channel-title')?.textContent === 'Calibrate the shear response')
  await deskOrigin()
  await leave(p)
  await poll(p, () => document.querySelectorAll('.ws-page.ws-selected').length === 0)
  await p.locator('.ws-page.ws-selected:visible').waitFor({ state: 'hidden' })
  assert.equal(await activeBarView(p), 'desk', 'the origin tab closes the reader back to the Desk')
})

// The bar stands in one place on every view: its tabs, Find and Settings
// never move between the Desk, the reader, the Board and the Chronicle.
test('The board bar holds its tabs, Find and Settings to the pixel on every view and over the reader', async p => {
  const bar = () => p.evaluate(() => {
    const box = el => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(v => +v.toFixed(2)) }
    return { tabs: [...document.querySelectorAll('.kbn-viewtabs .kbn-viewtab')].map(box), find: box(document.querySelector('.kbn-viewtabs-find')),
      gear: box(document.querySelector('.kbn-viewtabs-settings')) }
  })
  const desk = await bar()
  assert.equal(desk.tabs.length, 3)
  await open(p); await reportReady(p)
  await p.waitForTimeout(350)
  assert.deepEqual(await bar(), desk, 'over the reader')
  await leave(p)
  await barTab(p, 'shelf').click()
  await p.locator('.ws-overview-folio').first().waitFor()
  await p.waitForTimeout(350)
  assert.deepEqual(await bar(), desk, 'on the Board')
  await barTab(p, 'chronicle').click()
  await p.locator('.chr-name').first().waitFor()
  await p.waitForTimeout(350)
  assert.deepEqual(await bar(), desk, 'on the Chronicle')
})

// While the reader is open the bar marks the view it came from: that tab (or
// its key) closes the reader back to it; another tab switches and closes.
const origins = {
  desk: { other: 'chronicle', open: async p => { await barTab(p, 'desk').click(); await p.locator('.kbn-desk .kbn-card').filter({ hasText: name }).click() } },
  shelf: { other: 'desk', open: async p => { await barTab(p, 'shelf').click(); await p.locator('.ws-overview-folio').filter({ hasText: name }).click() } },
  chronicle: { other: 'shelf', open: async p => { await barTab(p, 'chronicle').click(); await p.locator('.chr-name').filter({ hasText: name }).click() } },
}
for (const origin of ['desk', 'chronicle']) test(`Rest popover is above the reader opened from ${origin}`, async p => {
  await origins[origin].open(p)
  await choose(p, 'Constitution')
  await choose(p, 'Chat')
  await appFocus(p)
  await p.keyboard.press('s')
  const panel = p.locator('.kbn-rest-popover')
  await panel.waitFor()
  assert.equal(await panel.getAttribute('aria-modal'), 'true', 'Rest is a modal over the reader')
  assert.equal(await panel.evaluate(el => {
    const rect = el.getBoundingClientRect()
    return el.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))
  }), true, 'Rest is visible and receives pointer input above the reader')
  assert.equal(await panel.evaluate(el => el.contains(document.activeElement)), true, 'Rest leaves focus in its confirmation dialog')
  await p.keyboard.press('Enter')
  await panel.waitFor({ state: 'detached' })
})

for (const [origin, { other, open: openFrom }] of Object.entries(origins)) test(`The bar marks the reader's origin (${origin}): its tab and key close back to it, another tab switches and closes`, async p => {
  const state = () => p.evaluate(() => ({ open: !!document.querySelector('.kbn-reader-open'), view: document.querySelector('.kbn-viewtabs .kbn-viewtab-active')?.dataset.view,
    selected: [...document.querySelectorAll('.kbn-viewtabs .kbn-viewtab[aria-selected="true"]')].map(t => t.dataset.view) }))
  const opened = async () => {
    await openFrom(p)
    await selected(p).waitFor()
    await poll(p, () => !!document.querySelector('.kbn-reader-open'))
    assert.deepEqual(await state(), { open: true, view: origin, selected: [origin] }, `the bar marks ${origin} as the origin`)
    assert.match(await barTab(p, origin).getAttribute('aria-label') ?? '', /^Close reader, back to (Desk|Board|Chronicle)$/, 'the origin tab says it closes the reader')
    assert.deepEqual(await p.locator('.kbn-viewtabs [role="tablist"]').first().evaluate(list => [...list.children].map(el => el.getAttribute('role'))), ['tab', 'tab', 'tab'], 'the bar\'s tablist holds its tabs alone')
  }
  await opened()
  await barTab(p, origin).click()
  await poll(p, () => !document.querySelector('.kbn-reader-open'))
  assert.deepEqual(await state(), { open: false, view: origin, selected: [origin] }, 'the origin tab closes the reader back to its view')
  assert.equal(await barTab(p, origin).getAttribute('aria-label'), null, 'with the reader closed the tab is plainly its view')
  await opened()
  const key = (await barTab(p, origin).locator('.kbn-viewtab-hotkey').textContent()).trim()
  await appFocus(p); await p.keyboard.press(key)
  await poll(p, () => !document.querySelector('.kbn-reader-open'))
  assert.deepEqual(await state(), { open: false, view: origin, selected: [origin] }, `the origin's key ${key} closes the reader back to its view`)
  await opened()
  await barTab(p, other).click()
  await poll(p, () => !document.querySelector('.kbn-reader-open'))
  assert.deepEqual(await state(), { open: false, view: other, selected: [other] }, `another tab (${other}) switches view and closes the reader`)
  await p.locator('.ws-page.ws-selected:visible').waitFor({ state: 'hidden' })
})

test('The sidebar edge resizes the column by drag and keys, persists per viewer, and resets on double-click', async p => {
  await open(p); await reportReady(p)
  const edge = p.getByRole('separator', { name: 'Resize constitutions' })
  const width = () => p.evaluate(() => {
    const sidebar = document.querySelector('.ws-sidebar').getBoundingClientRect(), page = document.querySelector('.ws-page.ws-selected').getBoundingClientRect()
    return { sidebar: Math.round(sidebar.width), gutter: Math.round(page.left - sidebar.right), now: Number(document.querySelector('.ws-sidebar-handle').getAttribute('aria-valuenow')) }
  })
  const start = await width()
  assert.equal(start.sidebar, 384, 'the column opens at its default width')
  assert.equal(start.now, 384)
  assert.equal(await edge.getAttribute('aria-valuemin'), '320')
  assert.equal(await edge.getAttribute('aria-valuemax'), String(Math.floor(1440 * 0.4)))
  // A drag reflows the stage live and keeps the page against the column.
  const box = await edge.boundingBox()
  await p.mouse.move(box.x + box.width / 2, 400); await p.mouse.down()
  await p.mouse.move(box.x + 80, 400, { steps: 4 })
  const live = await width()
  assert.ok(live.sidebar > start.sidebar + 60 && Math.abs(live.gutter) <= 1, `the stage follows the drag: ${JSON.stringify(live)}`)
  await p.mouse.move(box.x + 2000, 400, { steps: 4 })
  await p.mouse.up()
  assert.equal((await width()).sidebar, Math.floor(1440 * 0.4), 'the drag stops at its share of the viewport')
  assert.equal(await p.evaluate(() => localStorage.getItem('shuttle:workspace:sidebar-width')), String(Math.floor(1440 * 0.4)))
  // Keys step it, held to its floor.
  await edge.focus()
  await p.keyboard.press('Home')
  assert.equal((await width()).sidebar, 320)
  await p.keyboard.press('ArrowRight')
  assert.equal((await width()).sidebar, 336, 'an arrow steps 16 px and does not step pages')
  assert.equal(await isSelected(p, 'calibration-report'), true)
  await p.reload()
  await reportReady(p)
  assert.equal((await width()).sidebar, 336, 'the width survives a reload')
  await edge.dblclick()
  assert.equal((await width()).sidebar, 384, 'double-click resets the default')
  assert.equal(await p.evaluate(() => localStorage.getItem('shuttle:workspace:sidebar-width')), null)
}, undefined, 'true')

for (const width of [1000, 1440, 1920]) test(`Beside the sidebar the page fills the stage (${width})`, async p => {
  await open(p); await reportReady(p)
  const geometry = async () => p.evaluate(() => {
    const rect = el => el.getBoundingClientRect()
    const page = rect(document.querySelector('.ws-page.ws-selected')), sidebar = rect(document.querySelector('.ws-sidebar'))
    const stage = rect(document.querySelector('.ws-stage'))
    return { gutter: page.left - sidebar.right, right: stage.right - page.right,
      ground: getComputedStyle(document.querySelector('.ws-sidebar')).backgroundColor }
  })
  for (const label of ['calibration-report', 'Constitution', 'remote-summary.pdf']) {
    await choose(p, label)
    await p.waitForTimeout(350)
    const at = await geometry()
    // One frame: the page meets the column and runs to the stage's far edge.
    assert.ok(Math.abs(at.gutter) <= 1, `${label}: the page meets the sidebar: ${JSON.stringify(at)}`)
    assert.ok(Math.abs(at.right) <= 1, `${label}: the page reaches the stage's far edge: ${JSON.stringify(at)}`)
    assert.notEqual(at.ground, 'rgba(0, 0, 0, 0)', 'the sidebar column has its own ground')
  }
}, { width, height: 900 }, 'true')

for (const reducedMotion of ['reduce', 'no-preference']) test(`Receipt arrivals update the sent list and move only their folio (${reducedMotion})`, async p => {
  await open(p); await reportReady(p)
  await report(p).evaluate(f => { window.__arrivalReport = f.contentWindow })
  await p.evaluate(() => {
    window.__receiptAnimations = []
    const animate = Element.prototype.animate
    Element.prototype.animate = function(frames, options) {
      if (this.matches('.ws-overview-folio')) window.__receiptAnimations.push({ frames, options })
      return animate.call(this, frames, options)
    }
    const fetch = window.fetch, delivery = Date.now() + 1000
    window.fetch = async (...args) => {
      const response = await fetch(...args)
      if (!String(args[0]).includes('/api/v1/sent-files')) return response
      const payload = await response.json(), receipt = payload.files.find(file => file.fullPath.endsWith('/brief.md'))
      if (receipt) payload.files.push({ ...receipt, timestamp: delivery, sessionId: 'arrival-receipt' })
      return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } })
    }
  })
  await p.clock.fastForward(15001)
  const first = (await sentFiles(p)).first()
  assert.match(await first.getAttribute('data-key'), /brief.md$/)
  assert.equal(await first.locator('.ws-sent-new').count(), 1)
  await p.keyboard.press('Escape'); await poll(p, () => !document.querySelector('.ws-page-sheet').open)
  assert.ok(await report(p).evaluate(f => f.contentWindow === window.__arrivalReport))
  await leave(p); await barTab(p, 'shelf').click()
  await poll(p, () => document.querySelector('.ws-overview-ribbon [title*="brief.md"]'))
  if (reducedMotion !== 'reduce') await poll(p, () => window.__receiptAnimations.length)
  const folios = await p.evaluate(() => window.__receiptAnimations)
  assert.equal(folios.length, reducedMotion === 'reduce' ? 0 : 1)
  if (folios.length) {
    assert.equal(folios[0].options.duration, 400)
    assert.equal(folios[0].frames[1].transform, 'translateY(-4px)')
    assert.notEqual(folios[0].frames[1].boxShadow, 'none')
  }
}, undefined, 'false', reducedMotion)

test('j/k step constitutions in the sidebar order from a Board-opened reader, the sidebar shut; the Board shelves what was read', async p => {
  await barTab(p, 'shelf').click()
  assert.ok(await p.locator('.ws-overview-read').isHidden(), 'nothing read yet, no shelf')
  await p.locator('.ws-overview-folio').filter({ hasText: 'Weekly shear summary' }).click()
  await selected(p).waitFor()
  assert.equal(await activeBarView(p), 'shelf', 'the bar marks the Board as the origin')
  await leave(p)
  assert.equal(await activeBarView(p), 'shelf', 'the origin tab closes the reader back to the Board')
  assert.deepEqual(await p.locator('.ws-overview-read-name').allTextContents(), ['Weekly shear summary'])
  await p.locator('.ws-overview-folio').filter({ hasText: name }).click()
  await reportReady(p)
  await appFocus(p)
  await p.keyboard.press('Meta+Backslash')
  const sidebar = p.locator('.ws-sidebar')
  await sidebar.waitFor()
  // One grouped list wherever the reader opens: drafts, work in flight, then review.
  assert.deepEqual(await sidebar.locator('.kbn-flight-caption').allTextContents(), ['Drafts', 'Working', 'Awaiting review'])
  const rows = sidebar.locator('.ws-channel-row')
  const names = await rows.locator('.ws-channel-name').allTextContents()
  await rows.first().click()
  await poll(p, name => document.querySelector('.ws-channel-title')?.textContent === name, names[0])
  await p.keyboard.press('Meta+Backslash')
  await poll(p, () => !document.querySelector('.ws-sidebar')?.checkVisibility())
  await p.keyboard.press('j')
  await poll(p, name => document.querySelector('.ws-channel-title')?.textContent === name, names[1])
  await p.keyboard.press('j')
  await poll(p, name => document.querySelector('.ws-channel-title')?.textContent === name, names[2])
  await p.keyboard.press('k')
  await poll(p, name => document.querySelector('.ws-channel-title')?.textContent === name, names[1])
  // The Board's shelf holds every constitution opened, most recent first, and opens one in the reader.
  await leave(p)
  assert.deepEqual(await p.locator('.ws-overview-read-name').allTextContents(), [names[1], names[2], names[0], name])
  await p.locator('.ws-overview-read-item').nth(1).click()
  await poll(p, name => document.querySelector('.ws-channel-title')?.textContent === name, names[2])
})

test('The sidebar strip names the J/K stops; every jump and strip click shows the landed card under its caption', async p => {
  const deskNames = column => p.locator(`[data-column="${column}"] .kbn-card > .kbn-card-name`).allTextContents()
  const deskDrafts = await deskNames('drafts'), flight = await deskNames('inFlight'), review = await deskNames('awaitingReview')
  const knownDrafts = ['Weekly shear summary', 'Transfer-function check', 'Validate the summary against simulations']
  assert.deepEqual([...knownDrafts].sort(), [...deskDrafts].sort())
  const drafts = deskDrafts
  await open(p)
  const sidebar = p.locator('.ws-sidebar').first()
  const strip = sidebar.locator('.ws-sidebar-index-entry')
  assert.deepEqual(await strip.allTextContents(), [`Drafts${drafts.length}`, `In flight${flight.length}`, `Awaiting review${review.length}`])
  assert.deepEqual(await sidebar.locator('.ws-sidebar-index-entry[aria-current="location"]').allTextContents(), [`Awaiting review${review.length}`])
  const list = sidebar.locator('.ws-channel-list')
  assert.ok(await list.evaluate(el => el.scrollHeight > el.clientHeight), 'the short viewport makes the list scroll')
  // The landed card and its group's caption both sit inside the list's box, the card clear of the caption.
  const landed = async (title, group) => {
    await poll(p, title => document.querySelector('.ws-channel-title')?.textContent === title, title)
    await p.waitForTimeout(60)
    const view = await list.evaluate(el => {
      const box = el.getBoundingClientRect()
      const row = el.querySelector('.ws-channel-row[aria-current="true"]')
      const caption = row.closest('.ws-channel-group').querySelector('.kbn-flight-caption')
      const r = row.getBoundingClientRect(), c = caption.getBoundingClientRect()
      return { group: caption.textContent, inside: c.top >= box.top - 0.5 && c.bottom <= r.top + 0.5 && r.bottom <= box.bottom + 0.5, scrolled: el.scrollTop }
    })
    assert.equal(view.group, group)
    assert.ok(view.inside, `${title} and its caption ${group} are in view`)
    return view
  }
  await appFocus(p)
  await p.keyboard.press('Shift+K'); await landed(flight[0], 'Working')
  await p.keyboard.press('Shift+K'); await landed(drafts[0], 'Drafts')
  await p.keyboard.press('j'); await landed(drafts[1], 'Drafts')
  await p.keyboard.press('Shift+J'); await p.keyboard.press('Shift+J')
  const atReview = await landed(name, 'Awaiting review')
  assert.ok(atReview.scrolled > 0, 'the list scrolled down to reach review')
  // Upward from review, K must bring Working's caption back into view, not just its card.
  await p.keyboard.press('Shift+K'); await landed(flight[0], 'Working')
  await strip.filter({ hasText: 'Drafts' }).click(); await landed(drafts[1], 'Drafts')
  assert.deepEqual(await sidebar.locator('.ws-sidebar-index-entry[aria-current="location"]').allTextContents(), [`Drafts${drafts.length}`])
  await strip.filter({ hasText: 'Awaiting review' }).click(); await landed(name, 'Awaiting review')
  // Mid-group, the group's caption holds the top of the list while its cards
  // pass beneath; past its group, it leaves with it.
  const stuck = scrollTop => list.evaluate((el, scrollTop) => {
    el.scrollTop = scrollTop
    const top = el.getBoundingClientRect().top
    return [...el.querySelectorAll('.kbn-flight-caption')].filter(c => Math.abs(c.getBoundingClientRect().top - top) < 1)
      .map(c => { const group = c.parentElement.getBoundingClientRect(); return { caption: c.textContent, holds: group.top <= top && group.bottom > c.getBoundingClientRect().bottom } })
  }, scrollTop)
  assert.deepEqual(await stuck(80), [{ caption: 'Drafts', holds: true }])
  for (const scrollTop of [200, 400, 1e6]) for (const { caption, holds } of await stuck(scrollTop)) assert.ok(holds, `${caption} sticks only inside its own group`)
}, { width: 1440, height: 360 }, 'true')

test('Wide reader steps through Desk cards, preserves selection on Escape, and returns the current card through its origin tab', async p => {
  const column = p.locator('[data-column="awaitingReview"]')
  const cardNames = column => p.locator(`[data-column="${column}"] .kbn-card > .kbn-card-name`).allTextContents()
  const deskDrafts = await cardNames('drafts'), review = await cardNames('awaitingReview'), flight = await cardNames('inFlight')
  const knownDrafts = ['Weekly shear summary', 'Transfer-function check', 'Validate the summary against simulations']
  assert.deepEqual([...knownDrafts].sort(), [...deskDrafts].sort())
  const drafts = deskDrafts
  const names = [...drafts, ...flight, ...review]
  await open(p)
  const sidebar = p.locator('.ws-sidebar').first()
  assert.ok(await sidebar.isVisible(), 'wide desktop defaults open')
  assert.deepEqual(await sidebar.locator('.kbn-flight-caption').allTextContents(), ['Drafts', 'Working', 'Awaiting review'], 'the sidebar groups drafts, work in flight and review')
  assert.deepEqual(await sidebar.locator('.ws-channel-name').allTextContents(), names, 'in canonical group order')
  assert.equal(await sidebar.locator('.kbn-card').count(), names.length, 'sidebar uses the Desk paper renderer')
  assert.equal(await column.locator('.ws-sidebar-source').count(), review.length, "the opened card's column flies its cards into their places")
  const raised = await p.locator('.kbn-desk').evaluate(e => ({ transform: getComputedStyle(e).transform, filter: getComputedStyle(e).filter }))
  assert.match(raised.transform, /0\.94/)
  assert.match(raised.filter, /saturate\(0\.25\)/)
  const next = names[names.indexOf(name) + 1]
  await p.keyboard.press('j')
  await poll(p, name => document.querySelector('.ws-channel-title')?.textContent === name, next)
  const current = sidebar.locator('.ws-channel-row[aria-current="true"]')
  assert.equal(await current.locator('.ws-channel-name').innerText(), next)
  assert.ok(await current.evaluate(e => { const r = e.getBoundingClientRect(), col = e.closest('.ws-sidebar').getBoundingClientRect(); return r.left >= col.left && r.right <= col.right && r.width >= col.width * .9 }), 'the selected card occupies the sidebar without obscuring the reader')
  await p.keyboard.press('Escape')
  await poll(p, () => document.querySelectorAll('.ws-sidebar-source').length === 0)
  assert.equal(await p.locator('.ws-sidebar-source').count(), 0)
  assert.equal(await p.locator('.kbn-key-selected .kbn-card-name').innerText(), name, 'Escape keeps the original Desk selection')
  await open(p)
  await p.keyboard.press('j')
  await poll(p, name => document.querySelector('.ws-channel-title')?.textContent === name, next)
  await barTab(p, 'desk').click()
  await poll(p, () => !document.querySelector('.kbn-reader-open'))
  assert.equal(await p.locator('.kbn-key-selected .kbn-card-name').innerText(), next)
}, undefined, 'true')

test('Card FLIP opens, interrupts and returns on the 280 ms crossing', async p => {
  const entering = await p.evaluate(name => {
    const card = [...document.querySelectorAll('.kbn-desk .kbn-card')].find(card => card.textContent.includes(name))
    const rect = card.getBoundingClientRect()
    card.click()
    const ghost = document.querySelector('.ws-sidebar-flight .ws-channel-row')
    const animation = ghost?.getAnimations()[0]
    return { source: { left: rect.left, top: rect.top }, frames: animation?.effect.getKeyframes(), duration: animation?.effect.getTiming().duration }
  }, name)
  assert.equal(entering.duration, 280)
  assert.ok(entering.frames.every(frame => 'transform' in frame && 'opacity' in frame && !('filter' in frame)))
  await p.waitForTimeout(70)
  await p.locator('.ws-sidebar-toggle:not(.ws-rail-toggle)').click()
  await poll(p, () => !document.querySelector('.ws-sidebar-flight'))
  assert.equal(await p.locator('.ws-sidebar-flight').count(), 0)
  assert.equal(await p.locator('.ws-sidebar-source').count(), 0)
  await p.locator('.ws-sidebar-toggle:not(.ws-rail-toggle)').click()
  await p.waitForTimeout(330)
  assert.ok(await p.locator('.ws-sidebar-source').count())
  await leave(p)
  await p.waitForTimeout(330)
  assert.equal(await p.locator('.ws-sidebar-source,.ws-card-travelling,.ws-sidebar-flight').count(), 0)
}, undefined, 'true', 'no-preference')

test('Verdicts live in the chat bar, with the undo line on its header; keys reach them from a report', async p => {
  await open(p)
  assert.equal(await p.locator(':is(.ws-navbar, .kbn-viewtabs) :is(.kbn-ctl-temper, .kbn-ctl-discard)').count(), 0)
  await choose(p, 'Chat')
  const pair = selected(p).getByRole('group', { name: 'Verdict', exact: true })
  assert.ok(await pair.getByRole('button', { name: 'Temper', exact: true }).isVisible())
  assert.ok(await pair.getByRole('button', { name: 'Discard', exact: true }).isVisible())
  await choose(p, 'calibration-report')
  await p.clock.pauseAt(new Date('2026-10-04T14:00:30Z'))
  await appFocus(p); await p.keyboard.press('t')
  assert.equal(await isSelected(p, 'Chat'), true)
  assert.equal(await selected(p).locator('.ws-chat-acts > .ws-verdict-undo').count(), 1)
  assert.equal((await records(p)).filter(r => r.method === 'POST' && r.url.includes('/transition')).length, 0)
  await p.clock.runFor(6000)
  await poll(p, () => window.__harness.requests.some(r => r.method === 'POST' && r.url.includes('/transition')))
  await leave(p); await chooseDeskColumn(p, 1)
  await p.locator('.kbn-desk .kbn-card').filter({ hasText: 'Remote covariance review' }).click()
  await choose(p, 'Chat')
  assert.equal(await selected(p).locator('.ws-chat-drawer .ws-chat-console').count(), 1)
  assert.ok(await selected(p).getByRole('button', { name: 'Close for review', exact: true }).isVisible())
  assert.ok(await selected(p).getByRole('button', { name: 'Rest', exact: true }).isVisible())
})

async function verdictLook(locator) {
  return locator.evaluate(el => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')
    const rgb = color => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3) }
    const luminance = color => rgb(color).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0)
    const style = getComputedStyle(el)
    // A bare verb stands on its surface: the act zone, or the fiber page's paper.
    const fillColor = style.backgroundColor !== 'rgba(0, 0, 0, 0)' ? style.backgroundColor
      : el.closest('.ws-dock') ? getComputedStyle(el.closest('.ws-dock')).backgroundColor
      : getComputedStyle(el.closest('.ws-reader')?.querySelector('[data-part="veil"]') ?? document.body).getPropertyValue('--ws-ground').trim() || getComputedStyle(document.body).backgroundColor
    const ink = luminance(style.color), fill = luminance(fillColor)
    return { color: rgb(style.color), fill: rgb(fillColor), ratio: (Math.max(ink, fill) + .05) / (Math.min(ink, fill) + .05) }
  })
}
const tealish = ([r, g, b]) => g > r && b > r
const reddish = ([r, g, b]) => r > g + 30 && r > b + 30
for (const theme of [null, 'night-chart']) test(`Verdict verbs wear one pigment on every surface${theme ? `: ${theme}` : ''}`, async p => {
  if (theme) { const themed = new URL(url); themed.searchParams.set('theme-preview', `01KVBR1F9BWBVKF97473PV67K8:${theme}`); await p.goto(themed.href) }
  await open(p)
  await choose(p, 'Chat')
  const looks = {}
  looks.act = [await verdictLook(selected(p).locator('.kbn-ctl-verdict .kbn-ctl-temper')), await verdictLook(selected(p).locator('.kbn-ctl-verdict .kbn-ctl-discard'))]
  await p.clock.pauseAt(new Date('2026-10-04T14:00:30Z'))
  await selected(p).locator('.kbn-ctl-verdict .kbn-ctl-discard').click()
  looks.line = [await verdictLook(selected(p).locator('.ws-chat-acts > .ws-verdict-undo .ws-verdict-word'))]
  for (const [surface, [temper, discard]] of Object.entries(looks)) {
    if (temper && discard) { assert.ok(tealish(temper.color), `${surface} Temper ink is verdigris: ${temper.color}`); assert.ok(reddish(discard.color), `${surface} Discard ink is red: ${discard.color}`) }
    for (const look of [temper, discard].filter(Boolean)) assert.ok(look.ratio >= 4.5, `${surface} verdict ink ${look.color} on ${look.fill}: ${look.ratio.toFixed(2)}:1`)
  }
  assert.ok(reddish(looks.line[0].color), 'the undo line names a discard in red')
  if (!theme) {
    await p.keyboard.press('z')
    await p.goto(url)
    const card = p.locator('.kbn-desk .kbn-card').filter({ hasText: name })
    await card.click({ button: 'right' })
    const desk = [await verdictLook(p.getByRole('menuitem', { name: 'Temper', exact: true })), await verdictLook(p.getByRole('menuitem', { name: 'Discard', exact: true }))]
    assert.ok(desk.every(look => look.ratio >= 4.5), 'Desk menu verdict labels stay legible')
  }
})

async function anchoredInView(p, panel, trigger, label) {
  await poll(p, () => true)
  const [box, anchor, floor, open, hit] = await Promise.all([panel.boundingBox(), trigger.boundingBox(),
    p.evaluate(() => { const bar = document.querySelector('[data-part="phone-bottom-bar"]'); const r = bar?.getBoundingClientRect(); return r && r.height && r.top > 0 ? r.top : innerHeight }),
    panel.evaluate(el => el.matches(':popover-open')),
    panel.evaluate(el => { const item = el.querySelector('button'); const r = item.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) })])
  const vw = p.viewportSize().width
  assert.ok(open, `${label} rides the top layer`)
  assert.ok(box.x >= 0 && box.x + box.width <= vw && box.y >= 0 && box.y + box.height <= floor + 0.5, `${label} stays inside the viewport: ${JSON.stringify(box)} floor ${floor}`)
  assert.ok(hit, `${label} items are visible, not clipped`)
  const touching = Math.abs(box.y - (anchor.y + anchor.height)) <= 8 || Math.abs(box.y + box.height - anchor.y) <= 8
  assert.ok(touching, `${label} opens against its trigger: ${JSON.stringify({ box, anchor })}`)
  return { box, anchor }
}
for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) test(`Fiber page popovers open anchored and inside the viewport: ${device}`, async p => {
  await open(p); await choose(p, 'Chat')
  await chatMenu(p, 'Settings')
  for (const name of ['Effort', 'Agent']) {
    const control = selected(p).locator(`select[aria-label="${name}"]`)
    await control.scrollIntoViewIfNeeded()
    if (device === 'phone') continue
    await control.click()
    const picker = selected(p).locator('.ws-select-picker')
    const { box, anchor } = await anchoredInView(p, picker, control, `${name} list`)
    assert.ok(Math.abs(box.x - anchor.x) <= 1, `${name} list aligns with its select`)
    await p.keyboard.press('Escape')
    assert.equal(await picker.count(), 0)
  }
  if (device === 'desktop') {
    // The modal settings sheet contains expansion shortcuts as well as typing.
    assert.equal(await p.locator('.ws-page.ws-expanded').count(), 0)
    const effort = selected(p).locator('select[aria-label="Effort"]')
    await effort.scrollIntoViewIfNeeded()
    await effort.click()
    const picker = selected(p).locator('.ws-select-picker')
    const first = await anchoredInView(p, picker, effort, 'Effort list (expanded)')
    await selected(p).locator('.ws-settings-menu').evaluate(el => { el.scrollTop += 20 })
    await p.waitForTimeout(100)
    const after = await anchoredInView(p, picker, effort, 'Effort list (scrolled)')
    assert.ok(Math.abs((after.box.y - after.anchor.y) - (first.box.y - first.anchor.y)) <= 1, 'the list follows its select through a scroll')
    await p.keyboard.press('Escape')
  }
})

test('Phone fiber page: the folded settings line ends in an ellipsis', async p => {
  await open(p); await choose(p, 'Chat')
  await chatMenu(p, 'Settings')
  const toggle = selected(p).locator('.kbn-detail-controls-toggle')
  await toggle.click(); await frames(p)
  const history = selected(p).locator('.kbn-ctl-history-toggle')
  const [t, h] = await Promise.all([toggle.boundingBox(), history.boundingBox()])
  assert.ok(t.x + t.width <= h.x + 0.5 || t.y + t.height <= h.y + 0.5, `settings ${JSON.stringify(t)} and History ${JSON.stringify(h)} do not collide`)
  assert.ok(await selected(p).locator('.kbn-ctl-place').evaluate(el => getComputedStyle(el).textOverflow === 'ellipsis' && el.getBoundingClientRect().right <= innerWidth), 'the path stays in the phone drawer and can yield with an ellipsis')
}, { width: 402, height: 874 })

test('Landscape phone keeps a one-row top bar while the fiber awaits review', async p => {
  await open(p)
  assert.equal(await p.locator(':is(.ws-navbar, .kbn-viewtabs) :is(.kbn-ctl-temper, .kbn-ctl-discard)').count(), 0, 'neither bar carries verdicts')
  const bar = await p.locator('.ws-navbar').boundingBox()
  const title = await p.locator('.ws-channel-title').boundingBox()
  assert.ok(bar.height <= title.height + 12, `one row: navbar ${bar.height}px for a ${title.height}px title`)
  await choose(p, 'Chat')
  await headerAction(p, 'Settings')
  await p.locator('.ws-settings-menu:not([hidden])').waitFor()
  for (const verb of ['.kbn-ctl-temper', '.kbn-ctl-discard']) {
    const box = await selected(p).locator(`.ws-chat-head .kbn-ctl-verdict ${verb}`).boundingBox()
    assert.ok(box.height >= 44 && box.width >= 44, `${verb} is a full target on the constitution's page: ${JSON.stringify(box)}`)
  }
}, { width: 844, height: 390 }, 'false', 'reduce', true)

for (const reducedMotion of ['no-preference', 'reduce']) test(`Sidebar toggle is one transform slide (${reducedMotion})`, async p => {
  await open(p); await reportReady(p)
  await p.waitForTimeout(500) // the reader's own arrival settles first
  for (const opening of [true, false]) {
    await p.evaluate(() => {
      window.__before = new Set(document.getAnimations())
      window.__slide = []
      const t0 = performance.now()
      const tick = () => {
        const page = document.querySelector('.ws-page.ws-selected').getBoundingClientRect()
        window.__slide.push({ t: performance.now() - t0, page: page.left, width: page.width })
        if (performance.now() - t0 < 500) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await p.locator('.ws-sidebar-toggle:not(.ws-rail-toggle)').click()
    if (reducedMotion !== 'reduce') await poll(p, () => document.getAnimations()
      .filter(a => !window.__before.has(a) && a.effect?.target?.closest?.('.ws-reader') && a.constructor.name === 'Animation').length >= 2)
    const all = await p.evaluate(() => document.getAnimations().filter(a => !window.__before.has(a) && a.effect?.target?.closest?.('.ws-reader')).map(a => ({
      target: String(a.effect.target.className), kind: a.constructor.name, duration: a.effect.getTiming().duration, properties: [...new Set(a.effect.getKeyframes().flatMap(k => Object.keys(k).filter(key => !['offset', 'easing', 'composite', 'computedOffset'].includes(key))))],
    })))
    const animations = all.filter(a => a.kind === 'Animation')
    assert.deepEqual(all.filter(a => a.kind !== 'Animation' && a.properties.some(name => ['left', 'width', 'transform'].includes(name))), [], 'no layout property transitions run')
    if (reducedMotion === 'reduce') assert.deepEqual(animations, [], 'reduced motion lands instantly')
    else {
      assert.ok(animations.length >= 2, 'the sidebar and the stage move together')
      for (const a of animations) {
        assert.ok(a.duration >= 200 && a.duration <= 240, `slide lasts ${a.duration} ms: ${JSON.stringify(a)}`)
        assert.ok(a.properties.every(name => ['translate', 'opacity', 'clipPath'].includes(name)), `only compositor properties animate: ${a.properties}`)
      }
    }
    await p.waitForTimeout(600)
    const samples = await p.evaluate(() => window.__slide)
    // Where the column takes the page's preferred width, the page lands at its new width in one step and never reflows per frame.
    const widths = samples.map(s => Math.round(s.width)), changes = widths.slice(1).filter((w, i) => Math.abs(w - widths[i]) >= 1).length
    assert.ok(changes <= 1, `the page changes width at most once, in one step: ${widths.join(',')}`)
    const lefts = samples.map(s => s.page)
    const steps = lefts.slice(1).map((x, i) => Math.sign(Math.round(x - lefts[i])))
    assert.ok(!(steps.includes(1) && steps.includes(-1)), `the page moves one way, without a double jump: ${lefts.map(Math.round).join(',')}`)
    assert.equal(await p.locator('.ws-sidebar-toggle:not(.ws-rail-toggle)').getAttribute('aria-expanded'), String(opening))
  }
}, undefined, 'false', reducedMotion)

test('A key discard waits on the constitution in place of the pair; undo, then Temper, makes one delayed write', async p => {
  await open(p); await reportReady(p)
  await p.clock.pauseAt(new Date('2026-10-04T14:00:30Z'))
  await appFocus(p); await p.keyboard.press('x')
  assert.equal(await isSelected(p, 'Chat'), true, 'the key brings the constitution forward')
  const pair = selected(p).locator('.ws-chat-acts')
  assert.match(await pair.locator('.ws-verdict-undo').innerText(), /^DISCARDED/i)
  assert.ok(await pair.getByRole('button', { name: 'Temper', exact: true }).isHidden(), 'the pair gives way to the line')
  await p.clock.runFor(3000)
  await pair.getByRole('button', { name: `Undo verdict on ${name}`, exact: true }).click()
  await pair.getByRole('button', { name: 'Temper', exact: true }).click()
  assert.equal(await selected(p).locator('.ws-fiber-acts .ws-verdict-undo').count(), 1)
  assert.match(await pair.locator('.ws-verdict-undo').innerText(), /^TEMPERED/i)
  await p.clock.runFor(3999)
  assert.equal((await records(p)).filter(r => r.method === 'POST' && r.url.includes('/transition')).length, 0)
  await p.clock.runFor(1)
  await poll(p, () => window.__harness.requests.some(r => r.method === 'POST' && r.url.includes('/transition')))
  const writes = (await records(p)).filter(r => r.method === 'POST' && r.url.includes('/transition'))
  assert.equal(writes.length, 1)
  assert.equal(JSON.parse(writes[0].body).target, 'tempered')
})

test('a moves in-flight work to review through the Desk drag\'s transition, after an undo window z can cancel', async p => {
  await p.clock.pauseAt(new Date('2026-10-04T14:00:30Z'))
  p.on('dialog', dialog => dialog.accept())
  const posts = async () => (await records(p)).filter(r => r.method === 'POST' && r.url.includes('/transition'))
  await chooseDeskColumn(p, 1)
  const card = p.locator('.kbn-desk .kbn-card').filter({ hasText: 'Remote covariance review' })
  await card.click()
  await choose(p, 'Chat')
  await appFocus(p); await p.keyboard.press('a')
  const line = selected(p).locator('.ws-chat-acts > .ws-verdict-undo')
  assert.equal(await line.textContent(), 'To review·undo z')
  assert.equal(await p.locator('.ws-sr-only[aria-live="polite"]').filter({ hasText: 'undo z' }).textContent(), 'To review Remote covariance review · undo z')
  if (process.env.WORKSPACE_SHOTS) {
    await mkdir(process.env.WORKSPACE_SHOTS, { recursive: true })
    await selected(p).locator('.ws-chat-head').screenshot({ path: `${process.env.WORKSPACE_SHOTS}/to-review-window-reader.png` })
  }
  await p.keyboard.press('z')
  await p.clock.runFor(6000)
  assert.equal((await posts()).length, 0)
  await p.keyboard.press('a')
  await p.clock.runFor(3999)
  assert.equal((await posts()).length, 0)
  await p.clock.runFor(1)
  await poll(p, () => window.__harness.requests.some(r => r.method === 'POST' && r.url.includes('/transition')))
  assert.equal(JSON.parse((await posts())[0].body).target, 'awaitingReview')
})

for (const surface of ['Desk', 'fiber']) test(`${surface} verdict buttons delay and undo through the same queue`, async p => {
  await p.clock.pauseAt(new Date('2026-10-04T14:00:30Z'))
  if (surface === 'fiber') { await open(p); await choose(p, 'Chat') }
  const controls = surface === 'Desk'
    ? p.getByRole('menu')
    : selected(p).locator('.ws-chat-acts')
  if (surface === 'Desk') await p.locator('.kbn-desk .kbn-card').filter({ hasText: name }).click({ button: 'right' })
  await controls.getByRole(surface === 'Desk' ? 'menuitem' : 'button', { name: /Discard/ }).click()
  const host = surface === 'Desk' ? p.locator('.kbn-desk .kbn-card').filter({ hasText: name }).locator('.kbn-card-meta') : controls
  assert.equal(await host.locator(':scope > .ws-verdict-undo').count(), 1, 'the undo line takes the controls\' place')
  assert.equal(await p.locator('.ws-verdict-toasts').count(), 0, 'no floating line')
  assert.equal((await records(p)).filter(r => r.method === 'POST' && r.url.includes('/transition')).length, 0)
  await p.getByRole('button', { name: `Undo verdict on ${name}`, exact: true }).click()
  await p.clock.runFor(6000)
  assert.equal((await records(p)).filter(r => r.method === 'POST' && r.url.includes('/transition')).length, 0)
})

test('Verdict keys delay writes, guard typing, undo, and commit after leaving the reader', async p => {
  await open(p)
  await p.clock.pauseAt(new Date('2026-10-04T14:00:30Z'))
  const posts = async () => (await records(p)).filter(r => r.method === 'POST' && r.url.includes('/transition'))
  await p.keyboard.press('r')
  assert.equal(await isSelected(p, 'Chat'), true)
  const composer = selected(p).locator('textarea.kbn-detail-directive')
  assert.ok(await composer.evaluate(el => el === document.activeElement))
  await composer.press('t'); await composer.press('x')
  assert.equal(await p.locator('.ws-verdict-undo').count(), 0)
  await appFocus(p)
  for (const init of [{ isComposing: true }, { keyCode: 229 }, { metaKey: true }, { ctrlKey: true }]) {
    await p.evaluate(init => document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true, ...init })), init)
  }
  assert.equal(await p.locator('.ws-verdict-undo').count(), 0)
  await p.keyboard.press('t')
  assert.equal(await selected(p).locator('.ws-fiber-acts .ws-verdict-undo').textContent(), 'Tempered·undo z')
  assert.equal(await p.locator('.ws-sr-only[aria-live="polite"]').filter({ hasText: 'undo z' }).textContent(), 'Tempered Calibrate the shear response · undo z')
  assert.equal((await posts()).length, 0)
  await p.clock.runFor(3999)
  assert.equal((await posts()).length, 0)
  await p.keyboard.press('z')
  await p.clock.runFor(1)
  assert.equal((await posts()).length, 0)
  await p.keyboard.press('x')
  await p.getByRole('button', { name: `Undo verdict on ${name}`, exact: true }).click()
  await p.clock.runFor(6000)
  assert.equal((await posts()).length, 0)
  await p.keyboard.press('x')
  await leave(p)
  await p.clock.runFor(3999)
  assert.equal((await posts()).length, 0)
  await p.clock.runFor(1)
  await poll(p, () => window.__harness.requests.some(r => r.method === 'POST' && r.url.includes('/transition')))
  assert.equal((await posts()).length, 1)
})

test('Temper remains available by key for drafts and work in flight through the undo queue', async p => {
  await chooseDeskColumn(p, 0)
  await p.locator('.kbn-desk .kbn-card').filter({ hasText: 'Weekly shear summary' }).click()
  await choose(p, 'Chat')
  assert.equal(await selected(p).locator('.ws-fiber-acts .kbn-ctl-temper').isVisible(), false, 'draft headers reserve their space for session actions')
  await p.keyboard.press('t')
  await selected(p).locator('.ws-fiber-acts .ws-verdict-undo').waitFor()
  await p.keyboard.press('z')
  await poll(p, () => !document.querySelector('.ws-verdict-undo'))
  await leave(p)
  await chooseDeskColumn(p, 1)
  await p.locator('.kbn-desk .kbn-card').filter({ hasText: 'Remote covariance review' }).click()
  await choose(p, 'Chat')
  // A live worker asks once at the gesture; declining queues nothing.
  const asked = [], dialogErrors = []
  let finishDialog
  const dialogHandled = new Promise(resolve => { finishDialog = resolve })
  p.once('dialog', async dialog => {
    asked.push(dialog.message())
    try { await dialog.dismiss() } catch (error) {
      // Another CDP client may dismiss this browser-level dialog first.
      if (!error.message.includes('No dialog is showing')) dialogErrors.push(error)
    } finally { finishDialog() }
  })
  await appFocus(p); await p.keyboard.press('t')
  await Promise.race([dialogHandled, p.waitForTimeout(50)])
  assert.deepEqual(dialogErrors, [])
  assert.equal(asked.length, 1, 'tempering a live worker asks first')
  assert.equal(await p.locator('.ws-verdict-undo').count(), 0)
  assert.equal((await records(p)).filter(r => r.method === 'POST' && r.url.includes('/transition')).length, 0)
})

test('Pending verdicts on two fibers commit independently', async p => {
  await open(p)
  await p.clock.pauseAt(new Date('2026-10-04T14:00:30Z'))
  await p.keyboard.press('t')
  await leave(p)
  await p.locator('.kbn-desk .kbn-card').filter({ hasText: 'Mask validation notes' }).click()
  await poll(p, () => document.querySelector('.ws-channel-title')?.textContent === 'Mask validation notes')
  await p.keyboard.press('x')
  assert.equal(await p.evaluate(() => new Set([...document.querySelectorAll('[data-verdict-pending]')].map(el => el.dataset.verdictKey)).size), 2)
  await p.clock.runFor(6000)
  await poll(p, () => window.__harness.requests.filter(r => r.method === 'POST' && r.url.includes('/transition')).length === 2)
})

test('Conversation c (and its dot alias) uses the pill destination in reader and selected Desk card', async p => {
  const remote = p.locator('.kbn-desk .kbn-card').filter({ hasText: 'Remote covariance review' })
  await remote.click()
  const opened = n => poll(p, n => window.__harness.events.filter(e => e.type === 'open-worker').length === n, n)
  await p.keyboard.press('c'); await opened(1)
  assert.ok(!await p.locator('.ws-sidebar').isVisible(), 'c no longer toggles the sidebar')
  await p.keyboard.press('.'); await opened(2)
  await leave(p)
  await p.keyboard.press('c'); await opened(3)
  await p.keyboard.press('.'); await opened(4)
})

test('Fiber composer isolates keys; settings and history use mocked daemon', async p => {
  await open(p); await choose(p, 'Chat')
  const input = p.getByRole('textbox', { name: 'Message for the next worker' })
  await input.fill('hjkl'); await input.press('ArrowLeft'); await input.press('ArrowRight'); await input.press('ArrowUp'); await input.press('ArrowDown')
  await input.press('Alt+ArrowRight')
  assert.equal(await isSelected(p, 'Chat'), true, 'Alt+Right in the composer must not switch documents')
  await input.press('Alt+ArrowDown')
  assert.equal(await input.inputValue(), 'hjkl')
  assert.equal(await isSelected(p, 'Chat'), true)
  await chatMenu(p, 'Settings')
  assert.ok(await p.getByRole('combobox', { name: 'Agent', exact: true }).isVisible())
  await chatMenu(p, 'Settings')
  assert.equal(await p.getByRole('combobox', { name: 'Agent', exact: true }).isVisible(), false)
  await chatMenu(p, 'Sessions')
  await poll(p, () => window.__harness.requests.some(r => r.url.includes('/sessions') && r.url.includes('01KVBR1F9BWBVKF97473PV67K8')))
  await selected(p).locator('.kbn-ctl-session-list > li').last().waitFor()
  assert.equal(await selected(p).locator('.kbn-ctl-session-list > li').count(), 2)
  await chatMenu(p, 'Sessions')
})

test('Body file link opens a linked document', async p => {
  await open(p); await choose(p, 'Constitution')
  await selected(p).getByRole('link', { name: 'mask table' }).click()
  await poll(p, () => document.querySelector('.ws-selected .ws-label-title')?.textContent === 'mask.csv')
  assert.equal(await isSelected(p, 'mask.csv'), true)
})

test('Body wikilink opens a fiber absent from the card index', async p => {
  await open(p); await choose(p, 'Constitution')
  await selected(p).locator('.kbn-wikilink-live[data-fiber="research/workspace/method-note"]').click()
  await poll(p, () => document.querySelector('.ws-channel-title')?.textContent === 'Method note')
  await choose(p, 'Constitution')
  await selected(p).getByText('The response correction uses independent simulations and leaves the measured shear unchanged in the null tests.', { exact: true }).waitFor()
})

test('Overview first visit names its window and a numeric stored visit survives reload', async p => {
  await p.locator('[data-view="shelf"]').click()
  await poll(p, () => document.querySelector('.ws-overview-masthead')?.textContent?.includes('The last 30 days'))
  const key = 'shuttle.workspace.overview.seen'
  const seen = Date.parse('2026-10-03T14:00:00Z')
  await p.evaluate(({ key, seen }) => localStorage.setItem(key, JSON.stringify(seen)), { key, seen })
  const readSeen = () => p.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null'), key)
  assert.equal(typeof await readSeen(), 'number', 'the visit is stored as a JSON number')
  assert.equal(await readSeen(), seen)
  await p.reload()
  await p.locator('.kbn-card').filter({ hasText: name }).waitFor()
  assert.equal(await readSeen(), seen, 'reload retains the seeded visit timestamp')
})

test('Overview g selects the first change before folios and its main button opens the fiber', async p => {
  await p.locator('[data-view="shelf"]').click()
  const changes = p.locator('.ws-overview-change[data-uid]')
  await changes.first().waitFor()
  const first = changes.first()
  const uid = await first.getAttribute('data-uid')
  assert.equal(uid, '01KVBR1F9BWBVKF97473PV67K8')
  assert.ok(await first.locator('.ws-overview-change-open').count(), 'the row has a main open button')
  assert.ok(await first.locator('.ws-overview-change-doc').count(), 'the row has document thumbnails')
  await p.locator('.ws-overview-masthead').click()
  await p.keyboard.press('g')
  await poll(p, uid => {
    const selected = document.querySelector('.ws-overview .ws-key-selected')
    return !!selected && (selected.closest('.ws-overview-change')?.getAttribute('data-uid') ?? selected.getAttribute('data-uid')) === uid
  }, uid)
  assert.equal(await p.locator('.ws-overview-folio.ws-key-selected').count(), 0, 'g selects a change ahead of the folios')
  await first.locator('.ws-overview-change-open').click()
  await poll(p, expected => document.querySelector('.ws-channel-title')?.textContent === expected, name)
})

test('Overview document thumbnails open the exact receipt, and seen constitutions recede', async p => {
  await p.locator('[data-view="shelf"]').click()
  const row = p.locator('.ws-overview-change[data-uid="01KVBR1F9BWBVKF97473PV67K8"]')
  const thumbnail = row.locator('.ws-overview-change-doc').nth(1)
  await thumbnail.waitFor()
  const key = await thumbnail.getAttribute('data-key')
  await thumbnail.click()
  await poll(p, key => document.querySelector('.ws-page.ws-selected')?.getAttribute('data-key') === key, key)
  await leave(p)
  assert.equal(await row.count(), 0, 'opening the constitution acknowledges its change row')
  const folio = p.locator('.ws-overview-folio[data-uid="01KVBR1F9BWBVKF97473PV67K8"]')
  assert.ok(await folio.evaluate(el => el.classList.contains('ws-overview-seen')))
})

test('Overview lenses, declared-title Find, exact receipt ribbon route and scroll restoration', async p => {
  await p.locator('[data-view="shelf"]').click()
  for (const lens of ['Recent', 'Projects', 'Hosts']) {
    const radio = p.getByRole('radio', { name: lens, exact: true }); await radio.click()
    assert.equal(await radio.getAttribute('aria-checked'), 'true')
  }
  {
    const find = barFind(p)
    await find.fill('Calibrate')
    assert.equal(await p.locator('.ws-overview-folio:visible').count(), 1)
    // The field and the sheet's filter stay in step across views: leaving the Board empties both.
    await barTab(p, 'desk').click(); await barTab(p, 'shelf').click()
    await p.locator('.ws-overview-folio').first().waitFor()
    assert.equal(await find.inputValue(), '', 'switching views empties Find')
    assert.ok(await p.locator('.ws-overview-folio:visible').count() > 1, 'and lifts the sheet\'s filter')
    // So does opening a folio from a filtered sheet and coming back.
    await find.fill('Mask validation')
    await p.locator('.ws-overview-folio:visible').first().click()
    await poll(p, () => !!document.querySelector('.kbn-reader-open'))
    await leave(p)
    assert.equal(await find.inputValue(), '', 'the reader empties Find')
    assert.ok(await p.locator('.ws-overview-folio:visible').count() > 1, 'and the sheet is unfiltered on return')
  }
  const ribbon = await revealLatestFiles(p)
  // On the desktop the bar's Find filters the sheet; the sheet's own field is the phone's.
  assert.equal(await p.getByRole('searchbox', { name: 'Find work or files', exact: true }).isVisible(), false)
  const find = barFind(p)
  await find.fill('Calibrate')
  assert.equal(await p.locator('.ws-overview-folio:visible').count(), 1)
  await poll(p, () => document.querySelector('.ws-overview-ribbon')?.textContent?.includes('Calibration report'))
  await find.fill('Calibration report')
  await poll(p, () => [...document.querySelectorAll('.ws-overview-change[data-uid]')].some(row => row.dataset.uid === '01KVBR1F9BWBVKF97473PV67K8' && row.getClientRects().length > 0))
  assert.ok(await p.locator('.ws-overview-change[data-uid="01KVBR1F9BWBVKF97473PV67K8"] .ws-overview-change-doc').count(), 'Find includes the report’s declared title')
  await find.fill('')
  const receipt = ribbon.locator('button[title*="brief.md"]')
  await receipt.scrollIntoViewIfNeeded()
  await p.locator('.ws-overview').evaluate(e => { window.__overviewScroll = e.scrollTop })
  assert.ok(await p.evaluate(() => window.__overviewScroll > 0), 'overview must actually scroll')
  await receipt.click()
  assert.equal(await isSelected(p, 'brief.md'), true)
  await leave(p)
  assert.ok(await p.locator('.ws-overview').evaluate(e => e.scrollTop === window.__overviewScroll))
}, { width: 1440, height: 600 })

test('Overview media thumbnails show duration and a paused first video frame', async p => {
  await p.locator('[data-view="shelf"]').click()
  const ribbon = await revealLatestFiles(p)
  const audioCard = ribbon.locator('button').filter({ has: p.locator('.ws-overview-rib-label').getByText('tone.mp3', { exact: true }) })
  await audioCard.scrollIntoViewIfNeeded()
  await poll(p, () => [...document.querySelectorAll('.kbn-thumbnail-audio')].some(t => /\d+:\d\d/.test(t.textContent)))
  assert.match(await audioCard.innerText(), /\d+:\d\d/)
  assert.doesNotMatch(await audioCard.locator('.ws-overview-thumb').innerText(), /tone\.mp3/, 'ribbon caption owns the filename')
  const videoCard = ribbon.locator('button').filter({ hasText: 'test.mp4' })
  await videoCard.scrollIntoViewIfNeeded()
  await poll(p, () => [...document.querySelectorAll('.kbn-thumbnail-video video')].some(v => v.readyState >= 2 && v.videoWidth > 0 && v.paused))
  assert.ok(await videoCard.locator('video').evaluate(v => v.muted && !v.controls && v.paused && v.currentTime === 0 && v.closest('[inert]')))
})

test('Resent report is one document with four receipts', async p => {
  await open(p)
  assert.equal(await pageFor(p, 'calibration-report').count(), 1)
  await selected(p).getByRole('button', { name: 'Document menu', exact: true }).click()
  // The harness also sends the report from the current transcript session.
  await p.getByText('Receipts (4)', { exact: true }).click()
  const receipts = p.locator('.ws-receipts > div')
  assert.equal(await receipts.count(), 4)
  const sessions = (await receipts.allTextContents()).map(text => text.split(' · ').at(-1))
  assert.equal(new Set(sessions).size, 4, 'each send keeps its distinct receipt')
  for (const session of ['workspace-send-older', 'workspace-send-middle', 'workspace-send-latest']) assert.ok(sessions.includes(session))
})

test('Text, markdown, code, image, archive and missing-file cause', async p => {
  await open(p)
  for (const [label, text] of [['readme.txt', 'Fixture text document.'], ['brief.md', 'The transfer ratio is consistent with unity'], ['response.py', 'def response(ell, transfer):']]) {
    await choose(p, label)
    await selected(p).getByText(text, { exact: false }).waitFor()
  }
  await choose(p, 'figure.png')
  await poll(p, () => [...document.querySelectorAll('.ws-page img')].some(i => i.complete && i.naturalWidth > 0))
  await choose(p, 'archive.zip')
  await selected(p).getByRole('link', { name: 'Download', exact: true }).waitFor()
  assert.match(await selected(p).innerText(), /\d+\s*(B|bytes|KB)/i)
  await choose(p, 'not-produced.csv')
  await selected(p).getByText('Not found on umber-workstation', { exact: true }).waitFor()
  assert.match(await selected(p).locator('.ws-document-path').innerText(), /\/deliverables\/not-produced.csv$/)
})

test('A live-arriving image opens at full resolution from Sent files', async p => {
  await open(p)
  await choose(p, 'Chat')
  await p.evaluate(() => {
    const original = window.fetch
    window.fetch = async (...args) => {
      const response = await original(...args)
      if (!String(args[0]).includes('/api/v1/sent-files?')) return response
      const payload = await response.json()
      const source = payload.files.find(file => file.fullPath.endsWith('/figure.png'))
      if (source && !payload.files.some(file => file.fullPath.endsWith('/live-arrival.png'))) {
        payload.files.push({ ...source, fullPath: source.fullPath.replace(/figure\.png$/, 'live-arrival.png'), basename: 'live-arrival.png', timestamp: Date.now() + 1000, sessionId: 'live-image-arrival' })
      }
      return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } })
    }
  })
  await p.clock.fastForward(15001)
  const imageCard = (await sentFiles(p)).and(p.locator('[data-key$="/live-arrival.png"]'))
  await imageCard.waitFor()
  await imageCard.locator('.ws-sent-new').waitFor()
  await imageCard.click()
  await poll(p, () => !document.querySelector('.ws-page-sheet')?.open)
  const image = selected(p).locator('.kbn-fileview-image')
  await image.waitFor()
  const geometry = await image.evaluate(async img => {
    await img.decode()
    const rect = img.getBoundingClientRect(), content = img.closest('.ws-content').getBoundingClientRect()
    return { natural: [img.naturalWidth, img.naturalHeight], drawn: [rect.width, rect.height], content: [content.width, content.height] }
  })
  assert.deepEqual(geometry.natural, [3000, 600], 'the reader decodes the source image rather than the strip-sized representation')
  assert.ok(geometry.drawn[0] > 1000, `the source uses its intrinsic aspect ratio to fill the stage: ${JSON.stringify(geometry)}`)
  assert.ok(geometry.drawn[0] <= geometry.content[0] && geometry.drawn[1] <= geometry.content[1], `the image fits the stage: ${JSON.stringify(geometry)}`)
  assert.ok(geometry.drawn[0] <= geometry.natural[0] && geometry.drawn[1] <= geometry.natural[1], 'the reader does not enlarge the source beyond its pixels')
  assert.ok(Math.abs(geometry.drawn[1] / geometry.drawn[0] - .2) < .01, 'the reader preserves the source aspect ratio')
})

for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) test(`Receded media posters show cached audio peaks and the first video frame (${device})`, async p => {
  await open(p); await choose(p, 'tone.mp3')
  await poll(p, () => document.querySelector('.ws-selected .ws-audio-page')?.dataset.waveform === 'decoded')
  const geometry = await selected(p).locator('.ws-audio-page').evaluate(el => {
    const page = el.parentElement.getBoundingClientRect(), audio = el.getBoundingClientRect()
    return { paddingTop: getComputedStyle(el).paddingTop, topGap: audio.top - page.top, bottomGap: page.bottom - audio.bottom }
  })
  assert.equal(geometry.paddingTop, device === 'phone' ? '24px' : '44px', 'audio shares prose top inset')
  assert.ok(Math.abs(geometry.topGap - geometry.bottomGap) <= 2, `short audio comparison is vertically centered: ${JSON.stringify(geometry)}`)
  await choose(p, 'tone.wav')
  const audioPage = p.locator('.ws-page[data-key$="/tone.mp3"]')
  const audioPoster = audioPage.locator('.ws-media-poster')
  await poll(p, () => document.querySelector('.ws-page[data-key$="/tone.mp3"] .ws-media-poster-ready'))
  assert.equal(await audioPoster.locator('canvas').evaluate(canvas => canvas.width), 1000)
  assert.ok(await audioPoster.locator('canvas').evaluate(canvas => getComputedStyle(canvas).display === 'block'))
  const waveformWidth = await audioPoster.evaluate(el => {
    const page = el.closest('.ws-page'), display = page.style.display; page.style.display = 'block'
    const ratio = el.querySelector('canvas').getBoundingClientRect().width / el.getBoundingClientRect().width
    page.style.display = display; return ratio
  })
  assert.ok(waveformWidth >= 0.88, `waveform covers most of the neighbour (${waveformWidth})`)
  await choose(p, 'test.mp4')
  await poll(p, () => [...document.querySelectorAll('.ws-selected video')].some(video => video.readyState >= 2 && video.videoWidth > 0))
  await choose(p, 'tone.mp3')
  const videoPoster = p.locator('.ws-page[data-key$="/test.mp4"] .ws-media-poster')
  await poll(p, () => document.querySelector('.ws-page[data-key$="/test.mp4"] .ws-media-poster-ready'))
  assert.ok(await videoPoster.locator('canvas').evaluate(canvas => canvas.width > 0 && canvas.height > 0))
}, viewport)

for (const format of ['mp3', 'wav']) test(`Audio ${format} plays, progresses, pauses away and parking without auto-resume`, async p => {
  await open(p); await choose(p, `tone.${format}`)
  const audio = pageFor(p, `tone.${format}`).locator('audio')
  await audio.waitFor({ state: 'attached' })
  await audio.evaluate(a => { window.__audio = a })
  await p.evaluate(() => document.activeElement?.blur())
  await p.keyboard.press('Space')
  assert.ok(await audio.evaluate(a => a.paused), 'Space retains its reader meaning')
  await p.keyboard.press('p')
  await poll(p, () => window.__audio && !window.__audio.paused && window.__audio.currentTime > 0)
  await p.keyboard.press('p')
  assert.ok(await audio.evaluate(a => a.paused), 'p toggles native playback')
  await p.keyboard.press('p')
  await poll(p, () => !window.__audio.paused)
  assert.equal(await p.locator('audio').evaluateAll(as => as.filter(a => !a.paused).length), 1)
  await poll(p, () => [...document.querySelectorAll('audio')].some(e => !e.paused && e.currentTime > 0))
  const other = `tone.${format === 'mp3' ? 'wav' : 'mp3'}`
  await choose(p, other); assert.ok(await audio.evaluate(a => a.paused))
  assert.ok(await audio.evaluate(a => getComputedStyle(a.closest('.ws-content')).opacity === '0' && getComputedStyle(a.closest('.ws-sheet').querySelector('.ws-media-poster')).display === 'grid'), 'receded audio shows a poster, never live controls')
  await audio.evaluate(a => { window.__audioPausedTime = a.currentTime })
  await selected(p).locator('audio').evaluate(async a => { await a.play() })
  assert.equal(await p.locator('audio').evaluateAll(as => as.filter(a => !a.paused).length), 1)
  await choose(p, `tone.${format}`); assert.ok(await audio.evaluate(a => a.paused && a === window.__audio && a.currentTime === window.__audioPausedTime))
  assert.equal(await p.locator('audio').evaluateAll(as => as.filter(a => !a.paused).length), 0)
  await audio.evaluate(async a => { a.currentTime = 0; await a.play() })
  await leave(p)
  assert.ok(await audio.evaluate(a => a.paused))
  await audio.evaluate(a => { window.__audioParkedTime = a.currentTime })
  await open(p, `tone.${format}`)
  assert.ok(await audio.evaluate(a => a.paused && a === window.__audio && a.currentTime === window.__audioParkedTime))
})

test('Audio waveform, transport, comparison, keep-position and keyboard guards', async p => {
  await open(p); await choose(p, 'tone.mp3')
  await poll(p, () => document.querySelector('.ws-selected audio')?.readyState >= 1)
  await poll(p, () => document.querySelector('.ws-selected .ws-audio-page')?.dataset.waveform === 'decoded')
  const audio = selected(p).locator('audio')
  await audio.evaluate(a => { a.currentTime = 0.2 })
  await selected(p).getByRole('combobox', { name: 'Playback rate' }).selectOption('1.25')
  assert.equal(await audio.evaluate(a => a.playbackRate), 1.25)
  const waveform = selected(p).getByRole('slider', { name: 'Playback position' })
  const rect = await waveform.boundingBox()
  await p.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2)
  assert.ok(await audio.evaluate(a => Math.abs(a.currentTime - a.duration / 2) < 0.2))
  await p.mouse.move(rect.x + rect.width * 0.2, rect.y + rect.height / 2)
  assert.match(await selected(p).locator('.ws-audio-hover').innerText(), /\d+:\d\d/)
  const other = selected(p).locator('.ws-audio-compare button').filter({ hasText: 'tone.wav' })
  assert.ok(await other.count())
  await selected(p).getByRole('checkbox', { name: 'Keep position' }).check()
  const position = await audio.evaluate(a => a.currentTime)
  await other.click()
  await poll(p, () => document.querySelector('.ws-selected .ws-label-title')?.textContent === 'tone.wav')
  await poll(p, position => Math.abs(document.querySelector('.ws-selected audio').currentTime - position) < 0.2, position)
  assert.ok(await selected(p).locator('audio').evaluate(a => a.paused))
  await selected(p).getByRole('checkbox', { name: 'Keep position' }).uncheck()
  await selected(p).getByRole('button', { name: 'Play', exact: true }).click()
  await poll(p, () => !document.querySelector('.ws-selected audio').paused)
  await selected(p).getByRole('button', { name: 'Pause', exact: true }).click()
  await selected(p).locator('audio').evaluate(a => { a.currentTime = 0 })
  await p.keyboard.press(']')
  assert.ok(await selected(p).locator('audio').evaluate(a => a.currentTime > 0))
  await p.keyboard.press('[')
  assert.equal(await selected(p).locator('audio').evaluate(a => a.currentTime), 0)
  await p.keyboard.press('?')
  await p.getByText('Audio: play / pause', { exact: true }).waitFor()
  await p.keyboard.press('Escape')
})

for (const format of ['mp4', 'webm']) test(`Video ${format} plays and seeks native fixture`, async p => {
  await open(p); await choose(p, `test.${format}`)
  const video = pageFor(p, `test.${format}`).locator('video')
  await video.evaluate(async v => { await v.play() })
  await poll(p, () => [...document.querySelectorAll('video')].some(v => v.currentTime > 0 && v.videoWidth > 0))
  await video.evaluate(v => { v.pause(); v.currentTime = 0.5 })
  await poll(p, () => [...document.querySelectorAll('video')].some(v => !v.seeking && Math.abs(v.currentTime - 0.5) < 0.1))
  await video.evaluate(v => { window.__video = v })
  await choose(p, 'Constitution')
  assert.ok(await video.evaluate(v => v.paused && getComputedStyle(v.closest('.ws-content')).opacity === '0' && getComputedStyle(v.closest('.ws-sheet').querySelector('.ws-media-poster')).display === 'grid'))
  await choose(p, `test.${format}`)
  assert.ok(await video.evaluate(v => v === window.__video && Math.abs(v.currentTime - 0.5) < 0.1 && getComputedStyle(v.closest('.ws-content')).opacity === '1'))
})

async function assertRenderedPdf(p) {
  const canvas = selected(p).locator('.pdfViewer .page[data-page-number="1"] canvas').first()
  await canvas.waitFor()
  await p.waitForFunction(() => {
    const canvas = document.querySelector('.ws-page.ws-selected .pdfViewer canvas')
    if (!canvas?.width || !canvas.height) return false
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    let ink = false
    let paper = false
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] === 0) continue
      ink ||= pixels[i] < 200 && pixels[i + 1] < 200 && pixels[i + 2] < 200
      paper ||= pixels[i] > 240 && pixels[i + 1] > 240 && pixels[i + 2] > 240
      if (ink && paper) return true
    }
    return false
  })
  assert.equal(await selected(p).locator('.kbn-pdf-page-label').innerText(), '1 / 1')
  const fits = await canvas.evaluate(canvas => {
    const page = canvas.closest('.page').getBoundingClientRect()
    const viewport = canvas.closest('.kbn-pdf-scroll').getBoundingClientRect()
    return page.left >= viewport.left - 1 && page.right <= viewport.right + 1
      && page.top >= viewport.top - 1 && page.bottom <= viewport.bottom + 1
  })
  assert.ok(fits, 'the whole first PDF page fits in the viewer')
}

test('PDF.js paints fixture; owner route; Overview draws PDFs as faces', async p => {
  await open(p); await choose(p, 'response.pdf')
  await assertRenderedPdf(p)
  await choose(p, 'remote-summary.pdf')
  await assertRenderedPdf(p)
  assert.ok((await records(p)).some(r => r.url.includes('origin=basalt-login-02') && r.url.includes('remote-summary.pdf')))
  await leave(p)
  await p.locator('[data-view="shelf"]').click()
  await revealLatestFiles(p)
  await poll(p, () => document.querySelectorAll('.ws-overview .kbn-thumbnail-pdf').length > 0)
  assert.equal(await p.locator('.ws-overview .kbn-thumbnail-pdf iframe').count(), 0, 'PDF thumbnails draw a face, not the native viewer')
})

test('Remote worker conversation records attach handler without launching a terminal', async p => {
  await p.locator('.kbn-desk .kbn-card').filter({ hasText: 'Remote covariance review' }).click()
  await choose(p, 'Chat')
  await p.keyboard.press('c')
  await poll(p, () => window.__harness.events.some(e => e.type === 'open-worker') || window.__harness.handlers.some(h => h.path === '/api/v1/attach'))
  const event = await p.evaluate(() => window.__harness.events.find(e => e.type === 'open-worker'))
  assert.equal(event.host, 'basalt-login-02')
  assert.match(event.session, /remote-review-01KVBR3H8DYFXNH96683RX89N0-shuttle/)
})

test("Console in Settings opens the same remote worker as c", async p => {
  await p.locator('.kbn-desk .kbn-card').filter({ hasText: 'Remote covariance review' }).click()
  await choose(p, 'Chat')
  await headerAction(p, 'Console')
  await poll(p, () => window.__harness.events.some(e => e.type === 'open-worker') || window.__harness.handlers.some(h => h.path === '/api/v1/attach'))
  const event = await p.evaluate(() => window.__harness.events.find(e => e.type === 'open-worker'))
  assert.equal(event.host, 'basalt-login-02')
})

test('Phone overview single column, report reader and Back', async p => {
  const switcher = await p.locator('.kbn-viewtabs').boundingBox()
  assert.equal(Math.round(switcher.y + switcher.height), 844, 'view switcher sits at the bottom')
  for (const view of ['desk', 'chronicle', 'shelf']) assert.ok((await p.locator(`[data-view="${view}"]`).boundingBox()).height >= 44)
  const seasons = p.locator('.kbn-viewtabs-lens')
  if (await seasons.locator('.kbn-lens-chip').count()) {
    const gear = await p.locator('.kbn-viewtabs-settings').boundingBox(), lane = await seasons.boundingBox()
    assert.ok(lane.x + lane.width <= gear.x, 'season scrollport ends before Settings')
    await seasons.evaluate(el => { el.scrollLeft = el.scrollWidth })
    assert.ok(await seasons.evaluate(el => el.scrollLeft > 0))
  }
  await p.locator('[data-view="shelf"]').click()
  await poll(p, () => document.querySelector('.ws-overview-change[data-uid]')?.getClientRects().length > 0)
  const firstChange = p.locator('.ws-overview-change[data-uid]').first()
  const firstBounds = await firstChange.evaluate(row => {
    const root = row.closest('.ws-overview')
    const rowBounds = row.getBoundingClientRect(), rootBounds = root.getBoundingClientRect()
    return { scrollTop: root.scrollTop, top: rowBounds.top, bottom: rowBounds.bottom, viewTop: rootBounds.top, viewBottom: rootBounds.bottom }
  })
  assert.equal(firstBounds.scrollTop, 0, 'the phone overview has not scrolled')
  assert.ok(firstBounds.top >= firstBounds.viewTop && firstBounds.bottom <= firstBounds.viewBottom, 'the first changed row is visible on entry')
  assert.equal((await p.locator('.ws-overview').boundingBox()).y, 0, 'overview starts above the bottom switcher')
  await poll(p, () => document.querySelectorAll('.ws-overview-folio:not([hidden])').length >= 2)
  const folios = await p.locator('.ws-overview-folio:visible').evaluateAll(es => es.map(e => e.getBoundingClientRect().x))
  assert.ok(folios.length > 1 && folios.every(x => Math.abs(x - folios[0]) < 2))
  await p.locator('.ws-overview-folio').filter({ hasText: name }).click()
  await selected(p).waitFor()
  await choose(p, 'calibration-report'); await reportReady(p)
  await leave(p)
  assert.ok(await p.getByRole('searchbox', { name: 'Find work or files', exact: true }).isVisible())
}, { width: 390, height: 844 })

test('Phone audio page taller than the screen scrolls from its top to its bottom', async p => {
  await open(p); await choose(p, 'tone.mp3')
  const scroller = selected(p).locator('.kbn-fileview-audio')
  await selected(p).locator('.ws-audio-page').waitFor()
  const reach = () => scroller.evaluate(el => {
    const page = el.querySelector('.ws-audio-page').getBoundingClientRect(), box = el.getBoundingClientRect()
    return { overflow: el.scrollHeight - el.clientHeight, top: page.top - box.top, bottom: box.bottom - page.bottom }
  })
  const start = await reach()
  assert.ok(start.overflow > 0, `the fixture outgrows the short screen (${start.overflow}px)`)
  assert.ok(Math.abs(start.top) <= 0.5, `the waveform starts in reach at the top (${start.top}px)`)
  await scroller.evaluate(el => { el.scrollTop = el.scrollHeight })
  assert.ok((await reach()).bottom >= -0.5, 'the page\'s end scrolls into view')
  assert.equal(await selected(p).locator('.ws-audio-waveform').evaluate(el => getComputedStyle(el).touchAction), 'pan-y', 'a vertical pan on the waveform scrolls the page')
}, { width: 390, height: 420 }, 'false', 'reduce', true)

test('Phone HTML reader retains its opaque frame and reading position', async p => {
  await open(p); const frame = await reportReady(p)
  const inner = await reportDocument(p)
  assert.equal(await frame.evaluate(f => f.contentDocument), null)
  await inner.evaluate(() => window.scrollTo(0, 160))
  await pollReport(p, () => document.scrollingElement.scrollTop === 160)
  const menu = p.locator('.ws-navbar .ws-phone-document-menu')
  await menu.focus(); await menu.press('Enter')
  await p.getByRole('button', { name: 'Sent files', exact: true }).waitFor()
  await frames(p)
  assert.ok((await p.locator('.ws-navbar').boundingBox()).y >= 0, 'keyboard access keeps the phone navbar visible while its menu owns focus')
  await p.keyboard.press('Escape')
  await choose(p, 'brief.md'); await choose(p, 'calibration-report')
  assert.equal(await reportY(p), 160)
  const box = await selected(p).boundingBox()
  assert.equal(box.x, 0, 'HTML page starts at the phone edge')
  assert.equal(box.width, p.viewportSize().width, 'HTML page fills the phone width')
  await mkdir(shots, { recursive: true })
  await p.screenshot({ path: resolve(shots, 'sandbox-report-phone.png') })
}, { width: 390, height: 844 })

for (const viewport of [{ width: 375, height: 667 }, { width: 390, height: 844 }, { width: 430, height: 932 }]) {
  test(`Phone ${viewport.width}: edge-to-edge page, modal sheet choice, focus and browser Back`, async p => {
    await open(p); await reportReady(p)
    const geometry = await selected(p).evaluate(el => {
      const rect = el.getBoundingClientRect(), sheet = getComputedStyle(el.querySelector('.ws-sheet'))
      return { x: rect.x, width: rect.width, border: sheet.borderTopWidth, radius: sheet.borderRadius, shadow: sheet.boxShadow }
    })
    assert.equal(geometry.x, 0); assert.equal(geometry.width, viewport.width)
    assert.equal(geometry.border, '0px'); assert.equal(geometry.radius, '0px'); assert.equal(geometry.shadow, 'none')
    assert.equal(await selected(p).locator('.ws-labelbar').isVisible(), false)
    await choose(p, 'Chat')
    const url = p.url()
    const opener = p.locator('.ws-rail-toggle')
    await opener.click()
    const sheet = p.getByRole('dialog', { name: 'Sent files', exact: true })
    await sheet.waitFor()
    assert.equal(p.url(), url, 'sheet is a same-address history layer')
    await sheet.locator('[data-part="sent-files-more"]').click()
    assert.ok(await sheet.locator('.ws-sent-file').count() >= 12)
    assert.ok(await sheet.locator('.ws-sent-file time').first().getAttribute('datetime'))
    for (let i = 0; i < 22; i++) {
      await p.keyboard.press('Tab')
      assert.ok(await sheet.evaluate(el => el.contains(document.activeElement)), 'native modal keeps focus inside the sheet')
    }
    await p.keyboard.press('l')
    assert.equal(await isSelected(p, 'Chat'), true, 'sheet keys cannot step reader')
    await p.goBack()
    await poll(p, () => !document.querySelector('.ws-page-sheet').open)
    assert.equal(p.url(), url); assert.ok(await opener.evaluate(el => el === document.activeElement))
    await opener.click()
    await sheet.locator('.ws-sent-file[data-key$="/brief.md"]').click()
    await poll(p, () => !document.querySelector('.ws-page-sheet').open)
    assert.equal(await isSelected(p, 'brief.md'), true)
    await choose(p, 'Chat'); await opener.click(); await p.mouse.click(10, 10)
    await poll(p, () => !document.querySelector('.ws-page-sheet').open)
    await opener.click()
    const grabber = await sheet.getByRole('button', { name: 'Close threads and files' }).boundingBox()
    await swipe(p, grabber.x + grabber.width / 2, grabber.y + 20, grabber.x + grabber.width / 2, grabber.y + 90)
    await poll(p, () => !document.querySelector('.ws-page-sheet').open)
    await leave(p)
    await poll(p, () => document.querySelector('.ws-reader')?.inert)
  }, viewport)
}

test('Phone back swipe nests; edges, vertical pans and sideways content keep their touches', async p => {
  await open(p); await reportReady(p)
  const key = () => selected(p).getAttribute('data-key')
  const original = await key()
  await choose(p, 'brief.md')
  const nested = await key()
  await swipe(p, 100, 420, 300, 416)
  assert.equal(await key(), original, 'a back swipe inside a document returns to its parent report')
  await poll(p, () => !document.querySelector('.ws-stage').classList.contains('ws-swiping'))
  await swipe(p, 5, 420, 200, 420)
  assert.equal(await key(), original, 'Safari edge-back starts are not claimed')
  await swipe(p, p.viewportSize().width - 5, 420, 150, 420)
  assert.equal(await key(), original, 'right-edge starts are not claimed')
  await swipe(p, 200, 650, 204, 250)
  assert.equal(await key(), original, 'vertical report scroll is not a page gesture')
  await poll(p, () => document.querySelector('.ws-reader').classList.contains('ws-topbar-hidden'))
  await p.waitForTimeout(650) // Let the native touch fling settle before returning to the top.
  await (await reportDocument(p)).evaluate(() => window.scrollTo(0, 0))
  await poll(p, () => !document.querySelector('.ws-reader').classList.contains('ws-topbar-hidden'))
  const table = await report(p).contentFrame().locator('#wide-table').boundingBox()
  assert.ok(await (await reportDocument(p)).evaluate(() => { const el = document.getElementById('wide-table'); return el.scrollWidth > el.clientWidth }), 'the fixture table scrolls sideways')
  await swipe(p, 300, table.y + table.height / 2, 100, table.y + table.height / 2)
  assert.equal(await key(), original, 'a horizontally scrollable table keeps its swipe')
  for (const id of ['gesture-deck', 'gesture-carousel']) {
    await (await reportDocument(p)).evaluate(id => document.getElementById(id).scrollIntoView({ block: 'center' }), id)
    // Hiding the top bar moves the report under the finger; swipe once it has settled.
    await poll(p, () => document.querySelector('.ws-reader').classList.contains('ws-topbar-hidden'))
    await p.waitForTimeout(400)
    const gesture = await report(p).contentFrame().locator(`#${id}`).boundingBox()
    await swipe(p, 300, gesture.y + gesture.height / 2, 100, gesture.y + gesture.height / 2)
    assert.equal(await key(), original, `${id} keeps its own sideways gesture`)
  }
  await (await reportDocument(p)).evaluate(() => window.scrollTo(0, 0))
  await swipe(p, 120, 420, 300, 420, true)
  assert.equal(await key(), original, 'a cancelled swipe stays on its page')
  await poll(p, () => !document.querySelector('.ws-stage').classList.contains('ws-swiping'))
  await choose(p, 'brief.md')
  const brief = await key()
  const block = selected(p).locator('table')
  await block.waitFor()
  assert.equal(await selected(p).locator('.kbn-fileview-text').evaluate(el => el.scrollWidth <= el.clientWidth), true, 'a wide table does not widen the page')
  const box = await block.boundingBox()
  assert.ok(await block.evaluate(el => el.scrollWidth > el.clientWidth), 'the field note table scrolls sideways inside the page')
  await swipe(p, 300, box.y + box.height / 2, 100, box.y + box.height / 2)
  assert.equal(await key(), brief, 'a sideways-scrolling markdown table keeps its swipe')
  await swipe(p, 100, box.y + box.height + 60, 300, box.y + box.height + 64)
  assert.notEqual(await key(), brief, 'board-rendered prose below the table still goes back')
}, { width: 390, height: 844 })

test('Phone composer keys keep focus and document identity', async p => {
  await open(p); await choose(p, 'Chat')
  const field = selected(p).locator('textarea').first(), key = await selected(p).getAttribute('data-key')
  await field.focus(); await field.press('ArrowRight'); await field.press('Alt+ArrowRight')
  assert.equal(await selected(p).getAttribute('data-key'), key)
  assert.ok(await field.evaluate(el => el === document.activeElement))
  await field.evaluate(el => el.blur())
  assert.equal(await selected(p).getAttribute('data-key'), key)
}, { width: 390, height: 844 })

test('Phone page swipe follows the finger, snaps back short of the threshold and commits past it', async p => {
  await open(p); await reportReady(p)
  await exerciseTrackSettlementWait(p)
  await waitForTrackSettlement(p)
  const original = await selected(p).getAttribute('data-key')
  const rest = await p.locator('.ws-track').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).m41)
  const reportText = await (await reportDocument(p)).locator('body > p').first().boundingBox()
  assert.ok(reportText, 'the report prose provides a stable noninteractive swipe surface')
  const y = reportText.y + reportText.height / 2
  const cdp = await p.context().newCDPSession(p)
  const touch = (type, x, touchY = y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: touchY, radiusX: 1, radiusY: 1 }] })
  await touch('touchStart', 100, y)
  for (const x of [108, 120, 140, 160]) { await touch('touchMove', x, y); await p.waitForTimeout(30) }
  await poll(p, () => document.querySelector('.ws-stage').classList.contains('ws-swiping'))
  const held = await p.locator('.ws-track').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).m41)
  assert.ok(Math.abs(held - (rest + 60)) <= 2, `the track follows the finger (${rest} → ${held})`)
  assert.equal(await p.locator('.ws-page.ws-receded:visible').count(), 0, 'the nested reader does not expose a page strip')
  await p.waitForTimeout(200)
  await touch('touchEnd')
  await poll(p, rest => Math.abs(new DOMMatrix(getComputedStyle(document.querySelector('.ws-track')).transform).m41 - rest) < 1, rest)
  assert.equal(await selected(p).getAttribute('data-key'), original, 'a short, slow release snaps back')
  await touch('touchStart', 80, y)
  for (const x of [90, 140, 200, 260, 310]) { await touch('touchMove', x, y); await p.waitForTimeout(16) }
  await touch('touchEnd')
  assert.notEqual(await selected(p).getAttribute('data-key'), original, 'a long release commits')
  assert.ok(await p.locator('.ws-stage').evaluate(el => el.classList.contains('ws-swipe-release')), 'the commit settles on the release curve')
  await cdp.detach()
}, { width: 390, height: 844 }, 'false', 'no-preference')

async function swipe(p, x, y, endX, endY, cancel = false) {
  const cdp = await p.context().newCDPSession(p)
  const point = (x, y) => [{ x, y, radiusX: 1, radiusY: 1 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(x, y) })
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(x + (endX - x) * i / 6, y + (endY - y) * i / 6) })
    await p.waitForTimeout(20)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] })
  await p.waitForTimeout(80)
  await cdp.detach()
}

async function waitForTrackSettlement(p) {
  await poll(p, () => {
    const track = document.querySelector('.ws-track')
    if (!track) return false
    const computed = new DOMMatrix(getComputedStyle(track).transform).m41
    const target = new DOMMatrix(track.style.transform || 'none').m41
    return Math.abs(computed - target) < 0.5
  })
}

async function exerciseTrackSettlementWait(p) {
  const track = p.locator('.ws-track')
  const saved = await track.evaluate(el => ({ transform: el.style.transform, transition: el.style.transition }))
  const transition = await track.evaluate(el => {
    const start = new DOMMatrix(getComputedStyle(el).transform).m41
    el.style.transition = 'transform 180ms linear'
    void el.offsetWidth
    el.style.transform = `translateX(${start + 80}px)`
    const transition = el.getAnimations().find(animation => animation.transitionProperty === 'transform')
    if (!transition) return null
    transition.pause()
    transition.currentTime = 0
    const computed = new DOMMatrix(getComputedStyle(el).transform).m41
    const target = new DOMMatrix(el.style.transform).m41
    return { gap: Math.abs(computed - target) }
  })
  assert.ok(transition && transition.gap > 5, 'the guard fixture holds a real transform transition before its target')
  await track.evaluate(el => el.getAnimations().find(animation => animation.transitionProperty === 'transform')?.play())
  await waitForTrackSettlement(p)
  const settled = await track.evaluate(el => Math.abs(new DOMMatrix(getComputedStyle(el).transform).m41 - new DOMMatrix(el.style.transform).m41) < 0.5)
  assert.equal(settled, true, 'the readiness guard waits for a real track transition to settle')
  await track.evaluate((el, saved) => {
    el.style.transition = 'none'
    el.style.transform = saved.transform
    void el.offsetWidth
    el.style.transition = saved.transition
  }, saved)
}

test('Reader Cmd-Backslash toggles the sidebar; slash focuses the bar Find, which filters the sidebar in place, and Enter selects', async p => {
  await open(p)
  const sidebar = p.locator('.ws-sidebar')
  const find = barFind(p)
  await appFocus(p)
  await p.keyboard.press('Meta+Backslash')
  await sidebar.waitFor()
  assert.ok(await sidebar.isVisible())
  assert.equal(await p.locator('.ws-page.ws-receded:visible').count(), 0, 'the sidebar does not reveal a retired page strip')
  assert.equal(await p.getByRole('button', { name: 'Hide constitutions', exact: true }).getAttribute('aria-expanded'), 'true')
  assert.equal(await sidebar.locator('input').count(), 0, 'the sidebar has no find field of its own')
  await appFocus(p)
  await p.keyboard.press('/')
  assert.ok(await find.evaluate(e => e === document.activeElement), '/ focuses the bar Find')
  for (const query of ['Calibrate the shear response', 'research/workspace/calibration-report', 'TONE.MP3']) {
    await find.fill(query)
    if (!query.includes('/')) assert.equal(await sidebar.locator('.ws-channel-row:visible').count(), 1, `sidebar matches ${query}`)
    assert.ok((await sidebar.locator('.ws-channel-row:visible .ws-channel-name').allTextContents()).includes(name), `sidebar includes the constitution matching ${query}`)
    assert.equal(await p.locator('.ws-switcher').count(), 0, 'with the sidebar open, Find filters it in place')
  }
  await find.press('Enter')
  assert.equal(await p.locator('.ws-channel-title').textContent(), name)
  assert.ok(await sidebar.isVisible(), 'selection keeps the sidebar open')
  await appFocus(p); await p.keyboard.press('/')
  assert.ok(await find.evaluate(e => e === document.activeElement))
  await find.press('Escape')
  assert.ok(await sidebar.isVisible(), 'Escape from Find does not leave the reader or hide the sidebar')
  assert.ok(await p.locator('.kbn-modal').evaluate(el => el.classList.contains('kbn-reader-open')))
  assert.deepEqual(await find.evaluate(e => [e === document.activeElement, e.value]), [false, ''], 'one Escape clears and blurs Find')
  assert.equal(await sidebar.locator('.ws-channel-row:visible').count(), await sidebar.locator('.ws-channel-row').count(), 'the cleared query shows every row again')
  await reportReady(p)
  await p.keyboard.press('Meta+Backslash')
  assert.equal(await sidebar.isVisible(), false)
  await p.keyboard.press('Meta+Backslash')
  assert.ok(await sidebar.isVisible(), 'Cmd-Backslash remains a sidebar alias')
  await p.keyboard.press('Meta+Backslash')
  assert.equal(await sidebar.isVisible(), false)
})

test('Reader slash with the sidebar shut hangs the constitution list under the bar Find; Escape puts it away and Enter chooses a file match', async p => {
  await open(p)
  const find = barFind(p)
  await appFocus(p); await p.keyboard.press('/')
  const picker = p.locator('.ws-menu.ws-switcher')
  assert.ok(await find.evaluate(e => e === document.activeElement))
  await find.fill('remote-summary.pdf')
  await picker.waitFor()
  assert.equal(await picker.locator('input').count(), 0, 'the list holds rows only; the field is the bar\'s')
  const [list, field] = await Promise.all([picker.boundingBox(), find.boundingBox()])
  assert.ok(list.y >= field.y + field.height - 1 && Math.abs(list.y - (field.y + field.height)) <= 12, `the list hangs under the field: ${JSON.stringify({ list, field })}`)
  assert.equal(await picker.locator('.ws-channel-row').count(), 1)
  assert.equal(await picker.locator('.ws-channel-name').innerText(), name)
  await find.press('Escape')
  assert.equal(await picker.count(), 0)
  assert.deepEqual(await find.evaluate(e => [e === document.activeElement, e.value]), [false, ''], 'one Escape closes the list, clears and blurs Find')
  // Escape on a focused row does what Escape in the field does, and the reader stays.
  await appFocus(p); await p.keyboard.press('/')
  await find.fill('remote-summary.pdf')
  await picker.locator('.ws-channel-row').first().focus()
  await p.keyboard.press('Escape')
  assert.equal(await picker.count(), 0, 'Escape on a row closes the list')
  assert.equal(await find.inputValue(), '', 'and empties Find')
  assert.ok(await p.locator('.kbn-reader-open').count(), 'and leaves the reader open')
  // Escape on a sidebar card returns from the file to its chat; the next return leaves the reader.
  await p.keyboard.press('Meta+Backslash')
  await poll(p, () => document.querySelector('.ws-sidebar')?.checkVisibility())
  await p.locator('.ws-sidebar .ws-channel-row').first().focus()
  await p.keyboard.press('Escape')
  await poll(p, () => document.querySelector('.ws-selected')?.dataset.key.startsWith('chat:'))
  await leave(p)
  await open(p)
  if (!await p.evaluate(() => document.querySelector('.ws-sidebar')?.checkVisibility())) await p.keyboard.press('Meta+Backslash')
  await poll(p, () => document.querySelector('.ws-sidebar')?.checkVisibility())
  await p.keyboard.press('Meta+Backslash')
  await poll(p, () => !document.querySelector('.ws-sidebar')?.checkVisibility())
  await p.keyboard.press('Meta+Backslash')
  await poll(p, () => document.querySelector('.ws-sidebar')?.checkVisibility())
  assert.equal(await find.inputValue(), '', 'bare keys act on the app again: Cmd-Backslash toggles the sidebar, not the field')
  await p.keyboard.press('Meta+Backslash')
  await poll(p, () => !document.querySelector('.ws-sidebar')?.checkVisibility())
  await p.keyboard.press('/')
  await find.fill('transfer.txt')
  assert.equal(await picker.locator('.ws-channel-row').count(), 1)
  assert.equal(await picker.locator('.ws-channel-name').innerText(), 'Remote covariance review')
  await find.press('Enter')
  await poll(p, () => document.querySelector('.ws-channel-title')?.textContent === 'Remote covariance review')
  assert.equal(await picker.count(), 0)
})

test('Sidebar current card follows j/k, Alt navigation and browser Back immediately in a Board-opened reader', async p => {
  await p.locator('[data-view="shelf"]').click()
  await p.locator('.ws-overview-folio').filter({ hasText: name }).click()
  await reportReady(p)
  await appFocus(p)
  await p.keyboard.press('Meta+Backslash')
  const sidebar = p.locator('.ws-sidebar')
  const rows = sidebar.locator('.ws-channel-row')
  await sidebar.waitFor()
  assert.ok(await sidebar.isVisible())
  const names = await rows.locator('.ws-channel-name').allTextContents()
  assert.ok(names.length >= 3, 'navigation exercises several constitutions')
  await rows.first().click()
  await poll(p, first => document.querySelector('.ws-channel-title')?.textContent === first, names[0])
  await assertCurrent(names[0])
  let index = 0
  for (const [key, delta] of [['j', 1], ['j', 1], ['k', -1], ['k', -1], ['Alt+ArrowDown', 1], ['Alt+ArrowDown', 1], ['Alt+ArrowUp', -1]]) {
    await p.keyboard.press(key)
    index += delta
    await assertCurrent(names[index])
    // A keyboard switch hands focus to the selected tile in the bar's map.
    if (key.startsWith('Alt+')) assert.ok(await selected(p).count(), 'keyboard channel navigation retains a selected page')
  }
  await p.goBack()
  await poll(p, previous => document.querySelector('.ws-channel-title')?.textContent === previous, names[index + 1])
  await assertCurrent(names[index + 1])

  async function assertCurrent(expected) {
    // One browser observation after each key: title and current row must agree
    // together, without polling away a stale selection marker.
    const state = await sidebar.evaluate(sidebar => {
      const current = [...sidebar.querySelectorAll('.ws-channel-row[aria-current="true"]')]
      const row = current[0]
      const list = sidebar.querySelector('.ws-channel-list')
      const bounds = row?.getBoundingClientRect()
      const viewport = list.getBoundingClientRect()
      const other = sidebar.querySelector('.ws-channel-row:not([aria-current="true"])')
      const material = el => {
        const css = getComputedStyle(el)
        return [css.backgroundColor, css.boxShadow, css.transform].join('|')
      }
      return {
        count: current.length,
        name: row?.querySelector('.ws-channel-name')?.textContent,
        reader: document.querySelector('.ws-channel-title')?.textContent,
        distinguished: !!row && !!other && material(row) !== material(other),
        inView: !!bounds && bounds.top >= viewport.top - 1 && bounds.bottom <= viewport.bottom + 1,
      }
    })
    assert.equal(state.count, 1)
    assert.equal(state.name, expected)
    assert.equal(state.reader, expected)
    assert.ok(state.distinguished, 'current row has a distinct selected surface')
    assert.ok(state.inView, 'reduced-motion nearest scrolling keeps the current row visible')
  }
}, { width: 1440, height: 460 })

for (const view of ['desk', 'chronicle']) test(`${view === 'desk' ? 'Desk' : 'Chronicle'} slash hangs the constitution list under the bar Find without opening the reader; Escape and Enter work`, async p => {
  if (view !== 'desk') { await barTab(p, view).click(); await poll(p, view => document.querySelector('.kbn-viewtab-active')?.dataset.view === view, view) }
  const find = barFind(p)
  await appFocus(p); await p.keyboard.press('/')
  assert.equal(await p.locator('.ws-page.ws-selected:visible').count(), 0, 'Find does not enter the reader')
  assert.ok(await find.evaluate(e => e === document.activeElement))
  const picker = p.locator('.ws-menu.ws-switcher')
  for (const query of ['Calibrate the shear response', 'research/workspace/calibration-report', 'tone.mp3']) {
    await find.fill(query)
    await picker.waitFor()
    if (!query.includes('/')) assert.equal(await picker.locator('.ws-channel-row').count(), 1, `the list matches ${query}`)
    assert.ok((await picker.locator('.ws-channel-name').allTextContents()).includes(name), `the list includes the constitution matching ${query}`)
  }
  assert.equal(await picker.locator('input').count(), 0, 'the bar holds the field')
  await find.press('Escape')
  assert.equal(await picker.count(), 0)
  assert.equal(await p.locator('.ws-page.ws-selected:visible').count(), 0)
  assert.deepEqual(await find.evaluate(e => [e === document.activeElement, e.value]), [false, ''], 'one Escape closes the list, clears and blurs Find')
  assert.equal(await activeBarView(p), view)
  // With the list closed and the field focused, Escape still clears and blurs.
  await p.keyboard.press('/')
  await find.fill('zzzz-no-match')
  await find.press('Escape')
  assert.deepEqual(await find.evaluate(e => [e === document.activeElement, e.value]), [false, ''], 'Escape on a field with no list clears and blurs')
  await p.keyboard.press('/')
  await find.fill('tone.mp3')
  await find.press('Enter')
  await reportReady(p)
  assert.equal(await p.locator('.ws-channel-title').textContent(), name)
  assert.equal(await isSelected(p, 'calibration-report'), true)
  assert.equal(await activeBarView(p), view, 'the bar marks the view Find opened the reader from')
})

for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  test(`Worker plate and undo line states: ${device}`, async p => {
    const shot = async state => {
      if (!process.env.WORKSPACE_SHOTS) return
      await mkdir(shots, { recursive: true }); await p.screenshot({ path: resolve(shots, `verdict-${device}-${state}.png`) })
    }
    await open(p); await choose(p, 'Chat')
    assert.equal(await selected(p).locator('.ws-chat-acts .kbn-card-worker').count(), 0)
    assert.equal(await p.locator(':is(.ws-navbar, .kbn-viewtabs) :is(.kbn-ctl-temper, .kbn-ctl-discard)').count(), 0)
    if (device === 'phone') await headerAction(p, 'Settings')
    for (const verb of ['Temper', 'Discard']) {
      const button = selected(p).getByRole('button', { name: verb, exact: true }), box = await button.boundingBox()
      assert.ok(box.x >= 0 && box.x + box.width <= viewport.width)
      if (device === 'phone') assert.ok(box.height >= 44)
    }
    if (device === 'phone') { await p.keyboard.press('Escape'); await p.locator('.ws-page-sheet[open], .ws-settings-menu:not([hidden])').waitFor({ state: 'hidden' }) }
    await shot('awaiting-review')
    await appFocus(p); await p.keyboard.press('t')
    const line = selected(p).locator('.ws-chat-acts > .ws-verdict-undo')
    await line.waitFor(); assert.equal(await line.evaluate(el => getComputedStyle(el).animationName), 'none')
    if (device === 'phone') assert.ok((await line.getByRole('button').boundingBox()).height >= 44)
    await shot('undo-line'); await p.keyboard.press('z'); await leave(p)
    await chooseDeskColumn(p, 1)
    await p.locator('.kbn-desk .kbn-card').filter({ hasText: 'Remote covariance review' }).click()
    await choose(p, 'Chat')
    const state = selected(p).locator('.ws-chat-state')
    await poll(p, () => document.querySelector('.ws-selected .ws-chat-state')?.textContent === 'Working')
    assert.equal(await selected(p).locator('.kbn-card-worker:visible').count(), 0, 'the state is said once, without a second worker pill')
    assert.equal(await state.evaluate(el => getComputedStyle(el).animationName), 'none')
    await shot('working')
    await p.evaluate(async () => {
      const row = window.__harness.MOCK_FEED.fibers.find(row => row.fiber.name === 'Remote covariance review')
      row.runtime.phase = 'waiting'; row.runtime.last_activity_at = Date.now() - 120000
      await window.__harness.modal.fetchAndRender()
    })
    await poll(p, () => document.querySelector('.ws-selected .ws-chat-state')?.textContent === 'Your turn')
    await shot('waiting'); await leave(p); await chooseDeskColumn(p, 0)
    await p.locator('.kbn-desk .kbn-card').filter({ hasText: 'Weekly shear summary' }).click()
    assert.equal(await selected(p).locator('.kbn-card-worker').count(), 0)
    await shot('no-worker')
  }, viewport)
}

test('The chat state word stays still while the sidebar worker breathes', async p => {
  await p.locator('.kbn-desk .kbn-card').filter({ hasText: 'Remote covariance review' }).click()
  const state = selected(p).locator('.ws-chat-state')
  await state.waitFor()
  assert.equal(await state.evaluate(el => getComputedStyle(el).animationName), 'none')
  const dot = p.locator('.ws-sidebar:not([inert]) .kbn-card').filter({ hasText: 'Remote covariance review' }).locator('.constitution-state-dot')
  await dot.waitFor()
  assert.deepEqual(await dot.evaluate(el => {
    const css = getComputedStyle(el, '::before')
    return { name: css.animationName, duration: css.animationDuration, easing: css.animationTimingFunction, iterations: css.animationIterationCount }
  }), { name: 'kbn-worker-breathe', duration: '2.4s', easing: 'ease-in-out', iterations: 'infinite' }, 'the working sidebar dot breathes on the shared opacity cycle')
  assert.deepEqual(await dot.evaluate(el => el.getAnimations({ subtree: true }).find(animation => animation.animationName === 'kbn-worker-breathe')?.effect?.getKeyframes().map(frame => frame.opacity)), ['1', '0.5', '1'], 'the running animation changes opacity, not geometry')
  await p.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(await dot.evaluate(el => getComputedStyle(el, '::before').animationName), 'none', 'reduced motion suppresses the sidebar cycle')
  await p.emulateMedia({ reducedMotion: 'no-preference' })
  assert.equal(await dot.evaluate(el => getComputedStyle(el, '::before').animationName), 'kbn-worker-breathe')
  await p.evaluate(async () => {
    const row = window.__harness.MOCK_FEED.fibers.find(row => row.fiber.name === 'Remote covariance review')
    row.runtime.phase = 'waiting'; row.runtime.last_activity_at = Date.now() - 120000
    await window.__harness.modal.fetchAndRender()
  })
  await poll(p, () => document.querySelector('.ws-selected .ws-chat-state')?.textContent === 'Your turn')
  assert.equal(await dot.evaluate(el => getComputedStyle(el, '::before').animationName), 'none', 'the sidebar dot stops breathing when the worker yields')
}, undefined, 'true', 'no-preference')

// Say-it-once checks cover the selected page and its chrome. Tabs and the
// constitution switcher repeat names as navigation actions. The desktop fiber
// title is a reading anchor; the phone uses only the navbar name. Expanded
// settings may repeat values in editable controls. Parked/receded pages and
// the inert Desk are not a second readable screen.
const inventory = []
const shots = process.env.WORKSPACE_SHOTS || '/tmp/workspace-say-once'
for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  test(`Say it once: ${device} fiber, media, PDF and unsupported metadata`, async p => {
    await open(p); await choose(p, 'Constitution')
    const header = selected(p).locator('.ws-prose-header')
    assert.equal((await header.locator('.ws-prose-status').innerText()).trim().toLowerCase(), 'awaiting your review')
    assert.equal(await header.locator('.ws-fiber-acts').count(), 0, 'prose does not duplicate chat controls')
    assert.equal(await selected(p).locator('.ws-dock').count(), 0)
    assert.equal(await selected(p).locator('.ws-agent,.ws-prose-agent,.ws-prose-host,.ws-dock-status').count(), 0)
    assert.equal(await selected(p).locator('.ws-fiber-prose > h1:visible').count(), device === 'phone' ? 0 : 1)
    assert.match(await selected(p).locator('.ws-provenance').innerText(), /changed 47m ago/i)
    await capture('fiber')
    await choose(p, 'Chat')
    assert.equal(await selected(p).locator('.ws-chat-outcome').count(), 0, 'the outcome belongs to the prose page')
    const passive = await selected(p).evaluate(page => {
      const walk = document.createTreeWalker(page, NodeFilter.SHOW_TEXT), texts = []
      while (walk.nextNode()) { const el = walk.currentNode.parentElement; if (el.checkVisibility({ visibilityProperty: true }) && !el.closest('.ws-transcript,.kbn-ctl-menu,.ws-chat-drawer')) texts.push(walk.currentNode.textContent) }
      return texts.join(' ')
    })
    assert.doesNotMatch(passive, /claude-opus|umber-workstation|\/fixture-store\/workspace/)
    await chatMenu(p, 'Settings')
    const settings = selected(p).locator('.kbn-detail-controls-toggle')
    assert.match(await settings.innerText(), /claude-opus/); assert.match(await settings.innerText(), /high/)
    assert.match(await settings.innerText(), /umber-workstation/); assert.match(await settings.innerText(), /\/fixture-store\/workspace/)
    for (const cls of ['agent', 'effort', 'place']) assert.equal(await selected(p).locator(`.kbn-ctl-${cls}`).count(), 1)
    assert.ok(await selected(p).getByRole('combobox', { name: 'Agent', exact: true }).isVisible())
    await capture('settings-expanded'); await chatMenu(p, 'Settings')
    await chatMenu(p, 'Sessions'); await selected(p).locator('.kbn-ctl-session-list > li').last().waitFor()
    await capture('history-expanded'); await chatMenu(p, 'Sessions')
    await choose(p, 'calibration-report'); await reportReady(p); await capture('report')
    for (const [state, label] of [['media', 'tone.mp3'], ['pdf', 'response.pdf'], ['unsupported', 'archive.zip']]) {
      await choose(p, label)
      if (state === 'media') {
        await poll(p, () => document.querySelector('.ws-selected .ws-audio-page')?.dataset.waveform === 'decoded')
        assert.equal(await selected(p).locator('.ws-audio-waveform').count(), 1)
        await capture('audio-paused'); await selected(p).getByRole('button', { name: 'Play', exact: true }).click()
        await poll(p, () => document.querySelector('.ws-selected audio')?.currentTime > 0.2)
        await capture('audio-playing'); await selected(p).getByRole('button', { name: 'Pause', exact: true }).click()
      }
      if (state === 'pdf') await assertRenderedPdf(p)
      if (state === 'unsupported') await selected(p).getByRole('link', { name: 'Download', exact: true }).waitFor()
      await poll(p, () => { const v = document.querySelector('.ws-selected .ws-document-viewer'); return v && getComputedStyle(v).opacity === '1' })
      assert.equal(await selected(p).locator('.ws-label-title').innerText(), label)
      const provenance = await selected(p).locator('.ws-provenance').innerText()
      assert.match(provenance, /sent 2m ago/); assert.doesNotMatch(provenance, /claude-opus|umber-workstation/)
      assert.equal(await selected(p).locator('.ws-content .kbn-media-title,.ws-content .kbn-media-provenance,.ws-content h1,.ws-content h3').count(), 0)
      assert.doesNotMatch(await selected(p).locator('.ws-content').innerText(), /sent \d|receipts|claude-opus|umber-workstation|tone\.mp3|response\.pdf|archive\.zip/)
      await capture(state)
    }
    await choose(p, 'remote-summary.pdf')
    assert.match(await selected(p).locator('.ws-provenance').innerText(), /basalt-login-02/)
    assert.doesNotMatch(await selected(p).locator('.ws-provenance').innerText(), /claude-opus/)
    await leave(p); await chooseDeskColumn(p, 1)
    await p.locator('.kbn-desk .kbn-card').filter({ hasText: 'Remote covariance review' }).click(); await choose(p, 'Chat')
    assert.equal(await selected(p).locator('.kbn-card-worker:visible').count(), 0)
    await chatMenu(p, 'Settings')
    const cadence = selected(p).locator('.kbn-detail-controls-toggle .kbn-ctl-cadence')
    assert.equal(await cadence.count(), 1); assert.ok((await cadence.innerText()).trim())
    const outside = await selected(p).evaluate(page => { const copy = page.cloneNode(true); copy.querySelector('.ws-chat-drawer')?.remove(); return copy.textContent })
    assert.ok(!outside.includes(await cadence.innerText()), 'cadence has one editable home')
    await leave(p); await p.locator('[data-view="shelf"]').click(); await p.locator('.ws-overview-folio').first().waitFor()
    await p.screenshot({ path: resolve(shots, `${device}-overview.png`) })
    async function capture(state) {
      await mkdir(shots, { recursive: true })
      const facts = await p.evaluate(() => {
        const page = document.querySelector('.ws-selected'), texts = selector => [...page.querySelectorAll(selector)].map(el => el.textContent.trim())
        return { header: texts('.ws-prose-header,.ws-chat-head'), settings: texts('.kbn-detail-controls-toggle'), title: texts('.ws-label-title'), provenance: texts('.ws-provenance'), inPageTitles: page.querySelectorAll('.ws-content h1,.ws-content h3,.ws-content .kbn-media-title').length }
      })
      const screenshot = resolve(shots, `${device}-${state}.png`); await p.screenshot({ path: screenshot })
      inventory.push({ device, state, ...facts, screenshot }); console.log(`INVENTORY ${JSON.stringify(inventory.at(-1))}`)
    }
  }, viewport)
}

test('Theme font families are private and unicode-range faces cannot target the composer', async p => {
  await open(p); await choose(p, 'Constitution')
  const requests = []
  await p.route('https://theme-probe.invalid/**', route => { requests.push(route.request().url()); return route.abort() })
  const result = await p.evaluate(() => {
    const reader = document.querySelector('.ws-reader')
    const scope = reader.dataset.wsTheme
    const css = `@font-face { font-family: "EB Garamond"; src: url(https://theme-probe.invalid/character-a.woff2); unicode-range: U+61; }
      @font-face { font-family: "Fixture Multi Word"; src: local("Georgia"); }
      :scope { --fixture-font: Fixture Multi Word; }
      [data-part="prose"] { font-family: var(--fixture-font, "EB Garamond") !important; }
      [data-part="prose"] p { font: italic 18px "Fixture Multi Word", serif !important; }
      [data-part="act"] textarea { font-family: "EB Garamond"; }`
    const source = window.__harness.scopeTheme(css, `[data-ws-theme="${scope}"]`, 'font-probe')
    const before = new Set(document.fonts)
    const style = document.createElement('style'); style.textContent = source; document.head.append(style)
    const composer = reader.querySelector('textarea'); composer.value = 'aaaa'; composer.focus()
    return { source, font: getComputedStyle(composer).fontFamily,
      proseFont: getComputedStyle(reader.querySelector('[data-part="prose"]')).fontFamily,
      paragraphFont: getComputedStyle(reader.querySelector('[data-part="prose"] p')).fontFamily,
      faces: [...document.fonts].filter(face => !before.has(face)).map(face => face.family) }
  })
  await p.waitForTimeout(200)
  assert.ok(result.source.includes('font-probe-EB Garamond'))
  assert.ok(result.source.includes('font-probe-Fixture Multi Word'))
  assert.ok(result.proseFont.includes('font-probe-Fixture Multi Word'), 'custom-property font references are renamed')
  assert.ok(result.paragraphFont.includes('font-probe-Fixture Multi Word'), 'font shorthand references are renamed')
  assert.ok(!result.font.includes('font-probe'), 'the act-zone composer keeps its own font')
  assert.ok(!result.faces.includes('EB Garamond'), 'a theme cannot install an unnamespaced font-face')
  assert.deepEqual(requests, [], 'unicode-range faces and theme URLs cannot fetch arbitrary servers')
})

test('Theme URLs allow only data, Google Fonts and relative resources inside the fiber folder', async p => {
  const result = await p.evaluate(() => {
    const css = `@font-face { font-family: Test; src: url("./fonts/test.woff2"); }
      :scope { --good: url("nested/../paper.png"); --bad: url("../secret.png");
        --encoded: url("%2e%2e/secret.png"); --slash: url("nested%2f..%2fsecret.png");
        --external: url("https://theme-probe.invalid/beacon"); --same: url("https://board.test/api/v1/version");
        --absolute: url("/api/v1/version"); --protocol: url("//theme-probe.invalid/beacon");
        --escaped: u\\72l("https://theme-probe.invalid/escape");
        --data: url("data:image/svg+xml;base64,PHN2Zy8+");
        --google: url("https://fonts.gstatic.com/s/font.woff2");
        --disguised: url("https://fonts.gstatic.com.evil.test/font.woff2");
        --image-set: image-set("https://theme-probe.invalid/image.png" 1x);
      }`
    return window.__harness.scopeTheme(css, '[data-ws-theme="url-probe"]', 'url-probe', new Map(), 'https://board.test/api/v1/file-assets/owner/fiber/theme.css')
  })
  for (const allowed of ['data:image', 'fonts.gstatic.com/s/font.woff2', '/file-assets/owner/fiber/fonts/test.woff2', '/file-assets/owner/fiber/paper.png']) assert.ok(result.includes(allowed), allowed)
  for (const forbidden of ['theme-probe.invalid', 'secret.png', '/api/v1/version', 'evil.test']) assert.ok(!result.includes(forbidden), forbidden)
})

test('Escaped theme imports cannot load unscoped CSS or target the composer', async p => {
  await open(p); await choose(p, 'Constitution')
  await choose(p, 'Chat')
  const composer = p.locator('.ws-selected [data-part="act"] textarea')
  await composer.waitFor()
  const before = await composer.evaluate(element => getComputedStyle(element).color)
  const requests = []
  await p.route('https://fonts.googleapis.com.evil.test/**', route => {
    requests.push(route.request().url())
    return route.fulfill({ contentType: 'text/css', body: 'textarea { color: rgb(123, 45, 67) !important; }' })
  })
  const compiled = await p.evaluate(() => {
    const css = String.raw`@import "https://fonts.googleapis.com\2e evil.test/probe.css"; :scope { --probe: 1; }`
    const output = window.__harness.scopeTheme(css, '[data-ws-theme="import-probe"]', 'import-probe')
    const style = document.createElement('style'); style.textContent = output; document.head.append(style)
    return output
  })
  await p.waitForTimeout(250)
  assert.deepEqual(requests, [], 'CSS-decoded import host must pass the resource policy')
  assert.ok(!compiled.includes('evil.test'))
  assert.equal(await composer.evaluate(element => getComputedStyle(element).color), before)
  const safe = await p.evaluate(() => window.__harness.scopeTheme(String.raw`@import "https://fonts.googleapis.com/css2?family=Roboto" screen; :scope { color: red; }`, ':scope', 'safe-import'))
  assert.ok(safe.includes('@import url("https://fonts.googleapis.com/css2?family=Roboto") screen;'), 'permitted imports use a canonical URL')
})

test('Custom theme is scoped with private keyframes, hoisted fonts and conditional rules', async p => {
  const desk = await p.locator('.kbn-card').first().evaluate(el => getComputedStyle(el).opacity)
  await p.locator('[data-view="shelf"]').click()
  await p.locator('.ws-overview-folio[data-uid="01KVBR1F9BWBVKF97473PV67K8"]').click()
  await choose(p, 'Constitution')
  await poll(p, () => getComputedStyle(document.querySelector('.ws-reader')).getPropertyValue('--ws-custom-ready').trim() === '1')
  const theme = await p.locator('.ws-reader').getAttribute('data-ws-theme')
  const source = await p.locator(`style[data-ws-theme-sheet="${theme}"]`).textContent()
  assert.ok(source.includes(`@keyframes ${theme}-ink-flourish`))
  assert.ok(source.includes(`animation-name: ${theme}-ink-flourish`))
  assert.ok(source.includes(`--fixture-animation: ${theme}-ink-flourish`))
  assert.ok(source.includes(`var(--fixture-animation, ${theme}-ink-flourish`))
  assert.ok(source.includes(`@keyframes ${theme}-1ink`))
  assert.ok(source.includes(`var(--fixture-space-animation, ${theme}-1ink`))
  await p.emulateMedia({ reducedMotion: 'no-preference' })
  assert.equal(await selected(p).locator('[data-part="fiber-title"]').evaluate(el => getComputedStyle(el, '::after').animationName), `${theme}-ink-flourish`)
  assert.equal(await selected(p).locator('.ws-prose h2').first().evaluate(el => getComputedStyle(el).animationName), `${theme}-foo\\ bar`, 'escaped and quoted names share CSSOM identity')
  await p.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(await selected(p).locator('[data-part="fiber-title"]').evaluate(el => getComputedStyle(el, '::after').animationName), 'none')
  assert.ok(source.includes('@font-face') && source.includes('Shuttle Fixture Flourish'))
  assert.ok(source.includes('@media') && source.includes('@supports') && source.includes('@layer'))
  assert.equal(await selected(p).locator('[data-part="prose"]').evaluate(el => getComputedStyle(el).getPropertyValue('--ws-after-nested').trim()), '1', 'declarations following a nested selector survive CSSOM scoping')
  assert.ok(!source.includes('example.invalid'), 'non-Google imports are removed before insertion')
  const fontImport = '@import url(https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;600&display=swap);'
  const allowed = await p.evaluate(css => window.__harness.scopeTheme(`${css} h1 { color: red }`, '[data-ws-theme="font-check"]', 'font-check'), fontImport)
  assert.ok(allowed.startsWith('@import url("https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;600&display=swap");'), 'Google Fonts import survives URL semicolons in canonical form')
  assert.ok(allowed.includes('@scope'), 'rules after an import remain scoped')
  assert.equal(await p.locator('.kbn-card').first().evaluate(el => getComputedStyle(el).opacity), desk, 'Desk is outside the theme scope')
  const other = p.locator('.ws-overview-folio[data-uid="01KVBR2G7CXDWMG85592QW78M9"]')
  assert.equal(await other.evaluate(el => getComputedStyle(el).getPropertyValue('--ws-custom-ready').trim()), '', 'another channel does not inherit the custom theme')
  await leave(p)
  await other.click()
  assert.equal(await p.locator('.ws-reader').evaluate(el => getComputedStyle(el).getPropertyValue('--ws-custom-ready').trim()), '')
})

test('Plain removes custom and bundled styling, persists, and can restore custom CSS', async p => {
  await p.locator('[data-view="shelf"]').click()
  await p.locator('.ws-overview-folio[data-uid="01KVBR1F9BWBVKF97473PV67K8"]').click()
  await choose(p, 'Constitution')
  await poll(p, () => getComputedStyle(document.querySelector('.ws-reader')).getPropertyValue('--ws-custom-ready').trim() === '1')
  const plain = await openPlainThemeMenu(p)
  await plain.click()
  assert.equal(await plain.getAttribute('aria-pressed'), 'true')
  assert.equal(await plain.evaluate(el => getComputedStyle(el, '::before').content), '"✓"')
  assert.equal(await p.locator('.ws-reader').getAttribute('data-ws-theme'), null)
  assert.equal(await p.locator('.ws-overview-folio[data-uid="01KVBR1F9BWBVKF97473PV67K8"]').getAttribute('data-ws-theme'), null)
  await p.reload()
  await p.locator('.ws-channel-title').waitFor({ state: 'attached' })
  assert.equal(await p.locator('.ws-reader').getAttribute('data-ws-theme'), null)
  const plainAfterReload = await openPlainThemeMenu(p)
  await plainAfterReload.click()
  await poll(p, () => getComputedStyle(document.querySelector('.ws-reader')).getPropertyValue('--ws-custom-ready').trim() === '1')
  await p.setViewportSize({ width: 390, height: 844 })
  const phonePlain = await openPlainThemeMenu(p)
  assert.ok((await phonePlain.boundingBox()).height >= 44, 'Plain has a phone-sized touch target')
})

test('Broken theme falls back to its bundled base', async p => {
  await p.locator('.kbn-card').filter({ hasText: 'Mask validation notes' }).click()
  await choose(p, 'Constitution')
  await poll(p, () => document.querySelector('.ws-reader')?.dataset.wsThemeName === 'laboratory-paper')
  const theme = await p.locator('.ws-reader').getAttribute('data-ws-theme')
  const source = await p.locator(`style[data-ws-theme-sheet="${theme}"]`).textContent()
  assert.ok(source.length > 100, 'the bundled base remains present')
  assert.ok(!source.includes('broken css'))
  assert.ok(await selected(p).locator('.ws-prose').isVisible())
})

test('Act zone stops broad button rules and resets theme fonts, sizes and pigments', async p => {
  await open(p); await choose(p, 'Chat')
  await poll(p, () => getComputedStyle(document.querySelector('.ws-reader')).getPropertyValue('--ws-custom-ready').trim() === '1')
  await choose(p, 'Constitution')
  assert.equal(await selected(p).locator('.ws-prose-body').evaluate(body => {
    const probe = body.appendChild(document.createElement('button'))
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }), 'rgb(255, 0, 0)', 'the broad rule is active in the reading zone')
  await choose(p, 'Chat')
  const temper = selected(p).getByRole('button', { name: 'Temper', exact: true })
  const style = await temper.evaluate(el => ({ color: getComputedStyle(el).color, font: getComputedStyle(el).fontFamily, height: getComputedStyle(el).getPropertyValue('--ws-control-height').trim(), agent: getComputedStyle(el).getPropertyValue('--ws-agent').trim(), transform: getComputedStyle(el).textTransform, pigment: getComputedStyle(el).getPropertyValue('--kbn-agent').trim(), mono: getComputedStyle(el).getPropertyValue('--font-mono').trim() }))
  assert.notEqual(style.color, 'rgb(255, 0, 0)', 'button { color: red } cannot reach Temper')
  assert.ok(!style.font.includes('fantasy'))
  assert.equal(style.height, '32px')
  assert.notEqual(style.agent, 'red')
  assert.equal(style.transform, 'none', 'inherited theme typography also stops at the act zone')
  assert.notEqual(style.pigment, 'red', 'theme aliases cannot change a control pigment')
  assert.ok(!style.mono.includes('fantasy'), 'theme aliases cannot change a control font')
  assert.equal(await selected(p).locator('.ws-dock').getAttribute('data-part'), 'act')
}, { width: 1379, height: 900 })

// Appearance is chosen in the Settings sheet; this browser keeps it.
async function chooseAppearance(p, mode, dark) {
  await p.locator('.kbn-viewtabs-settings').click()
  await p.getByRole('button', { name: 'Appearance', exact: true }).click()
  await p.locator(`input[name="appearance-mode"][value="${mode}"]`).check()
  if (dark) await p.locator(`input[name="appearance-dark"][value="${dark}"]`).check()
  await p.getByRole('button', { name: 'Done', exact: true }).click()
  await poll(p, mode => mode === 'system' || document.documentElement.dataset.wsAppearance === mode, mode)
}

for (const [label, theme] of [['Night Chart', 'night-chart'], ['Lamplight', 'lamplight']]) test(`${label} text and protected control pigments meet AA on dark paper`, async p => {
  // Remote covariance review declares Night Chart: a dark system shows it, and a Lamplight choice leaves a declared dark theme alone.
  await p.emulateMedia({ colorScheme: 'dark' })
  if (theme === 'lamplight') await chooseAppearance(p, 'dark', 'lamplight')
  await p.locator('.kbn-card').filter({ hasText: theme === 'lamplight' ? name : 'Remote covariance review' }).click()
  await choose(p, 'Chat')
  await poll(p, theme => document.querySelector('.ws-reader')?.dataset.wsThemeName === theme, theme)
  const contrasts = await selected(p).evaluate(page => {
    const band = page.querySelector('.ws-dock')
    const error = document.createElement('span')
    error.className = 'kbn-detail-error'; error.textContent = 'Fixture error'
    band.append(error)
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')
    const rgb = color => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3) }
    const luminance = color => rgb(color).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0)
    const paper = luminance(getComputedStyle(band).getPropertyValue('--ws-paper'))
    const result = [...page.querySelectorAll('.ws-prose h1,.ws-prose-body p,.ws-prose-status,.ws-labelbar,.kbn-ctl-agent,.kbn-card-worker,.kbn-detail-error')].map(el => {
      const ink = luminance(getComputedStyle(el).color)
      return { part: el.className || el.tagName, ratio: (Math.max(ink, paper) + .05) / (Math.min(ink, paper) + .05) }
    })
    error.remove()
    return result
  })
  for (const { part, ratio } of contrasts) assert.ok(ratio >= 4.5, `${part}: ${ratio.toFixed(2)}:1`)
  console.log(`CONTRAST ${label} ${Math.min(...contrasts.map(c => c.ratio)).toFixed(2)}:1 minimum across ${contrasts.length} text samples`)
})

test('Appearance gives declared themes way, and embedded reports read their frame\'s scheme', async p => {
  // No emulated scheme: the frames' color-scheme alone decides what the report's media query sees.
  await p.emulateMedia({ colorScheme: null })
  const readerTheme = () => p.locator('.ws-reader').getAttribute('data-ws-theme-name')
  const reportLook = async () => {
    if (!await selected(p).count()) await p.locator('.ws-overview-folio').filter({ hasText: name }).click()
    const frame = await reportReady(p)
    const scheme = await frame.evaluate(el => getComputedStyle(el).colorScheme)
    const inside = await (await frame.elementHandle()).contentFrame()
    return { scheme, dark: await inside.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), paper: await inside.evaluate(() => getComputedStyle(document.body).backgroundColor) }
  }
  await chooseAppearance(p, 'dark', 'lamplight')
  await open(p)
  assert.equal(await readerTheme(), 'lamplight', 'a light declared theme gives way to the dark choice')
  assert.deepEqual(await reportLook(), { scheme: 'dark', dark: true, paper: 'rgb(22, 24, 29)' })
  const thumbLook = async () => {
    if (await selected(p).count()) await leave(p)
    await barTab(p, 'shelf').click()
    const thumb = p.locator('.ws-overview-folio').filter({ hasText: name }).locator('iframe[sandbox=""]').first()
    await thumb.waitFor({ state: 'attached' })
    const inside = await (await thumb.elementHandle()).contentFrame()
    return [await thumb.evaluate(el => getComputedStyle(el).colorScheme), await inside.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)]
  }
  assert.deepEqual(await thumbLook(), ['dark', true], 'report thumbnails follow')
  await chooseAppearance(p, 'light')
  assert.deepEqual(await reportLook(), { scheme: 'light', dark: false, paper: 'rgba(0, 0, 0, 0)' })
  assert.equal(await readerTheme(), 'portolan')
  assert.deepEqual(await thumbLook(), ['light', false])
  await reportLook()
  await p.reload()
  await poll(p, () => document.querySelector('.ws-reader')?.dataset.wsThemeName === 'portolan')
  assert.equal(await p.evaluate(() => document.documentElement.dataset.wsAppearance), 'light', 'the choice survives a reload')
})

test('Overview and sidebar never fan out theme.css probes; folios reuse the reader ETag cache', async p => {
  const themeReads = async () => (await records(p)).filter(r => r.url.includes('/api/v1/file?') && decodeURIComponent(r.url).includes('/theme.css'))
  await p.locator('[data-view="shelf"]').click()
  await p.locator('.ws-overview-folio').first().waitFor()
  await p.waitForTimeout(100)
  assert.equal((await themeReads()).length, 0, 'cold overview uses bundled themes only')
  await p.locator('.ws-overview-folio').filter({ hasText: name }).click()
  await poll(p, () => getComputedStyle(document.querySelector('.ws-reader')).getPropertyValue('--ws-custom-ready').trim() === '1')
  assert.equal((await themeReads()).length, 1, 'only the open reader loads custom CSS')
  await p.clock.fastForward(16000)
  await poll(p, () => window.__harness.requests.some(r => decodeURIComponent(r.url).includes('calibration-report/theme.css') && r.headers?.['if-none-match']))
  const count = (await themeReads()).length
  await leave(p)
  await p.locator('.ws-overview-folio').first().waitFor()
  await p.clock.fastForward(16000)
  assert.equal((await themeReads()).length, count, 'overview does not revalidate any custom theme')
  assert.equal(await p.locator('.ws-overview-folio').filter({ hasText: name }).evaluate(el => getComputedStyle(el).getPropertyValue('--ws-custom-ready').trim()), '1', 'reader-loaded theme survives on the folio')
})

test('Theme refresh uses ETag on the ordinary cadence, not on selection frames', async p => {
  await open(p); await choose(p, 'Constitution')
  await poll(p, () => getComputedStyle(document.querySelector('.ws-reader')).getPropertyValue('--ws-custom-ready').trim() === '1')
  const reads = async () => (await records(p)).filter(r => r.url.includes('/api/v1/file?') && decodeURIComponent(r.url).includes('calibration-report/theme.css'))
  const count = (await reads()).length
  await choose(p, 'brief.md'); await choose(p, 'Constitution')
  assert.equal((await reads()).length, count)
  await p.clock.fastForward(16000)
  await poll(p, () => window.__harness.requests.some(r => decodeURIComponent(r.url).includes('calibration-report/theme.css') && r.headers?.['if-none-match']))
  assert.ok((await reads()).at(-1).headers['if-none-match'])
})

test('Nested sidebar cards reset foreign variables, including cards in Plain', async p => {
  await open(p); await choose(p, 'Constitution')
  await poll(p, () => getComputedStyle(document.querySelector('.ws-reader')).getPropertyValue('--ws-custom-ready').trim() === '1')
  const foreign = p.locator('[data-part="sidebar-card"]').filter({ hasText: 'Mask validation notes' })
  await foreign.waitFor()
  assert.equal(await foreign.getAttribute('data-ws-theme'), null, 'sidebar cards keep neutral paper')
  const own = p.locator('[data-part="sidebar-card"]').filter({ hasText: name })
  assert.equal(await own.getAttribute('data-ws-theme'), null, 'the current sidebar card is neutral too')
  const assertNeutral = async () => {
    const values = await foreign.evaluate(el => {
      const s = getComputedStyle(el)
      return { ready: s.getPropertyValue('--ws-custom-ready').trim(), after: s.getPropertyValue('--ws-after-nested').trim(), mono: s.getPropertyValue('--font-mono').trim(), transform: s.textTransform, height: s.getPropertyValue('--ws-control-height').trim() }
    })
    assert.equal(values.ready, '', 'unknown custom variables stop at the nested boundary')
    assert.equal(values.after, '')
    assert.ok(!values.mono.includes('fantasy'))
    assert.equal(values.transform, 'none')
    assert.equal(values.height, '32px')
  }
  await assertNeutral()
  await foreign.click(); await choose(p, 'Constitution')
  const plain = await openPlainThemeMenu(p)
  await plain.click()
  assert.equal(await foreign.getAttribute('data-ws-theme'), null)
  assert.ok(await foreign.getAttribute('data-ws-theme-boundary') !== null)
  await p.locator('.ws-sidebar').getByRole('button', { name, exact: true }).click()
  await choose(p, 'Constitution')
  await poll(p, () => getComputedStyle(document.querySelector('.ws-reader')).getPropertyValue('--ws-custom-ready').trim() === '1')
  await assertNeutral()
}, { width: 1379, height: 900 }, 'true')

test('Protected verdict plate and its undo line hold without author CSS', async p => {
  await open(p)
  await poll(p, () => getComputedStyle(document.querySelector('.ws-reader')).getPropertyValue('--ws-custom-ready').trim() === '1')
  await choose(p, 'Chat')
  const plate = selected(p).locator('.ws-chat-acts')
  assert.equal(await plate.evaluate(el => el.closest('[data-part="act"]')?.dataset.act), 'verdict')
  assert.notEqual(await plate.getByRole('button', { name: 'Temper', exact: true }).evaluate(el => getComputedStyle(el).color), 'rgb(255, 0, 0)')
  await appFocus(p); await p.keyboard.press('t')
  const undo = plate.locator('.ws-verdict-undo button')
  await undo.waitFor()
  assert.ok(!await undo.evaluate(el => getComputedStyle(el).fontFamily.includes('fantasy')))
  await p.keyboard.press('z')
}, { width: 1379, height: 900 })

test('Theme changes repaint paused audio without replacing the player or fetching bytes', async p => {
  await open(p); await choose(p, 'tone.mp3')
  const wave = selected(p).locator('[data-part="audio-waveform"]')
  await poll(p, () => document.querySelector('.ws-selected .ws-audio-page')?.dataset.waveform === 'decoded')
  await p.evaluate(() => { window.__themedAudio = document.querySelector('.ws-selected audio') })
  const pixel = async () => wave.evaluate(canvas => {
    const probe = document.createElement('canvas'); probe.width = probe.height = 1
    const ctx = probe.getContext('2d'); ctx.fillStyle = getComputedStyle(canvas).color; ctx.fillRect(0, 0, 1, 1)
    return { ink: [...ctx.getImageData(0, 0, 1, 1).data], drawn: [...canvas.getContext('2d').getImageData(0, Math.floor(canvas.height / 2), 1, 1).data] }
  })
  const before = await pixel(); assert.deepEqual(before.drawn, before.ink)
  const reads = (await records(p)).filter(r => decodeURIComponent(r.url).includes('tone.mp3')).length
  const plain = await openPlainThemeMenu(p); await plain.click()
  await p.clock.runFor(80)
  const after = await pixel(); assert.deepEqual(after.drawn, after.ink); assert.notDeepEqual(after.ink, before.ink)
  assert.ok(await p.evaluate(() => document.querySelector('.ws-selected audio') === window.__themedAudio && window.__themedAudio.paused && window.__themedAudio.currentTime === 0))
  assert.equal((await records(p)).filter(r => decodeURIComponent(r.url).includes('tone.mp3')).length, reads)
})

for (const theme of ['portolan', 'blueprint', 'laboratory-paper', 'night-chart']) {
  test(`Theme phone paper stays edge to edge with styled bars and page sheet: ${theme}`, async p => {
    const themed = new URL(url); themed.searchParams.set('theme-preview', `01KVBR1F9BWBVKF97473PV67K8:${theme}`)
    await p.goto(themed.href); await open(p); await choose(p, 'Constitution')
    const frame = selected(p).locator('[data-part="page-frame"]')
    const box = await frame.boundingBox()
    assert.ok(Math.abs(box.x) < 1 && Math.abs(box.width - 390) < 1)
    assert.deepEqual(await frame.evaluate(el => { const s = getComputedStyle(el); return [s.borderRadius, s.clipPath, s.boxShadow, s.borderTopWidth] }), ['0px', 'none', 'none', '0px'])
    assert.ok(await p.locator('[data-part="phone-topbar"]').isVisible())
    await choose(p, 'Chat')
    await p.locator('.ws-rail-toggle').click()
    assert.ok(await p.locator('[data-part="page-sheet-panel"]').isVisible())
    assert.ok(await p.locator('[data-part="page-sheet-row"]').count() > 1)
    assert.equal(await p.locator('[data-part="page-sheet-panel"]').evaluate(el => getComputedStyle(el).getPropertyValue('--ws-paper').trim()), await p.locator('.ws-reader').evaluate(el => getComputedStyle(el).getPropertyValue('--ws-paper').trim()))
  }, { width: 390, height: 844 })
}

// Nothing moves when you touch it (design.md, "Motion, input and focus"). Each
// step records every visible box, applies one interaction, and fails on any
// box that moved or resized beyond 0.5 px outside the touched control and its
// intended dependants. A new surface joins these before it lands.
async function still(p, label, act, { allow = [], ...options } = {}) {
  const shifts = await layoutShift(p, { regions: ['body'], act, allow, ...options })
  assert.deepEqual(shifts, [], `${label} moved something: ${JSON.stringify(shifts, null, 1)}`)
}
async function repaint(p) {
  try {
    await p.evaluate(() => {
      // Keep the refresh reachable while CDP observes its completion across GC.
      const state = window.__harness.pendingRefresh = { pending: window.__harness.modal.fetchAndRender(), done: false, error: null }
      state.pending.then(() => { state.done = true }, error => {
        state.error = { name: error?.name ?? 'Error', message: error?.message ?? String(error), stack: error?.stack }
        state.done = true
      })
    })
    await p.waitForFunction(() => window.__harness.pendingRefresh?.done, undefined, { timeout: 15000 })
    const failure = await p.evaluate(() => window.__harness.pendingRefresh.error)
    if (failure) throw Object.assign(new Error(failure.message), failure)
  } finally {
    await p.evaluate(() => { delete window.__harness.pendingRefresh })
  }
}
async function flipWorker(p) {
  await p.evaluate(() => {
    const row = window.__harness.MOCK_FEED.fibers.find(row => row.fiber.name === 'Remote covariance review')
    row.runtime.phase = row.runtime.phase === 'waiting' ? 'working' : 'waiting'
    row.runtime.last_activity_at = Date.now() - 120000
  })
  await repaint(p)
}

// `r` focuses the composer where it stands; a field out of view scrolls its
// page only as far as its top, so the kicker stays whole.
async function composerKeyStaysPut(p) {
  await choose(p, 'Chat')
  const field = selected(p).locator('.kbn-detail-directive'), scroll = selected(p).locator('.ws-transcript-scroll')
  await field.focus(); await field.evaluate(el => el.blur())
  const before = await field.boundingBox()
  const y = await scroll.evaluate(el => { el.scrollTop = 100; return el.scrollTop })
  await appFocus(p); await p.keyboard.press('r'); await frames(p)
  assert.ok(await field.evaluate(el => el === document.activeElement))
  assert.deepEqual(await field.boundingBox(), before, 'r focuses the pinned composer without moving it')
  assert.equal(await scroll.evaluate(el => el.scrollTop), y, 'r does not move the transcript reading point')
  assert.ok(await selected(p).locator('.ws-chat-head').evaluate(el => el.getBoundingClientRect().top >= 0))
}

for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['narrow', { width: 1000, height: 800 }], ['phone', { width: 390, height: 844 }]]) test(`Nothing moves when you touch the act zone (${device})`, async p => {
  const phone = device === 'phone'
  await open(p); await choose(p, 'Chat')
  const field = selected(p).locator('.kbn-detail-directive'), composer = selected(p).locator('.kbn-ctl-composer')
  const holds = ['.kbn-viewtabs', '.ws-selected .ws-chat-head']
  const fixed = async (label, act) => assert.deepEqual(unexpected(await layoutShift(p, { regions: holds, act })), [], label)
  await fixed('focusing the composer leaves the header and board bar still', () => field.click())
  await fixed('typing a word', () => p.keyboard.type('Rerun'))
  const before = await field.boundingBox(), bottom = await composer.boundingBox()
  await fixed('wrapping text leaves the header still', () => p.keyboard.type(' the masks with the corrected weights, then compare the null spectra at high ell against the previous run'))
  const grown = await field.boundingBox(), after = await composer.boundingBox()
  assert.ok(grown.height > before.height && Math.abs(grown.x - before.x) <= .5 && Math.abs(grown.width - before.width) <= .5, 'wrapping grows only the height of the field')
  assert.ok(Math.abs(bottom.y + bottom.height - after.y - after.height) <= .5, 'the pinned composer grows upwards from a fixed foot')
  assert.deepEqual(await composer.evaluate(el => {
    const text = el.querySelector('textarea').getBoundingClientRect(), foot = el.querySelector('.kbn-ctl-composer-foot').getBoundingClientRect(), box = el.getBoundingClientRect()
    return { full: box.width - text.width <= 12, below: foot.top >= text.bottom - .5 }
  }), { full: true, below: true })
  for (let i = 0; i < 5; i++) await fixed('deleting leaves the header still', () => p.keyboard.press('Backspace'))
  await field.fill(''); assert.equal((await field.boundingBox()).height, before.height)
  await fixed('blurring the composer', () => field.evaluate(el => el.blur()))
  if (!phone) await composerKeyStaysPut(p)
  await field.focus()
  const meetingMenu = selected(p).locator('.kbn-ctl-meet-more')
  await fixed('opening Meeting controls leaves the header still', () => meetingMenu.click())
  for (const state of ['on', 'off']) await fixed(`Meeting ${state} leaves the header still`, () => selected(p).locator('.kbn-ctl-meet-switch').click())
  await meetingMenu.click()
  await field.evaluate(el => el.blur())
  if (!phone) for (const control of ['.kbn-ctl-resume', '.kbn-ctl-secondary']) await still(p, `hovering ${control}`, () => selected(p).locator(control).hover(), { allow: [`.ws-selected ${control}`] })
  await still(p, 'a chat poll repaint', () => repaint(p))
  await chatMenu(p, 'Settings')
  if (!phone) {
    await still(p, 'opening the Effort list', () => selected(p).locator('select[aria-label="Effort"]').click(), { allow: ['.ws-select-picker'] })
    await p.keyboard.press('Escape')
  }
  await leave(p); await chooseDeskColumn(p, 1)
  await p.locator('.kbn-desk .kbn-card').filter({ hasText: 'Remote covariance review' }).click(); await choose(p, 'Chat')
  await still(p, 'a worker-state change', () => flipWorker(p), { allow: ['.ws-worker-control', '.ws-chat-state'], settle: 100 })
  assert.equal(await p.locator(':is(.ws-navbar, .kbn-viewtabs) :is(.kbn-ctl-temper,.kbn-ctl-discard)').count(), 0)
  if (phone) await headerAction(p, 'Settings')
  for (const control of ['.kbn-ctl-review', '.kbn-ctl-rest']) {
    assert.ok(await selected(p).locator(control).isVisible())
    if (!phone) await still(p, `hovering ${control}`, () => selected(p).locator(control).hover(), { allow: [`.ws-selected ${control}`] })
  }
  if (phone) { await p.keyboard.press('Escape'); await p.locator('.ws-page-sheet[open], .ws-settings-menu:not([hidden])').waitFor({ state: 'hidden' }) }
  const flightField = selected(p).locator('.kbn-detail-directive')
  await flightField.click()
  assert.deepEqual(unexpected(await layoutShift(p, { regions: ['.ws-selected .ws-chat-head'], act: () => p.keyboard.type(' compare the corrected masks at high ell against the previous run and the run before it') })), [], 'in-flight typing leaves the header as it is')
}, viewport)

for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['narrow', { width: 1000, height: 800 }]]) test(`Nothing moves when you touch the bar, label bar and sidebar (${device})`, async p => {
  await open(p); await reportReady(p)
  for (const control of ['.kbn-viewtab[data-view="desk"]', '.kbn-viewtab[data-view="chronicle"]', '.kbn-viewtab[data-view="shelf"]', '.kbn-viewtabs-find', '.kbn-viewtabs-settings', '.ws-sidebar-toggle:not(.ws-rail-toggle)', '.ws-selected .ws-expand-button']) {
    await still(p, `hovering ${control}`, () => p.locator(control).hover(), { allow: [control] })
  }
  await p.mouse.move(viewport.width / 2, viewport.height - 4)
  await still(p, 'opening the document menu', () => selected(p).locator('.ws-menu-button').click(), { allow: ['[popover]', '.ws-menu'] })
  await p.keyboard.press('Escape')
  await still(p, 'summoning Find', () => p.keyboard.press('/'), { allow: ['.kbn-viewtabs-find'] })
  assert.deepEqual(await layoutShift(p, { regions: ['.kbn-viewtabs', '.ws-reader'], act: () => p.keyboard.type('cal'), allow: ['.kbn-viewtabs-find'] }), [])
  await barFind(p).press('Escape')
  assert.deepEqual(unexpected(await layoutShift(p, { regions: ['.kbn-viewtabs'], act: () => choose(p, 'brief.md'), settle: 400 })), [], 'selecting a file holds the board bar')
  await still(p, 'a poll repaint', () => repaint(p), { regions: ['.kbn-viewtabs', '.ws-selected', '.ws-sidebar'] })
  await appFocus(p); await p.keyboard.press('Meta+Backslash'); await p.locator('.ws-sidebar .kbn-card').nth(1).waitFor(); await p.waitForTimeout(400)
  await still(p, 'hovering a sidebar card', () => p.locator('.ws-sidebar .kbn-card').nth(1).hover())
  await still(p, 'a sidebar poll repaint', () => repaint(p))
  await choose(p, 'calibration-report')
  assert.deepEqual(await layoutShift(p, { regions: ['.kbn-viewtabs', '.ws-selected'], act: async () => {
    await p.evaluate(() => {
      const row = window.__harness.MOCK_FEED.fibers.find(row => row.fiber.name === 'Calibrate the shear response')
      row.runtime = { state: 'running', phase: 'working', tmux_session: 'calibration-shuttle', last_activity_at: Date.now(), started_at: Date.now() - 60000 }
    })
    await repaint(p)
  }, settle: 100 }), [], 'a worker starting leaves the open report still')
  await composerKeyStaysPut(p); await fieldBlur(p)
  await still(p, 'hovering Settings', () => selected(p).locator('.ws-chat-settings').hover(), { allow: ['.ws-chat-settings'] })
  await still(p, 'a chat worker-state change', async () => {
    await p.evaluate(() => {
      const row = window.__harness.MOCK_FEED.fibers.find(row => row.fiber.name === 'Calibrate the shear response')
      row.runtime.phase = 'waiting'; row.runtime.last_activity_at = Date.now() - 120000
    })
    await repaint(p)
  }, { allow: ['.kbn-card-worker', '.ws-chat-state'], settle: 100 })
  await still(p, 'a sidebar worker-state change', () => flipWorker(p), { allow: ['.kbn-card-worker', '.ws-worker-control', '.ws-sidebar-index'], settle: 100 })
}, viewport)
async function fieldBlur(p) { await selected(p).locator('textarea').evaluate(el => el.blur()) }

for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) test(`Nothing moves when you touch the Desk and the Board (${device})`, async p => {
  const phone = device === 'phone'
  await p.waitForTimeout(phone ? 600 : 0)
  for (const [index, column] of ['drafts', 'inFlight', 'awaitingReview'].entries()) {
    await chooseDeskColumn(p, index)
    const card = p.locator(`[data-column="${column}"] .kbn-card`).first()
    if (phone) { await p.waitForTimeout(400); continue }
    // Under reduced motion a hovered card does not lift.
    await still(p, `hovering a ${column} card`, () => card.hover())
    await p.mouse.move(1, 1)
    await p.waitForTimeout(200)
  }
  if (!phone) await still(p, 'j selecting a card (the verdict reveal)', () => p.keyboard.press('j'))
  await still(p, 'a Desk poll repaint', () => repaint(p))
  // The pill's word takes its room from the end of its own row's title; the
  // title's start and every other row stay put.
  await still(p, 'a Desk worker-state change', () => flipWorker(p), { allow: ['.kbn-card-meta', '.kbn-card-name'], settle: 100 })
  if (phone) return
  await p.locator('[data-view="shelf"]').click()
  await p.locator('.ws-overview-folio').first().waitFor()
  await p.waitForTimeout(400)
  const folio = p.locator('.ws-overview-folio').first()
  const box = await folio.boundingBox()
  await still(p, 'hovering a folio', () => p.mouse.move(box.x + box.width / 2, box.y + box.height / 2), { allow: ['.ws-overview-folio:hover'], settle: 200 })
  await still(p, 'a Board poll repaint', () => repaint(p))
  await still(p, 'summoning Find', () => p.keyboard.press('/'))
}, viewport)

registerLivingReportJourneys(test)
registerHeaderBarJourneys(test)

const runnable = tests.filter(test => !process.env.E2E_ONLY || new RegExp(process.env.E2E_ONLY).test(test.name))
const started = performance.now()
let passed = 0
try {
  for (const { name, run, viewport, sidebarChoice, reducedMotion, touch } of runnable) {
    const context = await browser.newContext({ viewport: viewport ?? { width: 1440, height: 900 },
      hasTouch: !!touch || (!!viewport && viewport.width <= 700), isMobile: !!touch || (!!viewport && viewport.width <= 700),
      reducedMotion, locale: 'en-GB', timezoneId: 'Europe/Paris' })
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    page.setDefaultNavigationTimeout(30000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    let failure
    try {
      await page.clock.install({ time: new Date('2026-10-04T14:00:00Z') })
      if (sidebarChoice !== null) await page.addInitScript(choice => {
        if (window === window.top) localStorage.setItem('shuttle:workspace:sidebar', choice)
      }, sidebarChoice)
      await page.goto(url, { timeout: 15000 })
      await page.locator('.kbn-desk .kbn-card').filter({ hasText: 'Calibrate the shear response' }).waitFor({ state: 'attached', timeout: 15000 })
      await run(page)
    } catch (error) { failure = error; await mkdir(shots, { recursive: true }); await page.screenshot({ path: resolve(shots, 'failure-' + name.replace(/[^a-z0-9]+/gi, '-').slice(0, 100) + '.png') }).catch(() => {}) }
    finally {
      try { assert.deepEqual(errors, [], 'pageerror events') } catch (error) { failure = failure ? new AggregateError([failure, error]) : error }
      await context.close()
    }
    if (failure) console.error(`FAIL ${name}\n${failure.stack}\n${failure.errors?.map(error => error.stack).join('\n') ?? ''}`)
    else { passed++; console.log(`PASS ${name}`) }
  }
} finally { await browser.close() }
await mkdir(shots, { recursive: true })
await writeFile(resolve(shots, 'inventory.json'), JSON.stringify(inventory, null, 2))
console.log(`${passed} passed, ${runnable.length - passed} failed; ${((performance.now() - started) / 1000).toFixed(1)}s`)
if (passed !== runnable.length) process.exitCode = 1
