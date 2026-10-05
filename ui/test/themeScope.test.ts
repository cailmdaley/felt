// @vitest-environment jsdom
import { afterAll, beforeAll, expect, it } from 'vitest'
import { ChannelThemes } from '../src/board/workspace/ChannelThemes.js'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { chromium, type Browser, type Page } from 'playwright-core'

// Native @scope, layers, nesting and computed custom properties require CSSOM.
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
let browser: Browser
let page: Page
let sharedDefaults: string
const native = it.skipIf(!existsSync(chrome))
beforeAll(async () => {
  if (!existsSync(chrome)) return
  browser = await chromium.launch({ executablePath: chrome, headless: true })
  page = await browser.newPage()
  const defaults = { '--ws-paper': 'white', '--ws-ink': 'black', '--known': '12px', '--ws-stage-inset': '28px', '--ws-strip-h': '32px',
    '--ws-serif': 'Georgia, serif', '--ws-focus': '#BC4538', '--kbn-agent': '#3D5BA0', '--kbn-you': '#BC4538', '--kbn-owed': '#9A7B35', '--kbn-tempered-ink': '#2E6862' }
  for (const [name, value] of Object.entries(defaults)) document.documentElement.style.setProperty(name, value)
  const themes = new ChannelThemes('')
  sharedDefaults = document.querySelector<HTMLStyleElement>('[data-ws-act-defaults]')!.textContent!
  themes.dispose(); document.documentElement.removeAttribute('style')
  const source = readFileSync(resolve('src/board/workspace/themeScope.ts'), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  await page.addScriptTag({ type: 'module', content: code + '\nglobalThis.compileTheme = scopeTheme;' })
})
afterAll(async () => { await browser?.close() })

native('isolates nested themed, Plain and same-channel boundaries with own layered variables winning', async () => {
  const facts = await page.evaluate(sharedDefaults => {
    const compile = (globalThis as unknown as { compileTheme(css: string, scope: string, ns: string, defaults?: Map<string, string>): string }).compileTheme
    document.head.querySelectorAll('style').forEach(el => el.remove())
    document.body.innerHTML = `<div id="desk">Desk</div>
      <section id="reader" class="ws-reader" data-ws-theme="outer" data-ws-theme-boundary>
        <span id="prose">Prose</span><div data-part="act" id="act"><button>Temper</button></div>
        <div id="plain" data-ws-theme-boundary><span>Plain</span></div>
        <div id="foreign" data-ws-theme="inner" data-ws-theme-boundary><span>Foreign</span></div>
        <div id="same" data-ws-theme="outer" data-ws-theme-boundary><span>Same</span></div>
      </section>`
    const add = (css: string): void => { const style = document.createElement('style'); style.textContent = css; document.head.append(style) }
    add(`:root { --ws-paper: white; --ws-ink: black; --known: 12px; }
      .ws-reader { --ws-stage-inset: 0px; }
      :where([data-ws-theme] [data-part="act"]) { all: initial; display: revert; }`)
    add(sharedDefaults)
    const reader = document.querySelector<HTMLElement>('#reader')!
    reader.style.setProperty('--ws-strip-h', '104px')
    const defaults = new Map([['--known', '12px'], ['--ws-paper', 'white'], ['--ws-ink', 'black'], ['--ws-stage-inset', '28px'], ['--ws-strip-h', '32px']])
    const outer = compile(`@import url(https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;600);
      @layer skin {
        :scope { --ws-custom-ready: 1; --known: 99px; --ws-paper: rgb(10, 20, 30); --ws-ink: white; --ws-stage-inset: 99px; --ws-strip-h: 0px; color: red; font-family: fantasy; direction: rtl; }
        span, button { color: red; }
      }
      @media (min-width: 0px) { :scope { --conditional: 1; & span { --nested: 1; } --after-nested: 1; } }
      @supports (display: grid) { :scope { --supported: 1; } }
      @keyframes ink { from { opacity: 0; --frame-var: 1; } to { opacity: 1; } }
      :scope span { animation: var(--motion, ink) 1s steps(2); }`, '[data-ws-theme="outer"]', 'outer', defaults)
    // Avoid external font requests, while checking imports precede the defaults.
    add(outer.slice(outer.indexOf('@layer')))
    add(compile('@layer skin { :scope { --known: 24px; --own: 2; color: blue; } span { color: blue; } }', '[data-ws-theme="inner"]', 'inner', defaults))
    const facts = (id: string) => {
      const el = document.getElementById(id)!, style = getComputedStyle(el)
      return { ready: style.getPropertyValue('--ws-custom-ready').trim(), known: style.getPropertyValue('--known').trim(), own: style.getPropertyValue('--own').trim(),
        conditional: style.getPropertyValue('--conditional').trim(), supported: style.getPropertyValue('--supported').trim(), frame: style.getPropertyValue('--frame-var').trim(),
        color: style.color, font: style.fontFamily, direction: style.direction, childColor: el.firstElementChild ? getComputedStyle(el.firstElementChild).color : '' }
    }
    return { outer, reader: facts('reader'), plain: facts('plain'), foreign: facts('foreign'), same: facts('same'), act: facts('act'), desk: facts('desk'),
      inset: getComputedStyle(reader).getPropertyValue('--ws-stage-inset').trim(), strip: getComputedStyle(reader).getPropertyValue('--ws-strip-h').trim() }
  }, sharedDefaults)
  expect(facts.outer.indexOf('@import')).toBeLessThan(facts.outer.indexOf('@layer shuttle-theme-defaults'))
  expect(facts.outer).toContain(':scope [data-ws-theme-boundary]')
  expect(facts.outer).toContain(':where([data-ws-theme-boundary])')
  expect(facts.outer).toContain('--nested: initial;')
  expect(facts.outer).toContain('--after-nested: initial;')
  expect(facts.outer).toContain('--frame-var: initial;')
  expect(facts.outer).toContain('outer-ink')
  expect(facts.reader.ready).toBe('1')
  expect(facts.reader.known).toBe('99px')
  expect(facts.same.ready).toBe('1'); expect(facts.same.known).toBe('99px')
  expect(facts.plain.ready).toBe(''); expect(facts.plain.known).toBe('12px')
  expect(facts.plain.color).toBe('rgb(0, 0, 0)'); expect(facts.plain.font).not.toContain('fantasy')
  expect(facts.reader.direction).toBe('rtl'); expect(facts.same.direction).toBe('rtl')
  expect(facts.plain.direction).toBe('ltr'); expect(facts.foreign.direction).toBe('ltr'); expect(facts.act.direction).toBe('ltr')
  expect(facts.plain.childColor).toBe('rgb(0, 0, 0)')
  expect(facts.foreign.ready).toBe(''); expect(facts.foreign.known).toBe('24px'); expect(facts.foreign.own).toBe('2')
  expect(facts.foreign.childColor).toBe('rgb(0, 0, 255)')
  expect(facts.plain.conditional).toBe(''); expect(facts.foreign.supported).toBe('')
  expect(facts.act.ready).toBe(''); expect(facts.act.known).toBe('12px'); expect(facts.act.childColor).toBe('rgb(0, 0, 0)')
  expect(facts.desk.known).toBe('12px'); expect(facts.desk.ready).toBe('')
  expect(facts.inset).toBe('0px'); expect(facts.strip).toBe('104px')
}, 15000)

native('keeps standalone toast material and ACT pigments independent of channel author CSS', async () => {
  const surface = readFileSync(resolve('src/board/workspace/themes/surface.css'), 'utf8')
  const toastCss = readFileSync(resolve('src/board/workspace/verdicts.css'), 'utf8')
  const facts = await page.evaluate(({ sharedDefaults, surface, toastCss }) => {
    const compile = (globalThis as unknown as { compileTheme(css: string, scope: string, ns: string): string }).compileTheme
    document.head.querySelectorAll('style').forEach(el => el.remove())
    document.body.innerHTML = `<section class="ws-reader" data-ws-theme="dark" data-ws-theme-boundary>
      <div data-part="act" data-act="worker" class="worker"><button>Worker</button></div>
      <div class="ws-constitution-card" data-ws-theme-boundary><button class="kbn-card-worker">Plain worker</button></div>
      </section><div class="ws-verdict-toasts"><div class="ws-verdict-toast" data-part="act" data-act="toast" data-ws-act-material>Tempered <button>Undo</button></div></div>`
    const add = (css: string): void => { const style = document.createElement('style'); style.textContent = css; document.head.append(style) }
    add(`:root { --ws-paper: white; --ws-ink: black; --ws-serif: Georgia, serif; --ws-radius: 10px; }
      .worker button { color: var(--ws-agent); font-family: var(--ws-serif); }
      .kbn-card-worker { color: black; }
      .ws-constitution-card { display: grid; width: 280px; padding: 12px; }`)
    add(surface); add(sharedDefaults); add(toastCss)
    add(compile(':scope { --ws-paper: rgb(20, 36, 39); --ws-ink: rgb(240, 237, 225); --ws-agent: red; --ws-verdict: red; --custom: 1; font-family: fantasy; } button { color: red; }', '[data-ws-theme="dark"]', 'dark'))
    const reader = document.querySelector<HTMLElement>('.ws-reader')!, toast = document.querySelector<HTMLElement>('.ws-verdict-toast')!
    const material = getComputedStyle(reader)
    toast.style.setProperty('--ws-paper', material.getPropertyValue('--ws-paper'))
    toast.style.setProperty('--ws-ink', material.getPropertyValue('--ws-ink'))
    const style = getComputedStyle(toast), undo = getComputedStyle(toast.querySelector('button')!)
    const worker = getComputedStyle(reader.querySelector('.worker button')!)
    const plain = getComputedStyle(reader.querySelector('.ws-constitution-card')!)
    const plainWorker = getComputedStyle(reader.querySelector('.kbn-card-worker')!)
    const facts = { paper: style.backgroundColor, ink: style.color, undo: undo.color, font: undo.fontFamily, custom: style.getPropertyValue('--custom').trim(),
      worker: worker.color, workerFont: worker.fontFamily,
      plain: { display: plain.display, width: plain.width, padding: plain.padding, worker: plainWorker.color } }
    reader.removeAttribute('data-ws-theme')
    return { ...facts, afterNavigation: getComputedStyle(toast).backgroundColor }
  }, { sharedDefaults, surface, toastCss })
  expect(facts.paper).toBe('rgb(20, 36, 39)'); expect(facts.ink).toBe('rgb(240, 237, 225)')
  expect(facts.afterNavigation).toBe(facts.paper)
  expect(facts.undo).not.toBe('rgb(255, 0, 0)'); expect(facts.font).not.toContain('fantasy')
  expect(facts.custom).toBe(''); expect(facts.worker).not.toBe('rgb(255, 0, 0)'); expect(facts.workerFont).not.toContain('fantasy')
  expect(facts.plain).toEqual({ display: 'grid', width: '280px', padding: '12px', worker: 'rgb(0, 0, 0)' })
}, 15000)
