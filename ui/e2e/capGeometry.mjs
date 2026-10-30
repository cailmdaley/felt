import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

export function registerCapGeometryJourneys(test, { open, choose, headerAction }) {
  for (const width of [1440, 390, 320]) test(`Initial decoration and session history remain visible at ${width}px`, async p => {
    if (width < 700) await p.locator('[data-view="shelf"]').click()
    await p.locator('.kbn-cap:visible').first().waitFor()
    await p.evaluate(() => document.fonts.ready)
    const cap = p.locator('.kbn-cap:visible').first()
    const geometry = await cap.evaluate(el => {
      const box = el.getBoundingClientRect(), style = getComputedStyle(el), frill = getComputedStyle(el, '::before')
      const number = value => parseFloat(value) || 0
      const left = box.left + number(frill.left), top = box.top + number(frill.top)
      return { letter: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
        frill: { left, top, right: left + number(frill.width) + number(frill.paddingLeft) + number(frill.paddingRight), bottom: top + number(frill.height) + number(frill.paddingTop) + number(frill.paddingBottom) },
        font: style.fontSize, frillFont: frill.fontSize }
    })
    if (process.env.WORKSPACE_SHOTS) {
      await mkdir(process.env.WORKSPACE_SHOTS, { recursive: true })
      await p.screenshot({ path: resolve(process.env.WORKSPACE_SHOTS, `initial-${width}.png`) })
    }
    assert.equal(geometry.font, geometry.frillFont, `letter and ornament share their em: ${JSON.stringify(geometry)}`)
    for (const edge of ['left', 'top']) assert.ok(geometry.frill[edge] <= geometry.letter[edge] + 1, `frill contains letter ${edge}: ${JSON.stringify(geometry)}`)
    for (const edge of ['right', 'bottom']) assert.ok(geometry.frill[edge] >= geometry.letter[edge] - 1, `frill contains letter ${edge}: ${JSON.stringify(geometry)}`)
    if (width < 700) await p.locator('[data-view="desk"]').click()
    await open(p); await choose(p, 'Chat'); await headerAction(p, 'Settings')
    const glyph = p.locator('.ws-page.ws-selected .kbn-ctl-history-chevron')
    await glyph.waitFor({ state: 'visible' })
    const mark = await glyph.evaluate(el => ({ text: el.textContent, before: getComputedStyle(el, '::before').content, box: el.getBoundingClientRect().toJSON() }))
    if (process.env.WORKSPACE_SHOTS) await p.screenshot({ path: resolve(process.env.WORKSPACE_SHOTS, `history-${width}.png`) })
    assert.ok(mark.text.includes('▾') || mark.before.includes('▾'), `history has its rendered arrow: ${JSON.stringify(mark)}`)
    assert.ok(mark.box.width > 0 && mark.box.height > 0, 'history arrow occupies visible space')
  }, { width, height: width === 1440 ? 900 : 844 })
}
