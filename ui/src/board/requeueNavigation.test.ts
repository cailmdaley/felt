import { afterEach, describe, expect, it, vi } from 'vitest'
import { Dock } from './workspace/Dock.js'
import { card } from './testFixtures.js'

afterEach(() => vi.unstubAllGlobals())

describe('requeue keeps the inline channel controls in place', () => {
  for (const coarse of [true, false]) {
    for (const status of [200, 409]) {
      it(`${coarse ? 'touch' : 'mouse'} after dispatch ${status}`, async () => {
        vi.stubGlobal('window', { matchMedia: () => ({ matches: coarse }) })
        const fetch = vi.fn().mockResolvedValue({
          status, ok: status === 200,
          json: async () => ({ tmux_session: 'worker', session_uuid: 'new-session' }),
        })
        vi.stubGlobal('fetch', fetch)
        const refreshed = vi.fn()
        const openWorker = vi.fn()
        const panel = new Dock('http://daemon', refreshed, undefined, openWorker)
        const requeue = panel as unknown as {
          runRequeue: (c: ReturnType<typeof card>, directive: string, mode: 'fresh',
            btn: HTMLButtonElement, error: HTMLElement) => Promise<void>
        }
        await requeue.runRequeue(card({ id: 'work/task', originId: 'remote' }), '', 'fresh',
          { textContent: 'New session' } as HTMLButtonElement,
          { style: { display: '' } } as HTMLElement)
        expect(refreshed).toHaveBeenCalledOnce()
        expect(fetch).toHaveBeenCalledOnce()
        if (coarse) expect(openWorker).not.toHaveBeenCalled()
        else expect(openWorker).toHaveBeenCalledWith('worker', 'remote')
      })
    }
  }
})
