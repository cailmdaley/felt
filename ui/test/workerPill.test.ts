/**
 * Check the terminal worker pill against the touch stylesheet on a fake DOM.
 * The matcher covers the compound selectors used by coarse-pointer rules.
 * The in-browser check runs with `npm run harness:board` and
 * `node scripts/check-worker-tap.mjs`.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { terminalWorkerPill } from '../src/board/appConversation.js'
import { DESKTOP, IPAD_PORTRAIT, PHONE_PORTRAIT, matchMediaFor, type Device } from '../src/board/testDevices.js'

class FakeElement {
  className = ''
  textContent = ''
  title = ''
  type = ''
  href = ''
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, Array<(e: { stopPropagation(): void }) => void>>()
  constructor(readonly tagName: string) {}
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  getAttribute(name: string): string | null {
    if (name === 'href') return this.tagName === 'A' && this.href ? this.href : null
    return this.attributes.get(name) ?? null
  }
  hasAttribute(name: string): boolean { return this.getAttribute(name) !== null }
  addEventListener(type: string, fn: (e: { stopPropagation(): void }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  click(): void { for (const fn of this.listeners.get('click') ?? []) fn({ stopPropagation() {} }) }
  get classes(): string[] { return this.className.split(/\s+/).filter(Boolean) }
}

function useDevice(device: Device): void {
  vi.stubGlobal('window', { matchMedia: matchMediaFor(device) })
  vi.stubGlobal('document', { createElement: (tag: string) => new FakeElement(tag.toUpperCase()) })
}

/** Does one compound selector (no combinators) match the element? */
function matchesCompound(el: FakeElement, compound: string): boolean {
  let rest = compound.trim()
  if (rest.startsWith('*')) rest = rest.slice(1)
  const tag = /^[a-z]+/i.exec(rest)?.[0]
  if (tag) {
    if (tag.toUpperCase() !== el.tagName) return false
    rest = rest.slice(tag.length)
  }
  while (rest) {
    let m: RegExpExecArray | null
    if ((m = /^\.([\w-]+)/.exec(rest))) {
      if (!el.classes.includes(m[1])) return false
    } else if ((m = /^\[([\w-]+)\]/.exec(rest))) {
      if (!el.hasAttribute(m[1])) return false
    } else if ((m = /^:not\(([^()]*)\)/.exec(rest))) {
      if (m[1].split(',').some((inner) => matchesCompound(el, inner))) return false
    } else if ((m = /^::?[\w-]+/.exec(rest))) {
      return false // a pseudo-element or state is not the element at rest
    } else {
      throw new Error(`unsupported selector: ${compound}`)
    }
    rest = rest.slice(m[0].length)
  }
  return true
}

/** The declarations every coarse-pointer rule whose subject matches `el` sets. */
function coarseDeclarations(el: FakeElement, css: string): Map<string, string> {
  const out = new Map<string, string>()
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const media of clean.matchAll(/@media\s*\(pointer:\s*coarse\)\s*\{/g)) {
    let depth = 1
    let i = media.index + media[0].length
    const start = i
    while (depth > 0 && i < clean.length) {
      if (clean[i] === '{') depth++
      else if (clean[i] === '}') depth--
      i++
    }
    for (const rule of clean.slice(start, i - 1).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const subjects = rule[1].split(/,(?![^(]*\))/).map((s) => s.trim().split(/\s+|>/).at(-1) ?? '')
      if (!subjects.some((s) => matchesCompound(el, s))) continue
      for (const decl of rule[2].split(';')) {
        const [prop, ...value] = decl.split(':')
        if (prop?.trim() && value.length) out.set(prop.trim(), value.join(':').trim())
      }
    }
  }
  return out
}

function readBoardCss(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/board/${file}`, import.meta.url)), 'utf8')
}

function declarationsFor(selector: string, css: string): string {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((rule) => rule[1].trim() === selector)
    .map((rule) => rule[2])
    .join(';')
}

const DOCK_CSS = readBoardCss('workspace/dock.css')
const READER_CSS = readBoardCss('workspace/reader.css')
const TOKENS_CSS = readBoardCss('workspace/tokens.css')
const TOUCH_CSS = [readBoardCss('KanbanModal.css'), DOCK_CSS, READER_CSS].join('\n')
const LINK = 'https://claude.ai/code/session_bridged'
const now = Date.now()
const worker = (phase: string, sessionLink?: string) => ({
  tmuxSession: 'felt-abc',
  runtimePhase: phase,
  lastActivityAt: now - 3 * 3_600_000,
  shuttleHost: 'workstation',
  sessionLink,
})
/** Where the pill is built: the Desk card and the fiber page's controls. */
const SURFACES = [
  ['Desk card', {}],
  ['fiber page controls', {}],
] as const

afterEach(() => vi.unstubAllGlobals())

describe('the terminal worker pill under a finger', () => {
  for (const [deviceName, device] of [['phone', PHONE_PORTRAIT], ['iPad', IPAD_PORTRAIT]] as const) describe(deviceName, () => {
    beforeEach(() => useDevice(device))
    for (const [surface, options] of SURFACES) {
      it.each([['working', 'Aloft'], ['waiting', 'Waiting'], ['attention', 'Needs you']])(
        `${deviceName}, ${surface}: a bridged %s worker is a tappable link to its session`,
        (phase, label) => {
          const pill = terminalWorkerPill(worker(phase, LINK), options) as unknown as FakeElement
          expect(pill.tagName).toBe('A')
          expect(pill.href).toBe(LINK)
          expect(pill.textContent).toBe(label)
          const style = coarseDeclarations(pill, TOUCH_CSS)
          expect(style.get('pointer-events')).not.toBe('none')
        },
      )
      it(`${deviceName}, ${surface}: an unbridged worker is a mark that takes no taps`, () => {
        const pill = terminalWorkerPill(worker('waiting'), { ...options, openWorker: () => {} }) as unknown as FakeElement
        expect(pill.tagName).toBe('SPAN')
        expect(pill.textContent).toBe('Waiting')
        expect(coarseDeclarations(pill, TOUCH_CSS).get('pointer-events')).toBe('none')
      })
    }
  })

  for (const [deviceName, device] of [['phone', PHONE_PORTRAIT], ['iPad', IPAD_PORTRAIT]] as const) {
    it(`gives the fiber page worker pill a 44px touch target on ${deviceName}`, () => {
      useDevice(device)
      const phoneMedia = DOCK_CSS.match(
        /@media\s*\(max-width:\s*700px\),\s*\(max-height:\s*500px\)\s*and\s*\(pointer:\s*coarse\)\s*\{([\s\S]*)\n\}\s*$/,
      )?.[1] ?? ''
      const fiberPill = terminalWorkerPill(worker('waiting', LINK)) as unknown as FakeElement

      expect(fiberPill.classes).toContain('kbn-card-worker')
      expect(declarationsFor('.ws-dock', phoneMedia)).toMatch(/--ctl-h:\s*var\(--ws-phone-target\)/)
      expect(declarationsFor('.ws-dock .kbn-card-worker', DOCK_CSS)).toMatch(/min-height:\s*var\(--ctl-h\)/)
      expect(coarseDeclarations(fiberPill, DOCK_CSS).get('min-height')).toBe('var(--ws-phone-target)')
      expect(coarseDeclarations(fiberPill, READER_CSS).get('min-height')).toBe('var(--ws-phone-target)')
      expect(TOKENS_CSS).toMatch(/--ws-phone-target:\s*44px/)
    })
  }
})

describe('the terminal worker pill under a mouse', () => {
  beforeEach(() => useDevice(DESKTOP))

  for (const [surface, options] of SURFACES) {
    it(`${surface}: opens the terminal, even for a bridged session`, () => {
      const openWorker = vi.fn()
      const pill = terminalWorkerPill(worker('waiting', LINK), { ...options, openWorker }) as unknown as FakeElement
      expect(pill.tagName).toBe('BUTTON')
      expect(pill.textContent).toBe('Waiting')
      pill.click()
      expect(openWorker).toHaveBeenCalledWith('felt-abc', 'workstation')
    })
  }

  it('stays Aloft outside In flight', () => {
    const pill = terminalWorkerPill(worker('waiting'), { phase: false, openWorker: () => {} }) as unknown as FakeElement
    expect(pill.textContent).toBe('Aloft')
    expect(pill.classes).toContain('kbn-card-worker-aloft')
  })
})
