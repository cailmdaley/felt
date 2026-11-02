// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  open: undefined as undefined | ((session: string, host?: string) => void),
  toast: vi.fn(),
}))
vi.mock('./board/KanbanModal.js', () => ({
  KanbanModal: class {
    constructor(options: { onOpenWorker: typeof state.open }) { state.open = options.onOpenWorker }
    mount() {}
  },
}))
vi.mock('./board/utils.js', () => ({ showToast: state.toast }))

beforeAll(async () => {
  document.body.innerHTML = '<div id="app"></div>'
  await import('./main.js')
})
beforeEach(() => state.toast.mockClear())
afterEach(() => vi.unstubAllGlobals())

describe('worker pill terminal errors', () => {
  it('shows the owner’s sentence, not the JSON response envelope', async () => {
    const message = 'remote-a: The terminal session could not be opened.'
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ error: message }), { status: 422 }))
    vi.stubGlobal('fetch', fetch)
    state.open!('codex-terminal-probe', 'remote-a')
    await vi.waitFor(() => expect(state.toast).toHaveBeenCalledWith(`Couldn’t open terminal: ${message}`, 'error'))
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({
      tmux_session: 'codex-terminal-probe', shuttle_host: 'remote-a',
    })
  })

  it.each(['not JSON', JSON.stringify({ error: { reason: 'timeout' } })])('uses a sentence for malformed error responses: %s', async body => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 502 })))
    state.open!('worker')
    await vi.waitFor(() => expect(state.toast).toHaveBeenCalledWith('Couldn’t open terminal', 'error'))
  })
})
