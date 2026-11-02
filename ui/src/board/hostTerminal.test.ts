import { expect, it } from 'vitest'
import { applyTerminalHost, terminalHostFromVersion } from './hostTerminal.js'
import { parseCompositeFeed } from './KanbanComposite.js'
import { cardFromCompositeEntry } from './KanbanReadModel.js'

it('scopes the version fallback to the host that answered and preserves observed worker backends', () => {
  const feed = parseCompositeFeed({ fibers: [
    { origin: 'hub', terminal: undefined }, { origin: 'remote', terminal: undefined }, { origin: 'hub', terminal: 'tmux' },
  ].map(({ origin, terminal }, i) => ({ origin, felt_store: '/felt', path: `worker-${i}.md`,
    fiber: { id: `worker-${i}`, name: 'Worker', status: 'active' },
    runtime: { state: 'running', tmux_session: `worker-${i}`, terminal },
  })) })
  applyTerminalHost(feed.entries, terminalHostFromVersion({ host: 'hub', terminal: 'rex' }))
  expect(feed.entries.map(entry => cardFromCompositeEntry(entry).terminalBackend)).toEqual(['rex', undefined, 'tmux'])
})

it.each([null, {}, { host: 'hub', terminal: null }, { host: 'hub', terminal: 'other' }, { terminal: 'rex' }])('requires an identified version and a supported terminal: %j', version => {
  expect(terminalHostFromVersion(version)).toBeUndefined()
})
