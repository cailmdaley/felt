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
 *    one step too.
 *
 * `ROUTE_FUZZ_RUNS` deepens it; a failure prints the seed and the shrunk walk.
 */
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { parseRoute, viewOfHash, WorkspaceHistory, type WorkspaceOriginView } from './route.js'

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const RUNS = Number(env.ROUTE_FUZZ_RUNS ?? 60)
const VIEWS: WorkspaceOriginView[] = ['desk', 'chronicle', 'globe', 'channels']
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 10))

type Step =
  | { kind: 'open'; uid: string; view: WorkspaceOriginView }
  | { kind: 'move'; uid: string; quiet: boolean }
  | { kind: 'page'; doc: string }
  | { kind: 'name'; doc: string }
  | { kind: 'leave' }
  | { kind: 'browserBack' }
  | { kind: 'browserForward' }
  | { kind: 'tab'; view: WorkspaceOriginView }
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
  fc.constant({ kind: 'reload' as const }),
)

let history: WorkspaceHistory | null = null
afterEach(() => { history?.dispose(); history = null })

const inReader = (): boolean => parseRoute(window.location.hash)?.kind === 'channel'

describe('back is one step from anywhere', () => {
  it('after any walk, the reader\'s back or the browser\'s reaches the view it names in one step', async () => {
    await fc.assert(fc.asyncProperty(view, fc.array(step, { maxLength: 24 }), fc.constantFrom('reader', 'browser'), async (start, walk, back) => {
      history?.dispose()
      // A fresh entry, so nothing a previous walk left ahead of it can be reached.
      window.history.pushState({ floor: true }, '', `#/${start}`)
      history = new WorkspaceHistory(() => {})
      history.start()
      for (const s of walk) {
        const reader = inReader()
        if (s.kind === 'open' && !reader) history.enter(s.uid, 'host', undefined, s.view)
        else if (s.kind === 'move' && reader) history.enter(s.uid, 'host', undefined, undefined, s.quiet)
        else if (s.kind === 'page') history.show(s.doc)
        else if (s.kind === 'name') history.name(s.doc)
        else if (s.kind === 'leave') history.leave()
        // The browser's back is never taken from the walk's first entry, below which lie other walks'.
        else if (s.kind === 'browserBack' && !window.history.state?.floor) window.history.back()
        else if (s.kind === 'browserForward') window.history.forward()
        else if (s.kind === 'tab') history.view(`#/${s.view}`)
        else if (s.kind === 'reload') { history.dispose(); history = new WorkspaceHistory(() => {}); history.start() }
        await settle()
      }
      if (!inReader()) return
      const named = history.backLabel.toLowerCase()
      if (back === 'reader') history.leave()
      else window.history.back()
      await settle()
      const landed = viewOfHash(window.location.hash)
      expect(inReader(), `one back leaves the reader (${window.location.hash})`).toBe(false)
      expect(landed, `one back lands on a view (${window.location.hash})`).not.toBeNull()
      expect(landed).toBe(named)
    }), { numRuns: RUNS })
  }, 120_000)
})
