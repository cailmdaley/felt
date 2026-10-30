import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getBrowser } from './browser.mjs'

const title = 'Calibrate the shear response across independent sky patches and validate each redshift bin'
const url = `${pathToFileURL(resolve('harness-board-dist/index.html')).href}?example=threads&transcript=warm&long-title`
async function openRoot(page) {
  // Click the row's own name: its crumb leads to the root with the rail forced open.
  const name = page.locator('.kbn-desk .kbn-card').filter({ hasText: title }).first().locator('.kbn-card-name')
  const box = await name.boundingBox()
  await name.click({ position: { x: box.width - 6, y: box.height / 2 } })
  const header = page.locator('.ws-selected .ws-chat-head')
  // A family's Desk row opens its frontier; these journeys exercise the root.
  for (let depth = 0; depth < 3 && await header.locator('h1').innerText() !== title; depth++) await header.locator('.ws-chat-back').click()
  await header.getByRole('heading', { name: title, exact: true }).waitFor()
}
const visibleHeaderVerbs = header => header.locator('.kbn-ctl-verdict button').evaluateAll(buttons =>
  buttons.filter(button => button.checkVisibility()).map(button => button.getAttribute('aria-label')))
export function registerHeaderBarJourneys(test) {
  test('Lifecycle state selects the header verbs while each card remains openable', async page => {
    await page.addInitScript(() => {
      if (window !== window.top) return
      localStorage.setItem('shuttle:workspace:sidebar', 'false')
      localStorage.setItem('shuttle:workspace:rail', 'true')
    })
    await page.goto(url)
    await openRoot(page)
    const header = page.locator('.ws-selected .ws-chat-head')
    assert.deepEqual(await visibleHeaderVerbs(header), ['Temper', 'Discard'], 'Awaiting review offers its verdicts')
    const visits = [
      ['Response analysis', ['Close for review', 'Rest']],
      ['Draft the validation plan', ['Launch', 'Rest']],
      ['Next validation', ['Resume', 'New session']],
      ['Accepted pilot', ['Resume', 'New session']],
      ['Discarded pilot', ['Resume', 'New session']],
    ]
    for (const [name, verbs] of visits) {
      if (name === 'Accepted pilot') await page.locator('.ws-thread-rail summary').filter({ hasText: 'Archived' }).click()
      await page.locator('.ws-thread-rail .kbn-thread-row').filter({ hasText: name }).click()
      await header.getByRole('heading', { name, exact: true }).waitFor()
      assert.deepEqual(await visibleHeaderVerbs(header), verbs, `${name} draws only its state actions`)
    }
  }, { width: 1000, height: 900 })
  test('Header breakpoint crossings preserve visible focus and hand overflow focus to Settings', async page => {
    await page.addInitScript(() => {
      if (window !== window.top) return
      localStorage.setItem('shuttle:workspace:sidebar', 'false')
      localStorage.setItem('shuttle:workspace:rail', 'false')
    })
    await page.goto(url)
    await openRoot(page)
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
    assert.ok(await focused(header.getByRole('button', { name: 'Constitution', exact: true })), 'Constitution retains focus beside Artifact on the phone')
    await settings.focus()
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
    await openRoot(page)
    const header = page.locator('.ws-selected .ws-chat-head')
    for (const width of [1440, 850, 701]) {
      await page.setViewportSize({ width, height: 900 })
      await page.waitForFunction(() => !!document.querySelector('.ws-selected h1'))
      const geometry = await header.locator('h1').evaluate(el => ({ height: el.clientHeight, line: parseFloat(getComputedStyle(el).lineHeight), clamp: getComputedStyle(el).webkitLineClamp }))
      assert.equal(geometry.clamp, '2')
      assert.ok(geometry.height <= 2 * geometry.line + 7)
      assert.equal(await header.locator('h1').getAttribute('title'), title)
      assert.deepEqual(await visibleHeaderVerbs(header), ['Temper', 'Discard'], `Awaiting review draws only its verbs at ${width}`)
      assert.equal(await page.locator('.ws-selected .ws-header-overflow .kbn-ctl-verdict').count(), 0)
    }
    // The family's active thread exercises Close as well as the verdicts.
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.getByRole('button', { name: 'Show threads and sent files', exact: true }).click()
    await page.locator('.ws-thread-rail [data-thread-details="working"] .kbn-thread-row').first().click()
    await header.getByRole('heading', { name: 'Response analysis', exact: true }).waitFor()
    for (const width of [1440, 701]) {
      await page.setViewportSize({ width, height: 900 })
      assert.deepEqual(await visibleHeaderVerbs(header), ['Close for review', 'Rest'], `In flight draws only its verbs at ${width}`)
      // Narrow cards reserve the title row for navigation and identity; references join the action row.
      const rows = await header.evaluate(el => {
        const box = sel => el.querySelector(sel)?.getBoundingClientRect() ?? null
        return { title: box('.ws-chat-title'), acts: box('.ws-chat-acts'), verbs: box('.kbn-ctl-verdict'), leave: box('.ws-chat-leave'), refs: box('.ws-chat-refs'), head: el.getBoundingClientRect() }
      })
      assert.ok(rows.verbs.top >= rows.title.bottom - 1, `verbs sit beneath the title at ${width}`)
      if (width === 701) {
        const centers = await header.locator('.ws-chat-acts > :not([hidden])').evaluateAll(els => els.filter(el => el.checkVisibility()).map(el => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 }))
        assert.ok(Math.max(...centers) - Math.min(...centers) < 1, `state, verbs and references share the action row: ${centers}`)
      }
      assert.ok(rows.leave.top < rows.title.bottom && rows.leave.bottom > rows.title.top, `× stays beside the title at ${width}`)
      assert.ok(rows.head.right - rows.leave.right < 80, `× ends the header at ${width}`)
      if (width <= 701) assert.ok(rows.refs.top >= rows.acts.top - 1, `Constitution and Artifact follow the actions at ${width}`)
      else assert.ok(rows.refs.top <= rows.title.top + 1 && rows.refs.bottom <= rows.acts.top + 1, `Constitution and Artifact are paired above the action row at ${width}`)
      const slack = { left: rows.acts.left, right: rows.acts.right }
      const line = await header.locator('.ws-chat-acts > :not([hidden])').evaluateAll(els => els.map(el => el.getBoundingClientRect()).filter(b => b.width))
      const left = Math.min(...line.map(b => b.left)) - slack.left
      assert.ok(Math.abs(left) <= 2, `the second line starts at the left (${left.toFixed(1)}) at ${width}`)
      assert.ok(Math.max(...line.map(b => b.right)) <= slack.right + 1, `actions stay within their row at ${width}`)
    }
  }, { width: 1440, height: 900 })
  test('The header keeps its clamped title and every verb inside open desktop columns', async page => {
    await page.addInitScript(() => {
      if (window !== window.top) return
      localStorage.setItem('shuttle:workspace:sidebar', 'false')
      localStorage.setItem('shuttle:workspace:rail', 'true')
    })
    await page.goto(url)
    await openRoot(page)
    const header = page.locator('.ws-selected .ws-chat-head')
    let labelSize
    const check = async () => {
      const sizes = await header.locator('.ws-chat-state, .kbn-ctl-verdict button:not([hidden]) .ws-header-word').evaluateAll(els => els.filter(el => el.checkVisibility()).map(el => parseFloat(getComputedStyle(el).fontSize)))
      labelSize ??= sizes[0]
      assert.ok(sizes.every(size => size === labelSize), `state and verbs retain the wide header text size: ${sizes}`)
      const controls = await header.evaluate(el => {
        const box = node => { const r = node.getBoundingClientRect(); return { center: r.top + r.height / 2, width: r.width, height: r.height } }
        return [box(el.querySelector('.ws-chat-back')), box(document.querySelector('.ws-sidebar-toggle:not(.ws-rail-toggle)'))]
      })
      assert.ok(Math.abs(controls[0].center - controls[1].center) < 1, `back and sidebar share a centerline: ${JSON.stringify(controls)}`)
      assert.equal(controls[0].width, controls[1].width)
      assert.equal(controls[0].height, controls[1].height)
      await page.waitForFunction(() => {
        const title = document.querySelector('.ws-selected .ws-chat-title')
        const header = title?.closest('header'), box = header?.getBoundingClientRect()
        return title && box && title.clientWidth > 0 &&
          [...header.querySelectorAll('.kbn-ctl-verdict button')].filter(button => button.checkVisibility()).every(button => {
            const b = button.getBoundingClientRect()
            return b.left >= box.left && b.right <= box.right && b.top >= box.top && b.bottom <= box.bottom
          })
      })
      assert.ok(await header.locator('h1').evaluate(el => el.clientHeight <= Number(getComputedStyle(el).webkitLineClamp) * parseFloat(getComputedStyle(el).lineHeight) + 7))
      const centers = await header.locator('.ws-chat-acts > :not([hidden])').evaluateAll(els => els.filter(el => el.checkVisibility()).map(el => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 }))
      assert.ok(Math.max(...centers) - Math.min(...centers) < 1, `state, verbs and references share the action row: ${centers}`)
      for (const name of ['Temper', 'Discard']) {
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
  test('The 390px phone header keeps state, lifecycle verbs, Settings, Constitution and Artifact visible together', async page => {
    await page.addInitScript(() => {
      if (window !== window.top) return
      localStorage.setItem('shuttle:workspace:sidebar', 'false')
      localStorage.setItem('shuttle:workspace:rail', 'false')
      localStorage.setItem('shuttle.appearance', JSON.stringify({ mode: 'light' }))
    })
    await page.goto(url)
    await openRoot(page)
    const header = page.locator('.ws-selected .ws-chat-head')
    const assertActions = async (expected, width = 390) => {
      assert.deepEqual(await visibleHeaderVerbs(header), expected)
      for (const selector of ['.ws-chat-standing', '.kbn-ctl-verdict', '.ws-chat-refs']) {
        const box = await header.locator(selector).boundingBox()
        assert.ok(box && box.width > 0 && box.x >= 0 && box.x + box.width <= width, `${selector} is visible within the phone header: ${JSON.stringify(box)}`)
        assert.ok(await header.locator(selector).evaluate(el => el.parentElement === el.closest('.ws-chat-head').querySelector('.ws-chat-acts')), `${selector} stays in the phone action row`)
      }
      const settings = header.locator('.ws-chat-settings')
      const settingsBox = await settings.boundingBox()
      assert.ok(settingsBox && settingsBox.x >= 0 && settingsBox.x + settingsBox.width <= width, `Settings stays available in the phone header: ${JSON.stringify(settingsBox)}`)
      assert.ok(await settings.evaluate(el => [el.closest('.ws-chat-head'), el.closest('.ws-chat-acts')].includes(el.parentElement)), 'Settings stays in one of its two header rows')
      const row = await header.locator('.ws-chat-acts').boundingBox()
      const centers = await header.locator('.ws-chat-acts > :not([hidden])').evaluateAll(els => els.filter(el => el.checkVisibility()).map(el => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 }))
      assert.ok(centers.length >= 3 && Math.max(...centers) - Math.min(...centers) < 1, `state verbs and references share row two: ${centers}`)
      assert.ok(row && row.x + row.width <= width)
    }
    await assertActions(['Temper', 'Discard'])
    await page.locator('.ws-rail-toggle').click()
    await page.locator('.ws-page-sheet[open] .ws-phone-threads .kbn-thread-row').filter({ hasText: 'Response analysis' }).click()
    await header.getByRole('heading', { name: 'Response analysis', exact: true }).waitFor()
    await assertActions(['Close for review', 'Rest'])
    const reviewInk = await header.getByRole('button', { name: 'Close for review', exact: true }).evaluate(el => {
      const plain = document.createElement('span')
      plain.style.color = 'var(--ws-ink)'
      el.parentElement.append(plain)
      const styles = getComputedStyle(el)
      const result = {
        pigment: styles.getPropertyValue('--verdict-pigment').trim(),
        ink: styles.getPropertyValue('--verdict-ink').trim(),
        color: styles.color,
        plain: getComputedStyle(plain).color,
      }
      plain.remove()
      return result
    })
    assert.ok(reviewInk.pigment && reviewInk.ink, `Close for review resolves both verdict colors: ${JSON.stringify(reviewInk)}`)
    assert.notEqual(reviewInk.color, reviewInk.plain, `Close for review uses its verdict ink rather than plain text ink: ${JSON.stringify(reviewInk)}`)
    await page.setViewportSize({ width: 320, height: 844 })
    await page.waitForFunction(() => document.querySelector('.ws-selected .ws-chat-head')?.dataset.compact === 'true')
    const settings = header.locator('.ws-chat-settings')
    const settingsLayout = await header.evaluate(el => {
      const actions = el.querySelector('.ws-chat-acts'), gear = el.querySelector('.ws-chat-settings')
      const box = node => { const rect = node.getBoundingClientRect(); return { parent: node.parentElement?.className, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width } }
      return { viewport: innerWidth, headerWidth: el.clientWidth, actionWidth: actions?.clientWidth, actionScrollWidth: actions?.scrollWidth, children: [...(actions?.children ?? [])].map(box), gear: gear && box(gear) }
    })
    assert.ok(await settings.evaluate(el => el.parentElement === el.closest('.ws-chat-head')), `Settings moves to the title row when Close for review and Rest exhaust the action row: ${JSON.stringify(settingsLayout)}`)
    const verbCenters = await header.locator('.kbn-ctl-verdict > button:not([hidden])').evaluateAll(buttons => buttons.map(button => { const box = button.getBoundingClientRect(); return box.top + box.height / 2 }))
    assert.ok(verbCenters.length === 2 && Math.max(...verbCenters) - Math.min(...verbCenters) < 1, `the lifecycle verbs stay on one row when Settings gives way: ${verbCenters}`)
    if (process.env.WORKSPACE_SHOTS) {
      await mkdir(process.env.WORKSPACE_SHOTS, { recursive: true })
      await page.screenshot({ path: resolve(process.env.WORKSPACE_SHOTS, 'gear-moved-320-light.png') })
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('.ws-rail-toggle').click()
    await page.locator('.ws-page-sheet[open] .ws-phone-threads .kbn-thread-row').filter({ hasText: 'Next validation' }).click()
    await header.getByRole('heading', { name: 'Next validation', exact: true }).waitFor()
    await assertActions(['Resume', 'New session'])
    if (process.env.WORKSPACE_SHOTS) {
      await mkdir(process.env.WORKSPACE_SHOTS, { recursive: true })
      await page.screenshot({ path: resolve(process.env.WORKSPACE_SHOTS, 'resting-seat-phone-light.png') })
    }
  }, { width: 390, height: 844 })
  test('Composer footer stays on one row and its Meeting menu fits at every width', async page => {
    await page.addInitScript(() => {
      if (window !== window.top) return
      localStorage.setItem('shuttle:workspace:sidebar', 'true')
      localStorage.setItem('shuttle:workspace:rail', 'true')
    })
    await page.goto(url); await openRoot(page)
    for (const width of [1440, 1000, 701, 390]) {
      await page.setViewportSize({ width, height: 900 })
      const composer = page.locator('.ws-selected .kbn-ctl-composer')
      const geometry = await composer.evaluate(el => {
        const rect = el.getBoundingClientRect()
        const controls = [...el.querySelectorAll('.kbn-ctl-meet-more, .kbn-ctl-sends > button')].filter(node => node.checkVisibility()).map(node => {
          const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, center: r.top + r.height / 2 }
        })
        return { left: rect.left, right: rect.right, controls }
      })
      assert.equal(geometry.controls.length, 3)
      assert.ok(geometry.controls.every(r => r.left >= geometry.left && r.right <= geometry.right), JSON.stringify(geometry))
      const centers = geometry.controls.map(r => r.center)
      assert.ok(Math.max(...centers) - Math.min(...centers) < 1, `one footer row at ${width}: ${centers}`)
      const more = composer.locator('.kbn-ctl-meet-more')
      await more.click()
      await composer.locator('.kbn-ctl-meet-switch input').check()
      const panel = await composer.locator('.kbn-ctl-meet-panel').boundingBox(), box = await composer.boundingBox()
      assert.ok(panel.x >= box.x && panel.x + panel.width <= box.x + box.width + 1, `Meeting menu fits its composer at ${width}`)
      await more.focus(); await page.keyboard.press('Escape')
      assert.ok(await composer.locator('.kbn-ctl-meet-overflow').evaluate(el => !el.open))
      assert.ok(await more.evaluate(el => document.activeElement === el))
      const armed = await composer.evaluate(el => {
        const box = el.getBoundingClientRect()
        const controls = [...el.querySelectorAll('.kbn-ctl-meet-more, .kbn-ctl-sends > button')].filter(node => node.checkVisibility()).map(node => node.getBoundingClientRect())
        return { fits: controls.every(r => r.left >= box.left && r.right <= box.right), centers: controls.map(r => r.top + r.height / 2), startVisible: el.querySelector('.kbn-ctl-meet-primary').checkVisibility(), armedChipHidden: el.querySelector('.kbn-ctl-meet-chip').hidden }
      })
      assert.ok(armed.startVisible && armed.armedChipHidden && armed.fits, `armed actions remain visible inside the composer at ${width}: ${JSON.stringify(armed)}`)
      const rows = new Set(armed.centers.map(center => Math.round(center)))
      assert.ok(rows.size <= 2, `armed footer uses at most two rows at ${width}: ${JSON.stringify(armed.centers)}`)
      await more.click(); await composer.locator('.kbn-ctl-meet-switch input').uncheck(); await more.click()
    }
  }, { width: 1440, height: 900 })
  test('A meeting started from the composer stays visible with Stop after closing its menu', async page => {
    await page.addInitScript(() => {
      if (window !== window.top) return
      localStorage.setItem('shuttle:workspace:sidebar', 'false')
      localStorage.setItem('shuttle:workspace:rail', 'false')
      localStorage.setItem('shuttle.appearance', JSON.stringify({ mode: 'light' }))
    })
    await page.goto(`${url}&meeting=idle`)
    await openRoot(page)
    const composer = page.locator('.ws-selected .kbn-ctl-composer')
    await composer.locator('.kbn-ctl-meet-more').click()
    await composer.getByRole('switch').check()
    await composer.getByRole('button', { name: 'Start meeting', exact: true }).click()
    const menu = composer.locator('.kbn-ctl-meet-overflow')
    await page.waitForFunction(() => document.querySelector('.kbn-detail-transcript-meta .kbn-detail-transcript-stop')?.checkVisibility())
    if (await menu.evaluate(el => el.open)) await menu.locator('summary').click()
    assert.equal(await menu.evaluate(el => el.open), false)
    const stop = page.locator('.ws-selected .kbn-detail-transcript-meta .kbn-detail-transcript-stop')
    await stop.waitFor({ state: 'visible' })
    assert.equal(await stop.innerText(), 'Stop')
    assert.ok(await page.locator('.ws-selected .kbn-detail-transcript').isVisible())
    const chip = composer.locator('.kbn-ctl-meet-chip')
    await chip.click()
    assert.ok(await page.locator('.ws-selected .kbn-detail-transcript').isHidden())
    const globalStop = composer.locator('.kbn-ctl-meet-stop')
    await globalStop.waitFor({ state: 'visible' })
    assert.equal(await globalStop.innerText(), 'Stop')
    await chip.click()
    assert.ok(await page.locator('.ws-selected .kbn-detail-transcript').isVisible())
    for (const width of [1440, 701, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      const chipStyle = await chip.evaluate(el => {
        const range = document.createRange()
        range.selectNodeContents(el)
        const style = getComputedStyle(el)
        const fragments = [...range.getClientRects()].map(rect => ({ top: rect.top, height: rect.height, left: rect.left, right: rect.right }))
        return {
          lines: new Set(fragments.map(rect => Math.round(rect.top * 2) / 2)).size,
          fragments,
          whiteSpace: style.whiteSpace,
          borderStyle: style.borderTopStyle,
          borderWidth: style.borderTopWidth,
          background: style.backgroundColor,
        }
      })
      assert.equal(chipStyle.whiteSpace, 'nowrap', `the meeting chip stays on one line at ${width}`)
      assert.ok(chipStyle.lines <= 1, `the meeting chip renders one line at ${width}: ${JSON.stringify(chipStyle)}`)
      assert.ok((chipStyle.borderStyle !== 'none' && chipStyle.borderWidth !== '0px') || chipStyle.background !== 'rgba(0, 0, 0, 0)', `the meeting chip has a button surface at ${width}: ${JSON.stringify(chipStyle)}`)
      const actions = page.locator('.ws-selected .ws-chat-acts')
      const geometry = await actions.evaluate(el => {
        const box = el.getBoundingClientRect()
        const children = [...el.children].filter(node => node.checkVisibility()).map(node => node.getBoundingClientRect())
        return { box: { left: box.left, right: box.right }, children }
      })
      assert.ok(geometry.children.every(box => box.left >= geometry.box.left - 1 && box.right <= geometry.box.right + 1), `actions fit at ${width}: ${JSON.stringify(geometry)}`)
      if (process.env.WORKSPACE_SHOTS) {
        await mkdir(process.env.WORKSPACE_SHOTS, { recursive: true })
        await page.screenshot({ path: resolve(process.env.WORKSPACE_SHOTS, `meeting-live-${width}-light.png`) })
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.locator('.ws-chat-leave').click()
    await page.locator('.kbn-desk .kbn-card').filter({ hasText: 'Remote covariance review' }).click()
    const foreignHeader = page.locator('.ws-selected .ws-chat-head')
    await foreignHeader.getByRole('heading', { name: 'Remote covariance review', exact: true }).waitFor()
    const foreignChip = page.locator('.ws-selected .kbn-ctl-meet-chip')
    await foreignChip.waitFor({ state: 'visible' })
    assert.equal(await foreignChip.innerText(), 'Recording · calibration-report')
    assert.equal(await page.locator('.ws-selected .kbn-ctl-meet-stop').innerText(), 'Stop')
    await foreignChip.click()
    await foreignHeader.getByRole('heading', { name: title, exact: true }).waitFor()
    assert.ok(await page.locator('.ws-selected .kbn-detail-transcript').isVisible(), 'the chip opens on the meeting host chat')
  }, { width: 1000, height: 900 })
  test('× leaves the chat for the Desk and writes nothing', async page => {
    await page.addInitScript(() => {
      if (window !== window.top) return
      localStorage.setItem('shuttle:workspace:sidebar', 'false')
      localStorage.setItem('shuttle:workspace:rail', 'false')
    })
    await page.goto(url)
    await openRoot(page)
    const header = page.locator('.ws-selected .ws-chat-head')
    await header.waitFor()
    const posts = () => page.evaluate(() => window.__harness.requests.filter(r => r.method !== 'GET').length)
    const before = await posts()
    await header.locator('.ws-chat-leave').click()
    await page.locator('.kbn-desk .kbn-card').filter({ hasText: title }).waitFor({ state: 'visible' })
    await header.waitFor({ state: 'hidden' })
    assert.equal(await posts(), before, '× sends no write')
  }, { width: 1440, height: 900 })
  test('Thread rows own Enter and Space while body focus keeps expand and paging shortcuts', async page => {
    await page.addInitScript(() => {
      if (window !== window.top) return
      localStorage.setItem('shuttle:workspace:sidebar', 'false')
      localStorage.setItem('shuttle:workspace:rail', 'true')
    })
    await page.goto(url)
    await openRoot(page)
    const header = page.locator('.ws-selected .ws-chat-head')
    const row = name => page.locator('.ws-thread-rail .kbn-thread-row').filter({ hasText: name })
    for (const key of ['Enter', 'Space']) {
      await row('Response analysis').focus(); await page.keyboard.press(key)
      await header.getByRole('heading', { name: 'Response analysis', exact: true }).waitFor()
      await row(title).focus(); await page.keyboard.press(key)
      await header.getByRole('heading', { name: title, exact: true }).waitFor()
    }
    await page.evaluate(() => { document.activeElement?.blur(); document.body.focus() })
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector('.ws-reader').classList.contains('ws-expand-mode'))
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => !document.querySelector('.ws-reader').classList.contains('ws-expand-mode'))
    await page.setViewportSize({ width: 1440, height: 400 })
    const log = page.locator('.ws-selected .ws-transcript-scroll')
    await page.waitForFunction(() => {
      const el = document.querySelector('.ws-selected .ws-transcript-scroll')
      return el.scrollHeight > el.clientHeight
    })
    await log.evaluate(el => { el.scrollTop = 0 })
    await page.keyboard.press('Space')
    await page.waitForFunction(() => document.querySelector('.ws-selected .ws-transcript-scroll').scrollTop > 0)
  }, { width: 1440, height: 900 })
  for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    for (const scheme of ['light', 'dark']) test(`The rail omits its open root and keeps it as the thread anchor (${device}, ${scheme})`, async page => {
      await page.addInitScript(scheme => {
        if (window !== window.top) return
        localStorage.setItem('shuttle.appearance', JSON.stringify({ mode: scheme, dark: 'night-chart' }))
        localStorage.setItem('shuttle:workspace:sidebar', 'false')
        localStorage.setItem('shuttle:workspace:rail', 'true')
      }, scheme)
      await page.goto(url)
      await openRoot(page)
      const header = page.locator('.ws-selected .ws-chat-head')
      const family = page.locator(device === 'phone' ? '.ws-page-sheet[open] .ws-phone-threads' : '.ws-thread-rail .ws-thread-tree')
      const show = async () => { if (device === 'phone') await page.locator('.ws-rail-toggle').click() }
      const rootAnchor = () => family.locator(device === 'phone' ? '.ws-phone-threads-root' : '.ws-thread-root')
      for (const name of ['Response analysis', 'Choose the response cut']) {
        await show()
        await family.locator('.kbn-thread-row').filter({ hasText: name }).click()
        await header.getByRole('heading', { name, exact: true }).waitFor()
        await show()
        assert.equal(await rootAnchor().count(), 1)
        assert.equal(await rootAnchor().locator('.kbn-thread-name').innerText(), title)
        assert.ok(await rootAnchor().locator('.constitution-state-dot').isVisible())
        if (process.env.WORKSPACE_SHOTS && name === 'Choose the response cut') {
          await mkdir(process.env.WORKSPACE_SHOTS, { recursive: true })
          await page.screenshot({ path: resolve(process.env.WORKSPACE_SHOTS, `family-${device}-${scheme}.png`) })
        }
        await rootAnchor().click()
        await header.getByRole('heading', { name: title, exact: true }).waitFor()
        await show()
        assert.equal(await rootAnchor().count(), 0)
        if (device === 'phone') await page.getByRole('button', { name: 'Close threads and files', exact: true }).click()
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
      await openRoot(page)
      const chat = page.locator('.ws-page.ws-selected')
      const header = chat.locator('.ws-chat-head')
      if (device === 'desktop') await chat.locator('.ws-transcript-context:not([hidden])').waitFor()
      else assert.ok(await header.locator('.ws-transcript-meter').evaluate(el => getComputedStyle(el).display === 'none'), 'the phone omits the transcript meter from its action row')
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
      assert.ok(geometry.barHeight <= (device === 'desktop' ? 130 : 110) && geometry.childrenInside, JSON.stringify(geometry))
      assert.ok(geometry.left >= 0 && geometry.right <= viewport.width, JSON.stringify(geometry))
      const report = header.locator('.ws-report-chip')
      const reportTitle = await report.getAttribute('title')
      assert.ok(reportTitle?.length)
      assert.equal(await report.getAttribute('aria-label'), `Read artifact: ${reportTitle}`)
      assert.equal(await report.locator('.ws-report-title').count(), 0)
      assert.equal(await report.locator('.ws-report-label').innerText(), 'Artifact')
      if (device === 'phone') {
        assert.ok(geometry.titleWidth >= 125, 'the constitution name gets the width recovered from the report title: ' + JSON.stringify(geometry))
        const target = await report.boundingBox()
        assert.ok(target.width >= 44 && target.height >= 44, 'the thumbnail remains a 44px touch target')
      }
      assert.equal(await chat.locator('.ws-report-inset, .ws-chat-outcome, .ws-transcript-find, .ws-header-sheet').count(), 0)
      assert.equal(await header.locator('.ws-transcript-share, .ws-transcript-hit').count(), 0)
      if (device === 'desktop') {
        assert.match(await header.locator('.ws-transcript-context').getAttribute('title'), /tokens of a .*window \(\d+% full\)/)
        assert.match(await header.locator('.ws-transcript-cache').getAttribute('title'), /Cache warm until/)
      }
      for (const label of device === 'desktop' ? ['Constitution', 'Settings', 'Temper', 'Discard'] : ['Settings']) {
        const icon = header.getByRole('button', { name: label, exact: true })
        assert.equal(await icon.getAttribute('title'), label)
        assert.deepEqual(await icon.evaluate(el => {
          const svg = el.querySelector('svg'), box = svg?.getBoundingClientRect(), css = svg && getComputedStyle(svg)
          return { viewBox: svg?.getAttribute('viewBox'), inheritsColor: css?.stroke === getComputedStyle(el).color, width: box?.width, height: box?.height, weight: css?.strokeWidth }
        }), { viewBox: '0 0 16 16', inheritsColor: true, width: 16, height: 16, weight: '1.5px' }, `${label} uses the same currentColor stroke grid in ${scheme}`)
        await icon.focus(); assert.equal(await icon.evaluate(el => el === document.activeElement), true)
      }
      if (device === 'desktop') {
        const centers = await header.locator('.ws-chat-acts .ws-header-icon:visible svg').evaluateAll(svgs => svgs.map(svg => { const box = svg.getBoundingClientRect(); return box.top + box.height / 2 }))
        assert.ok(centers.length >= 1 && Math.max(...centers) - Math.min(...centers) < 1, `lifecycle icons share one vertical center in ${device}/${scheme}: ${centers}`)
      } else {
        const centers = await header.evaluate(el => {
          const center = node => { const r = node.getBoundingClientRect(); return r.top + r.height / 2 }
          return [center(el.querySelector('.ws-chat-back')), center(document.querySelector('.ws-rail-toggle'))]
        })
        assert.ok(Math.abs(centers[0] - centers[1]) < 1, `back and visible rail toggle share their centerline: ${centers}`)
      }
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
      const sheet = page.getByRole('group', { name: 'Settings', exact: true })
      await sheet.waitFor()
      assert.ok(await sheet.locator('.kbn-ctl-history').count())
      assert.ok(await sheet.locator('.ws-transcript-hit:not([hidden])').count())
      assert.match(await sheet.locator('.ws-transcript-hit').innerText(), /% cached/)
      if (device === 'phone') {
        assert.ok(await header.getByRole('button', { name: 'Constitution', exact: true }).isVisible())
        assert.equal(await sheet.locator('.ws-chat-console').count(), 1, 'Console belongs to Settings even when this card has no attach target')
        assert.ok(await header.getByRole('button', { name: 'Temper', exact: true }).isVisible())
        const discard = header.getByRole('button', { name: 'Discard', exact: true })
        assert.ok(await discard.isVisible())
        assert.ok(await discard.evaluate(el => {
          const r = el.getBoundingClientRect(), head = el.closest('.ws-chat-head').getBoundingClientRect()
          return r.top >= head.top && r.bottom <= head.bottom
        }), 'Discard stays in the phone header action row')
      }
      await page.keyboard.press('Escape')
      await sheet.waitFor({ state: 'hidden' })
      assert.equal(await header.getByRole('button', { name: 'Settings', exact: true }).evaluate(el => el === document.activeElement), true)
      const threads = page.getByRole('button', { name: 'Show threads and sent files', exact: true })
      await threads.click()
      const files = page.locator(device === 'phone' ? '.ws-page-sheet[open] .ws-sent-files' : '.ws-rail-files')
      await files.waitFor()
      assert.ok(await files.locator('time').count(), 'sent files carry timestamps in the threads view')
      if (device === 'phone') await page.getByRole('button', { name: 'Close threads and files', exact: true }).click()
      else await page.getByRole('button', { name: 'Hide threads and sent files', exact: true }).click()
      // A verdict leaves settings before opening its undo window.
      await header.getByRole('button', { name: 'Settings', exact: true }).click()
      await chat.getByRole('button', { name: 'Temper', exact: true }).click()
      assert.equal(await page.locator('.ws-settings-menu:not([hidden])').count(), 0)
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
