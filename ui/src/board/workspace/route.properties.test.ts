// @vitest-environment jsdom
/**
 * Back is one step from anywhere. A random walk over everything that moves the
 * reader or the browser (opening a constitution from a view, moving to another
 * one, its pages, a scan, the reader's back, the browser's back and forward,
 * another view's tab, a reload) runs against jsdom's real session history, and
 * from wherever it ends:
 *
 *  - the reader's back reaches a view in one step, and that view is the one
 *    the reader names as its way back;
 *  - the browser's back from a reader opened over a view reaches that view in
 *    one step too;
 *  - the address names the page or view last shown.
 *
 * Steps may be rushed, leaving a back in flight when the next one starts; a
 * walk may start at a deep link, and may type an address over a view (one
 * typed over the reader is the browser's own entry above it, as in any app).
 *
 * `ROUTE_FUZZ_RUNS` deepens it; a failure prints the seed and the shrunk walk.
 */
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { formatRoute, parseRoute, viewOfHash, WorkspaceHistory, type WorkspaceOriginView, type WorkspaceRoute } from './route.js'

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const RUNS = Number(env.ROUTE_FUZZ_RUNS ?? 60)
const VIEWS: WorkspaceOriginView[] = ['desk', 'chronicle', 'globe', 'channels']
// jsdom lands a back or forward two timer turns after it is asked for, and a back the history takes on landing lands two turns later still.
// Zero-delay timers fire in the order they were set, so counting turns waits for every move however long the machine stalls between them.
const settle = async (): Promise<void> => { for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }

type Step =
  | { kind: 'open'; uid: string; view: WorkspaceOriginView }
  | { kind: 'move'; uid: string; quiet: boolean }
  | { kind: 'page'; doc: string }
  | { kind: 'name'; doc: string }
  | { kind: 'leave' }
  | { kind: 'browserBack' }
  | { kind: 'browserForward' }
  | { kind: 'tab'; view: WorkspaceOriginView }
  | { kind: 'typed'; uid: string }
  | { kind: 'reload' }

const uid = fc.constantFrom('a', 'b', 'c')
const doc = fc.constantFrom('fiber:a', 'family:a', 'host:/f.html', 'host:/g.svg')
const view = fc.constantFrom(...VIEWS)
const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant('open' as const), uid, view }),
  fc.record({ kind: fc.constant('move' as const), uid, quiet: fc.boolean() }),
  fc.record({ kind: fc.constant('page' as const), doc }),
  fc.record({ kind: fc.constant('name' as const), doc }),
  fc.constant({ kind: 'leave' as const }),
  fc.constant({ kind: 'browserBack' as const }),
  fc.constant({ kind: 'browserForward' as const }),
  fc.record({ kind: fc.constant('tab' as const), view }),
  fc.record({ kind: fc.constant('typed' as const), uid }),
  fc.constant({ kind: 'reload' as const }),
)

let history: WorkspaceHistory | null = null
afterEach(() => { history?.dispose(); history = null })

const addressOf = (route: WorkspaceRoute): string => route.kind === 'channel' ? formatRoute(route) : route.hash ?? '#/channels'
const inReader = (): boolean => parseRoute(window.location.hash)?.kind === 'channel'

describe('back is one step from anywhere', () => {
  it('after any walk, the reader\'s back or the browser\'s reaches the view it names in one step, and the address names what is shown', async () => {
    const walkStep = fc.record({ step, rush: fc.boolean() })
    await fc.assert(fc.asyncProperty(view, fc.boolean(), fc.array(walkStep, { maxLength: 24 }), fc.constantFrom('reader', 'browser'), async (start, deep, walk, back) => {
      history?.dispose()
      // A fresh entry, so nothing a previous walk left ahead of it can be reached; a deep start is a reader address with nothing of ours below.
      window.history.pushState({ floor: true }, '', deep ? '#/board/deep@host' : `#/${start}`)
      let shown: WorkspaceRoute | null = null
      const make = (): WorkspaceHistory => new WorkspaceHistory(route => { shown = route })
      history = make()
      history.start()
      for (const { step: s, rush } of walk) {
        const reader = inReader()
        if (s.kind === 'open' && !reader) history.enter(s.uid, 'host', undefined, s.view)
        else if (s.kind === 'move' && reader) history.enter(s.uid, 'host', undefined, undefined, s.quiet)
        else if (s.kind === 'page') history.show(s.doc)
        // The reader settled on a page by itself: what it shows is what the address now names.
        else if (s.kind === 'name') { const before = window.location.hash; history.name(s.doc); if (window.location.hash !== before) shown = parseRoute(window.location.hash) }
        else if (s.kind === 'leave') history.leave()
        // The browser's back is never taken from the walk's first entry, below which lie other walks'.
        else if (s.kind === 'browserBack' && !window.history.state?.floor) window.history.back()
        else if (s.kind === 'browserForward') window.history.forward()
        else if (s.kind === 'tab') history.view(`#/${s.view}`)
        else if (s.kind === 'typed' && !rush && !reader) window.location.hash = `#/board/${s.uid}@host`
        else if (s.kind === 'reload' && !rush) { history.dispose(); history = make(); history.start() }
        // A rushed step leaves its back in flight for the next one.
        if (!rush) await settle()
      }
      await settle()
      if (shown) expect(window.location.hash, 'the address names what is shown').toBe(addressOf(shown))
      if (!inReader()) return
      const named = history.backLabel.toLowerCase()
      // The browser's back from a deep link with nothing below leaves the board, as it should; only the reader's is checked there.
      if (back === 'reader' || window.history.state?.floor) history.leave()
      else window.history.back()
      await settle()
      const landed = viewOfHash(window.location.hash)
      expect(inReader(), `one back leaves the reader (${window.location.hash})`).toBe(false)
      expect(landed, `one back lands on a view (${window.location.hash})`).not.toBeNull()
      expect(landed).toBe(named)
      expect(addressOf(shown!)).toBe(window.location.hash)
    }), { numRuns: RUNS })
  }, 120_000)
})
