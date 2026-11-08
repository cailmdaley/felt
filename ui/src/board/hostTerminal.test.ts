import { expect, it, vi } from 'vitest'
import { applyTerminalHost, TerminalHostReader, terminalHostFromVersion } from './hostTerminal.js'
import { parseCompositeFeed } from './KanbanComposite.js'
import { cardFromCompositeEntry } from './KanbanReadModel.js'
import { servedFeed } from './testFixtures.js'

it('scopes the version fallback to the host that answered and preserves observed worker backends', () => {
  const feed = parseCompositeFeed(servedFeed({ fibers: [
    { origin: 'hub', terminal: undefined }, { origin: 'remote', terminal: undefined }, { origin: 'hub', terminal: 'tmux' },
  ].map(({ origin, terminal }, i) => ({ origin, felt_store: '/felt', path: `worker-${i}.md`,
    fiber: { id: `worker-${i}`, name: 'Worker', status: 'active' },
    runtime: { state: 'running', tmux_session: `worker-${i}`, terminal },
  })) }))
  applyTerminalHost(feed.entries, terminalHostFromVersion({ host: 'hub', terminal: 'rex' }))
  expect(feed.entries.map(entry => cardFromCompositeEntry(entry).terminalBackend)).toEqual(['rex', undefined, 'tmux'])
})

it.each([null, {}, { host: 'hub', terminal: null }, { host: 'hub', terminal: 'other' }, { terminal: 'rex' }])('requires an identified version and a supported terminal: %j', version => {
  expect(terminalHostFromVersion(version)).toBeUndefined()
})

it('reads the version off the render path: never awaited, retried after failure, settled once answered', async () => {
  const answers: Array<() => Promise<Response>> = [
    () => Promise.reject(new Error('down')),
    () => Promise.resolve(new Response('', { status: 503 })),
    () => Promise.resolve(Response.json({ host: 'hub', terminal: 'rex' })),
  ]
  let release!: () => void
  const read = vi.fn(() => new Promise<void>(resolve => { release = resolve }).then(answers[read.mock.calls.length - 1]))
  const learned = vi.fn()
  const reader = new TerminalHostReader(read, learned)
  for (let attempt = 0; attempt < 3; attempt++) {
    reader.refresh()
    reader.refresh()
    expect(reader.current).toBeUndefined()
    release()
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(attempt + 1))
    await new Promise(resolve => setTimeout(resolve))
  }
  expect(reader.current).toEqual({ host: 'hub', terminal: 'rex' })
  expect(learned).toHaveBeenCalledOnce()
  reader.refresh()
  expect(read).toHaveBeenCalledTimes(3)
})

it('settles a version without a terminal as none and stops asking', async () => {
  const read = vi.fn(async () => Response.json({ host: 'hub' }))
  const learned = vi.fn()
  const reader = new TerminalHostReader(read, learned)
  reader.refresh()
  await new Promise(resolve => setTimeout(resolve))
  reader.refresh()
  expect(read).toHaveBeenCalledOnce()
  expect(reader.current).toBeUndefined()
  expect(learned).not.toHaveBeenCalled()
})
