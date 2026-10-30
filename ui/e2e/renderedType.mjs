import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { frames } from './layoutShift.mjs'

// Read the contract from its owner, rather than accepting tokens an injected
// stylesheet or inline style may have overwritten in the document.
const typeCSS = await readFile(new URL('../src/styles/type.css', import.meta.url), 'utf8')
const tokens = Object.fromEntries([...typeCSS.matchAll(/(--(?:type|leading|track|glyph)-[\w-]+)\s*:\s*([^;]+);/g)].map(([, key, value]) => [key, value.trim()]))

/** Check rendered board text, including runtime/imported styles. Artifact
 * iframes contain author-owned documents and are outside the board's type contract.
 * A valid-looking hand-built clock has no observable provenance; this checks
 * its output format, while the cheap source check guards formatter ownership.
 */
export async function renderedTypeViolations(page) {
  return page.evaluate(tokens => {
    const violations = [], samples = []
    const near = (a, b) => Math.abs(a - b) < 0.025
    const value = (token, em) => {
      const raw = tokens[token]
      return raw.endsWith('em') ? parseFloat(raw) * em : parseFloat(raw)
    }
    const roles = Object.keys(tokens).filter(key => key.startsWith('--type-') && key !== '--type-code')
    const leadings = Object.keys(tokens).filter(key => key.startsWith('--leading-')).map(key => value(key))
    // These exact elements draw a letter with the initials font, not a text role.
    // No suffix-based exemption: a new *-mark or *-cap remains ordinary text.
    const initial = '.kbn-cap'
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node; (node = walker.nextNode());) {
      const text = node.textContent.trim(), el = node.parentElement
      if (!text || !el || el.closest('script, style, noscript') || !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue
      const range = document.createRange(); range.selectNodeContents(node)
      if (![...range.getClientRects()].some(r => r.width > 0 && r.height > 0)) continue
      const style = getComputedStyle(el), size = parseFloat(style.fontSize)
      const label = `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${[...el.classList].map(c => '.' + c).join('')} ${JSON.stringify(text.slice(0, 100))}`
      const report = (property, actual) => violations.push(`${label}: ${property} ${actual}`)
      const code = el.closest('code, kbd, samp')
      const parentSize = parseFloat(getComputedStyle(code?.parentElement ?? el.parentElement ?? el).fontSize)
      const isCode = code !== null
      let sizes = roles.map(key => value(key))
      if (isCode) sizes.push(value('--type-code', parentSize))
      if (el.matches(initial) && [...text].length === 1 && el.dataset.letter === text) {
        const contextSize = parseFloat(getComputedStyle(el.parentElement).fontSize)
        sizes = [value(el.closest('.kbn-col-title, .kbn-view-title, .ws-overview-heading') ? '--glyph-initial-heading' : '--glyph-initial', contextSize)]
      }
      if (el.matches('.kbn-ctl-history-chevron') && text === '▾') sizes = [value('--glyph-small')]
      if (!sizes.some(role => near(size, role))) report('font-size', style.fontSize)
      const line = parseFloat(style.lineHeight)
      if (!leadings.some(leading => near(line, size * leading))) report('line-height', style.lineHeight)
      const tracking = style.letterSpacing === 'normal' ? 0 : parseFloat(style.letterSpacing)
      const tracked = style.fontVariantCaps === 'all-small-caps'
      const trackingRoles = [0, ...(tracked ? [value('--track-kicker', size), value('--track-nav', size)] : [])]
      if (!trackingRoles.some(role => near(tracking, role))) report('letter-spacing', style.letterSpacing)

      // Inspect every visible text node, not selectors whose names happen to
      // contain "time". Candidate discovery is deliberately broader than the
      // canonical grammar: spaced units, missing zeroes and seconds all fail.
      for (const match of text.matchAll(/\b\d+\s*[a-z]+\s+ago\b/gi)) {
        if (!/^\d+(?:s|m|h|d|mo) ago$/.test(match[0])) report('clock', match[0])
      }
      // Code and media durations have their own syntax. Everywhere else,
      // inspect clocks inside phrases as well as standalone timestamp labels.
      if (!el.closest('code, pre, .ws-audio-duration, .ws-media-poster-duration, .kbn-thumbnail-duration')) {
        for (const match of text.matchAll(/\b\d+:\d+(?::\d+)?(?:\s*[ap]m)?\b/gi)) {
          if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(match[0])) report('clock', match[0])
        }
      }
      samples.push(label)
    }
    return { violations, checked: samples.length }
  }, tokens)
}

async function assertRendered(page, state, failures = []) {
  const { violations, checked } = await renderedTypeViolations(page)
  assert.ok(checked > 0, `${state}: the gate inspected rendered text`)
  failures.push(...violations.map(v => `${state}: ${v}`))
  return failures
}

export function registerRenderedTypeJourneys(test, { open, choose, headerAction }) {
  for (const width of [1440, 390, 320]) test(`Rendered type and clock roles across views (${width})`, async page => {
    const failures = []
    for (const view of ['desk', 'chronicle', 'shelf']) {
      await page.locator(`.kbn-viewtab[data-view="${view}"]`).click()
      await page.locator({ desk: '.kbn-desk', chronicle: '.chr-scroll', shelf: '.ws-overview-folio' }[view]).first().waitFor({ state: 'visible' })
      await page.evaluate(() => document.fonts.ready.then(() => {}))
      await frames(page)
      await assertRendered(page, `${width} ${view}`, failures)
    }
    await page.locator('.kbn-viewtab[data-view="desk"]').click()
    await open(page)
    // Author-owned artifact text lives in an iframe; its surrounding chrome is checked.
    await assertRendered(page, `${width} artifact chrome`, failures)
    for (const view of ['Constitution', 'Chat']) {
      await choose(page, view)
      await assertRendered(page, `${width} ${view}`, failures)
    }
    await headerAction(page, 'Settings')
    await assertRendered(page, `${width} settings`, failures)
    const messages = new URL(page.url()); messages.searchParams.set('transcript', 'messages'); messages.hash = ''
    await page.goto(messages.href)
    await open(page, 'Chat')
    await assertRendered(page, `${width} message rows`, failures)
    assert.deepEqual(failures, [], 'Computed text follows type.css and the canonical clock grammar')
  }, { width, height: width === 1440 ? 900 : 844 })

  test('Rendered type and clock gate rejects computed and imported bypasses', async page => {
    await page.evaluate(() => {
      const probe = document.createElement('span'); probe.id = 'rendered-type-probe'
      probe.textContent = 'Probe'; probe.style.cssText = 'position:fixed;left:8px;top:120px;z-index:999999;background:white;font-size:var(--type-note);line-height:var(--leading-ui);letter-spacing:0'
      document.body.append(probe)
    })
    const probe = page.locator('#rendered-type-probe')
    const baseline = (await renderedTypeViolations(page)).violations
    assert.deepEqual(baseline.filter(v => v.includes('#rendered-type-probe')), [])
    const mutations = [
      ['computed key', el => { const key = ['font', 'Size'].join(''); el.style[key] = '13px' }, 'font-size'],
      ['imported property', async el => { const module = await import('data:text/javascript,export const key="font-size"'); el.style.setProperty(module.key, '13px') }, 'font-size'],
      ['assembled cssText', el => { const n = 13; el.style.cssText += ';font-size:' + n + 'px' }, 'font-size'],
      ['computed CSS template', el => { const p = 'font-size'; el.style.cssText += `;${p}: 13px` }, 'font-size'],
      ['computed line height', el => { el.style[['line', 'Height'].join('')] = '13px' }, 'line-height'],
      ['overridden role token', el => { el.style.setProperty('--type-note', '13px') }, 'font-size'],
      ['computed tracking', el => { el.style[['letter', 'Spacing'].join('')] = '3px' }, 'letter-spacing'],
      ['unresolved cap suffix', el => { el.className = 'probe-cap'; el.style.fontSize = '13px' }, 'font-size'],
      ...['mins', 'minutes', 'hours', 'days'].map(unit => [unit + ' relative unit', el => { el.textContent = '4 ' + el.dataset.probeUnit + ' ago' }, 'clock', unit]),
      ['imported relative formatter', async el => { const module = await import('data:text/javascript,export const format=n=>n+" mins ago"'); el.textContent = module.format(4) }, 'clock'],
      ['clock padding helper', el => { const pad = n => String(n); el.textContent = `${pad(3)}:${pad(7)}` }, 'clock'],
      ['assembled clock', el => { const hh = '3', mm = '07'; el.textContent = 'Started ' + hh + ':' + mm }, 'clock'],
    ]
    for (const [name, mutate, property, unit] of mutations) {
      const saved = await probe.getAttribute('style')
      if (unit) await probe.evaluate((el, unit) => { el.dataset.probeUnit = unit }, unit)
      await probe.evaluate(mutate)
      const violations = (await renderedTypeViolations(page)).violations.filter(v => v.includes('#rendered-type-probe'))
      assert.ok(violations.some(v => v.includes(`: ${property} `)), `${name} must fail the rendered ${property} gate: ${violations}`)
      await probe.evaluate((el, style) => { el.setAttribute('style', style); el.textContent = 'Probe'; el.className = '' }, saved)
    }
    await probe.evaluate(el => el.remove())
  })
}
