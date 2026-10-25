import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getBrowser } from './browser.mjs'

const title = 'Calibrate the shear response across independent sky patches and validate each redshift bin'
const url = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=threads&transcript=warm&long-title`
export function registerHeaderBarJourneys(test) {
  test('Header breakpoint crossings preserve visible focus and hand overflow focus to Settings', async page => {
    await page.addInitScript(() => {
      if (window !== window.top) return
      localStorage.setItem('shuttle:workspace:sidebar', 'false')
      localStorage.setItem('shuttle:workspace:rail', 'false')
    })
    await page.goto(url)
    await page.locator('.kbn-desk .kbn-card').filter({ hasText: title }).click()
    const header = page.locator('.ws-selected .ws-chat-head')
    const settings = header.getByRole('button', { name: 'Settings', exact: true })
    const resize = async (width, compact) => {
      await page.setViewportSize({ width, height: 900 })
      await page.waitForFunction(compact => document.querySelector('.ws-selected .ws-chat-head')?.dataset.compact === String(compact), compact)
    }
    const focused = locator => locator.evaluate(el => el === document.activeElement)
    await settings.focus()
    await resize(850, false)
    assert.ok(await focused(settings), 'Settings stays focused when lifecycle actions move away')
    await resize(1440, false)
    assert.ok(await focused(settings), 'Settings stays focused when lifecycle actions return')
    const temper = header.getByRole('button', { name: 'Temper', exact: true })
    await temper.focus()
    await resize(850, false)
    assert.ok(await focused(temper), 'desktop actions retain focus in narrow cards')
    await resize(1440, false)
    await header.getByRole('button', { name: 'Constitution', exact: true }).focus()
    await resize(390, true)
    await page.waitForFunction(() => !!document.querySelector('.ws-selected .ws-chat-drawer .ws-chat-constitution'))
    assert.ok(await focused(settings), 'a page icon moving into phone settings hands focus to Settings')
    await resize(1440, false)
    assert.ok(await focused(settings), 'the same Settings control retains focus on return to desktop')
  }, { width: 1440, height: 900 })
  test('Desktop title fits two lines down to a 701px viewport and short names keep the one-line height', async page => {
    await page.addInitScript(() => {
      if (window !== window.top) return
      localStorage.setItem('shuttle:workspace:sidebar', 'false')
      localStorage.setItem('shuttle:workspace:rail', 'false')
    })
    await page.goto(url)
    await page.locator('.kbn-desk .kbn-card').filter({ hasText: title }).click()
    const header = page.locator('.ws-selected .ws-chat-head')
    for (const width of [1440, 850, 701]) {
      await page.setViewportSize({ width, height: 900 })
      await page.waitForFunction(() => {
        const el = document.querySelector('.ws-selected h1')
        return el && el.scrollHeight <= el.clientHeight + 1
      })
      const geometry = await header.locator('h1').evaluate(el => ({ height: el.clientHeight, line: parseFloat(getComputedStyle(el).lineHeight), clamp: getComputedStyle(el).webkitLineClamp }))
      assert.equal(geometry.clamp, '2')
      assert.ok(geometry.height <= 2 * geometry.line + 7)
      for (const name of ['Rest', 'Temper', 'Discard']) assert.ok(await header.getByRole('button', { name, exact: true }).isVisible(), `${name} remains in the ${width}px header`)
      assert.equal(await page.locator('.ws-selected .ws-header-overflow .kbn-ctl-verdict').count(), 0)
    }
    // The family's active thread exercises Close as well as the verdicts.
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.getByRole('button', { name: 'Show threads', exact: true }).click()
    await page.locator('.ws-thread-rail [data-thread-details="working"] .kbn-thread-row').first().click()
    await header.getByRole('heading', { name: 'Response analysis', exact: true }).waitFor()
    for (const width of [1440, 701]) {
      await page.setViewportSize({ width, height: 900 })
      for (const name of ['Close', 'Rest', 'Temper', 'Discard']) assert.ok(await header.getByRole('button', { name, exact: true }).isVisible())
      const height = await header.evaluate(el => el.getBoundingClientRect().height)
      assert.ok(Math.abs(height - 60) <= 1, `short title keeps the 60px header at ${width}: ${height}`)
    }
  }, { width: 1440, height: 900 })
  test('Measured header stacking keeps the full title and verbs with open desktop columns', async page => {
    await page.addInitScript(() => {
      if (window !== window.top) return
      localStorage.setItem('shuttle:workspace:sidebar', 'false')
      localStorage.setItem('shuttle:workspace:rail', 'true')
    })
    await page.goto(url)
    await page.locator('.kbn-desk .kbn-card').filter({ hasText: title }).click()
    const header = page.locator('.ws-selected .ws-chat-head')
    const check = async () => {
      await page.waitForFunction(() => {
        const title = document.querySelector('.ws-selected .ws-chat-title')
        return title && title.clientWidth > 0 && title.scrollHeight <= title.clientHeight + 1
      })
      assert.ok(await header.locator('h1').evaluate(el => el.clientHeight <= 2 * parseFloat(getComputedStyle(el).lineHeight) + 7))
      for (const name of ['Rest', 'Temper', 'Discard']) {
        const verb = header.getByRole('button', { name, exact: true })
        assert.ok(await verb.isVisible())
        assert.ok(await verb.evaluate(el => {
          const b = el.getBoundingClientRect(), h = el.closest('header').getBoundingClientRect()
          return b.left >= h.left && b.right <= h.right && b.top >= h.top && b.bottom <= h.bottom
        }), `${name} fits inside the header`)
      }
    }
    for (const width of [1440, 850, 701, 1440]) {
      await page.setViewportSize({ width, height: 900 }); await check()
      await page.waitForFunction(stacked => document.querySelector('.ws-selected .ws-chat-head').dataset.stacked === String(stacked), width < 1000)
      if (process.env.WORKSPACE_SHOTS && width === 701) await page.screenshot({ path: resolve(process.env.WORKSPACE_SHOTS, 'header-rail-open-narrow-desktop-light.png') })
    }
    await page.locator('.ws-sidebar-toggle:not(.ws-rail-toggle)').click()
    for (const width of [1440, 1000, 850, 701]) {
      await page.setViewportSize({ width, height: 900 }); await check()
      for (const selector of ['.ws-sidebar', '.ws-thread-rail']) {
        assert.ok(await page.locator(selector).isVisible())
        assert.ok(await page.locator(selector).evaluate(el => el.getBoundingClientRect().width >= 100), `${selector} keeps usable rows beside the minimum chat card`)
      }
      if (process.env.WORKSPACE_SHOTS && width === 701) await page.screenshot({ path: resolve(process.env.WORKSPACE_SHOTS, 'header-both-columns-narrow-desktop-light.png') })
    }
  }, { width: 1440, height: 900 })
  for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    for (const scheme of ['light', 'dark']) test(`Root heads the family at every depth (${device}, ${scheme})`, async page => {
      await page.addInitScript(scheme => {
        if (window !== window.top) return
        localStorage.setItem('shuttle.appearance', JSON.stringify({ mode: scheme, dark: 'night-chart' }))
        localStorage.setItem('shuttle:workspace:sidebar', 'false')
        localStorage.setItem('shuttle:workspace:rail', 'true')
      }, scheme)
      await page.goto(url)
      await page.locator('.kbn-desk .kbn-card').filter({ hasText: title }).click()
      const header = page.locator('.ws-selected .ws-chat-head')
      const family = page.locator(device === 'phone' ? '.ws-page-sheet[open] .ws-phone-threads' : '.ws-thread-rail .ws-thread-tree')
      const show = async () => { if (device === 'phone') await header.getByRole('button', { name: 'Settings', exact: true }).click() }
      const first = () => family.locator(':scope > *').first()
      const rootButton = () => device === 'phone' ? first() : first().locator('.kbn-thread-row')
      for (const name of ['Response analysis', 'Choose the response cut']) {
        await show()
        await family.locator('.kbn-thread-row').filter({ hasText: name }).click()
        await header.getByRole('heading', { name, exact: true }).waitFor()
        await show()
        assert.equal(await first().locator('.kbn-thread-name').innerText(), title)
        assert.ok(await first().locator('.constitution-state-dot').isVisible())
        if (process.env.WORKSPACE_SHOTS && name === 'Choose the response cut') {
          await mkdir(process.env.WORKSPACE_SHOTS, { recursive: true })
          await page.screenshot({ path: resolve(process.env.WORKSPACE_SHOTS, `family-${device}-${scheme}.png`) })
        }
        await rootButton().click()
        await header.getByRole('heading', { name: title, exact: true }).waitFor()
        await show()
        assert.equal(await rootButton().getAttribute('aria-current'), 'page')
        if (device === 'phone') await page.getByRole('button', { name: 'Close settings', exact: true }).click()
      }
    }, viewport)
    for (const scheme of ['light', 'dark']) test(`One header bar (${device}, ${scheme}): long name, immediate icons and unified settings`, async page => {
      await page.emulateMedia({ colorScheme: scheme })
      await page.addInitScript(scheme => {
        if (window !== window.top) return
        localStorage.setItem('shuttle.appearance', JSON.stringify({ mode: scheme, dark: 'night-chart' }))
        localStorage.setItem('shuttle:workspace:sidebar', 'false')
        localStorage.setItem('shuttle:workspace:rail', 'false')
      }, scheme)
      await page.goto(url)
      await page.locator('.kbn-desk .kbn-card').filter({ hasText: title }).click()
      const chat = page.locator('.ws-page.ws-selected')
      const header = chat.locator('.ws-chat-head')
      await chat.locator('.ws-transcript-context:not([hidden])').waitFor()
      await header.locator('.ws-report-chip .ws-thumbnail').waitFor()
      assert.equal(title.length, 90)
      assert.equal(await header.locator('h1').getAttribute('title'), title)
      const geometry = await header.evaluate(el => {
        const box = el.getBoundingClientRect(), title = el.querySelector('h1'), name = title.getBoundingClientRect()
        const style = getComputedStyle(title)
        return { barHeight: box.height, titleHeight: name.height, titleWidth: name.width, lineHeight: parseFloat(style.lineHeight),
          nowrap: style.whiteSpace, ellipsis: style.textOverflow, left: box.left, right: box.right,
          childrenInside: [...el.children].filter(child => child.checkVisibility()).every(child => {
            const r = child.getBoundingClientRect(); return r.top >= box.top && r.bottom <= box.bottom && r.left >= box.left && r.right <= box.right
          }) }
      })
      assert.notEqual(geometry.nowrap, 'nowrap')
      assert.ok(geometry.titleHeight <= geometry.lineHeight * 2 + 7, JSON.stringify(geometry))
      if (device === 'desktop') assert.ok(await header.locator('h1').evaluate(el => el.scrollHeight <= el.clientHeight + 1), 'the full title fits, not only the clamped box')
      assert.ok(geometry.barHeight <= 90 && geometry.childrenInside, JSON.stringify(geometry))
      assert.ok(geometry.left >= 0 && geometry.right <= viewport.width, JSON.stringify(geometry))
      const report = header.locator('.ws-report-chip')
      const reportTitle = await report.getAttribute('title')
      assert.ok(reportTitle?.length)
      assert.equal(await report.getAttribute('aria-label'), `Read report: ${reportTitle}`)
      assert.equal(await report.locator('.ws-report-title').count(), 0)
      assert.equal(await report.evaluate(el => [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim()).length), 0, 'the chip has no text label')
      if (device === 'phone') {
        assert.ok(geometry.titleWidth >= 125, 'the constitution name gets the width recovered from the report title: ' + JSON.stringify(geometry))
        const target = await report.boundingBox()
        assert.ok(target.width >= 44 && target.height >= 44, 'the thumbnail remains a 44px touch target')
      }
      assert.equal(await chat.locator('.ws-report-inset, .ws-chat-outcome, .ws-transcript-find, .ws-header-sheet').count(), 0)
      assert.equal(await header.locator('.ws-transcript-share, .ws-transcript-hit').count(), 0)
      assert.match(await header.locator('.ws-transcript-context').getAttribute('title'), /tokens of a .*window \(\d+% full\)/)
      assert.match(await header.locator('.ws-transcript-cache').getAttribute('title'), /Cache warm until/)
      for (const label of device === 'desktop' ? ['Constitution', 'Settings', 'Temper', 'Discard'] : ['Settings']) {
        const icon = header.getByRole('button', { name: label, exact: true })
        assert.equal(await icon.getAttribute('title'), label)
        assert.deepEqual(await icon.evaluate(el => {
          const svg = el.querySelector('svg'), box = svg?.getBoundingClientRect(), css = svg && getComputedStyle(svg)
          return { viewBox: svg?.getAttribute('viewBox'), inheritsColor: css?.stroke === getComputedStyle(el).color, width: box?.width, height: box?.height, weight: css?.strokeWidth }
        }), { viewBox: '0 0 16 16', inheritsColor: true, width: 16, height: 16, weight: '1.5px' }, `${label} uses the same currentColor stroke grid in ${scheme}`)
        await icon.focus(); assert.equal(await icon.evaluate(el => el === document.activeElement), true)
      }
      const centers = await header.locator('.ws-header-icon:visible svg').evaluateAll(svgs => svgs.map(svg => { const box = svg.getBoundingClientRect(); return box.top + box.height / 2 }))
      assert.ok(centers.length >= 1 && Math.max(...centers) - Math.min(...centers) < 1, `header icons share one vertical center in ${device}/${scheme}: ${centers}`)
      await chat.locator('textarea').focus(); await chat.locator('textarea').blur()
      if (process.env.WORKSPACE_SHOTS) {
        await mkdir(process.env.WORKSPACE_SHOTS, { recursive: true })
        await page.screenshot({ path: resolve(process.env.WORKSPACE_SHOTS, `header-${device}-${scheme}.png`) })
        if (device === 'desktop' && scheme === 'light') {
          const variant = await page.addStyleTag({ content: `.ws-chat-head { display: grid; grid-template-columns: 12px minmax(0, 1fr); gap: 6px 10px; min-height: 100px; } .ws-chat-identity { display: contents; } .ws-chat-title { grid-column: 2; grid-row: 1; } .ws-chat-state { grid-column: 2; grid-row: 2; align-self: center; } .ws-chat .ws-transcript-meter { grid-column: 2; grid-row: 2; margin-left: 80px; align-self: center; } .ws-chat-acts { grid-column: 2; grid-row: 2; justify-self: end; }` })
          await page.screenshot({ path: resolve(process.env.WORKSPACE_SHOTS, 'alternative-two-row-desktop-light.png') })
          await variant.evaluate(el => el.remove())
        }
      }
      await header.getByRole('button', { name: 'Settings', exact: true }).click()
      const sheet = page.getByRole('dialog', { name: 'Settings', exact: true })
      await sheet.waitFor()
      assert.ok(await sheet.locator('.kbn-ctl-history').count())
      assert.ok(await sheet.locator('.ws-sent-file time').count())
      assert.ok(await sheet.locator('.ws-transcript-hit:not([hidden])').count())
      assert.match(await sheet.locator('.ws-transcript-hit').innerText(), /% cached/)
      if (device === 'phone') {
        assert.ok(await sheet.getByRole('button', { name: 'Constitution', exact: true }).isVisible())
        assert.ok(await sheet.getByRole('button', { name: 'Temper', exact: true }).isVisible())
        assert.ok(await sheet.getByRole('button', { name: 'Discard', exact: true }).isVisible())
      }
      await sheet.getByRole('button', { name: 'Close settings', exact: true }).click()
      await sheet.waitFor({ state: 'hidden' })
      assert.equal(await header.getByRole('button', { name: 'Settings', exact: true }).evaluate(el => el === document.activeElement), true)
      // Overflow actions leave the modal before opening a confirmation or undo window.
      if (device === 'phone') await header.getByRole('button', { name: 'Settings', exact: true }).click()
      await chat.getByRole('button', { name: 'Rest', exact: true }).click()
      const rest = page.locator('.kbn-rest-popover')
      await rest.waitFor()
      assert.equal(await page.locator('.ws-page-sheet[open]').count(), 0)
      assert.equal(await rest.getAttribute('aria-modal'), 'true')
      assert.equal(await rest.evaluate(el => el.contains(document.activeElement)), true)
      await page.keyboard.press('Escape'); await rest.waitFor({ state: 'hidden' })
      if (device === 'phone') await header.getByRole('button', { name: 'Settings', exact: true }).click()
      await chat.getByRole('button', { name: 'Temper', exact: true }).click()
      const undo = header.getByRole('button', { name: `Undo verdict on ${title}`, exact: true })
      await undo.waitFor(); await undo.click()
      assert.equal(await header.locator('.ws-verdict-undo').count(), 0)
      assert.equal(await page.evaluate(() => window.__harness.requests.filter(r => r.method === 'POST' && r.url.includes('/transition')).length), 0)
    }, viewport)
  }
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  const cases = []; registerHeaderBarJourneys((...args) => cases.push(args))
  const browser = await getBrowser({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--allow-file-access-from-files'] })
  try {
    for (const [name, run, viewport] of cases) {
      const context = await browser.newContext({ viewport, isMobile: viewport.width <= 700, hasTouch: viewport.width <= 700, reducedMotion: 'reduce' })
      try { await run(await context.newPage()); console.log(`PASS ${name}`) } finally { await context.close() }
    }
  } finally { await browser.close() }
}
