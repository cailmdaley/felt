// @vitest-environment jsdom
/**
 * Check the terminal worker pill against the touch stylesheet.
 * The matcher covers the compound selectors used by coarse-pointer rules.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { workerPill } from '../src/board/appConversation.js'
import { DESKTOP, IPAD_PORTRAIT, PHONE_PORTRAIT, matchMediaFor, type Device } from '../src/board/testDevices.js'

type FakeElement = HTMLElement & { href: string }

function useDevice(device: Device): void {
  vi.stubGlobal('matchMedia', matchMediaFor(device))
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
      if (!el.classList.contains(m[1])) return false
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
  return readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/board', file), 'utf8')
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
  workerState: 'running' as const,
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
      it.each([['working', 'working'], ['waiting', 'idle'], ['attention', 'question']])(
        `${deviceName}, ${surface}: a bridged %s worker is a tappable link to its session`,
        (phase, label) => {
          const pill = workerPill(worker(phase, LINK), options) as unknown as FakeElement
          expect(pill.tagName).toBe('A')
          expect(pill.href).toBe(LINK)
          expect(pill.textContent).toBe(label)
          const style = coarseDeclarations(pill, TOUCH_CSS)
          expect(style.get('pointer-events')).not.toBe('none')
        },
      )
      it(`${deviceName}, ${surface}: an unbridged worker is a mark that takes no taps`, () => {
        const pill = workerPill(worker('waiting'), { ...options, openWorker: () => {} }) as unknown as FakeElement
        expect(pill.tagName).toBe('SPAN')
        expect(pill.textContent).toBe('idle')
        expect(coarseDeclarations(pill, TOUCH_CSS).get('pointer-events')).toBe('none')
      })
    }
  })

  for (const [deviceName, device] of [['phone', PHONE_PORTRAIT], ['iPad', IPAD_PORTRAIT]] as const) {
    it(`gives the reader navbar worker pill a 44px touch target on ${deviceName}`, () => {
      useDevice(device)
      const phoneMedia = [...DOCK_CSS.matchAll(
        /@media\s*\(max-width:\s*700px\),\s*\(max-height:\s*500px\)\s*and\s*\(pointer:\s*coarse\)\s*\{([\s\S]*?)\n\}/g,
      )].map(match => match[1]).join('\n')
      const fiberPill = workerPill(worker('waiting', LINK)) as unknown as FakeElement

      expect(fiberPill.classList.contains('kbn-card-worker')).toBe(true)
      expect(declarationsFor('.ws-dock', phoneMedia)).toMatch(/--ctl-h:\s*var\(--ws-phone-target\)/)
      expect(DOCK_CSS).not.toContain('.ws-dock .kbn-card-worker {')
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
      const pill = workerPill(worker('waiting', LINK), { ...options, openWorker }) as unknown as FakeElement
      expect(pill.tagName).toBe('BUTTON')
      expect(pill.textContent).toBe('idle')
      pill.click()
      expect(openWorker).toHaveBeenCalledWith('felt-abc', 'workstation')
    })
  }

  it('names the turn with no column gate', () => {
    const pill = workerPill(worker('waiting'), { openWorker: () => {} }) as unknown as FakeElement
    expect(pill.textContent).toBe('idle')
  })
})
