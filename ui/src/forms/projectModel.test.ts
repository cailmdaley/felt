import { describe, expect, it } from 'vitest'
import { parseCompositeFeed } from '../board/KanbanComposite'
import { deriveHosts, deriveProjects } from './projectModel'

const feed = parseCompositeFeed({
  host: 'recorder', origins: { recorder: { kind: 'local' }, scribe: { kind: 'remote' } }, fibers: [],
})

describe('project host browser capabilities', () => {
  it('carries each host browser capability independently through the store registry', () => {
    for (const localCapable of [true, false]) {
      const model = deriveProjects(feed, {
        host: 'recorder', origins: {
          recorder: { kind: 'local', projects: ['/desk'], browser_capable: localCapable },
          scribe: { kind: 'remote', display: 'Scribe', projects: ['/science'], browser_capable: !localCapable },
        },
      })
      expect(model.hosts.map(({ id, browserCapable }) => ({ id, browserCapable }))).toEqual([
        { id: 'local', browserCapable: localCapable }, { id: 'scribe', browserCapable: !localCapable },
      ])
      expect(model.projects.map(({ path, originId }) => ({ path, originId }))).toEqual([
        { path: '/desk', originId: 'local' }, { path: '/science', originId: 'scribe' },
      ])
    }
  })

  it('requires explicit boolean true and fails closed for feed-only and fallback hosts', () => {
    for (const value of [undefined, null, false, 'true', 1, {}, []]) {
      const model = deriveProjects(feed, {
        host: 'recorder', origins: {
          recorder: { kind: 'local', browser_capable: value },
          scribe: { kind: 'remote', browser_capable: value },
        },
      })
      expect(model.hosts.map((host) => host.browserCapable)).toEqual([false, false])
    }
    expect(deriveProjects(feed).hosts.map((host) => host.browserCapable)).toEqual([false, false])
    expect(deriveHosts({}, 'recorder', {})).toEqual([
      { id: 'local', label: 'recorder', isLocal: true, nativeFolderPicker: false, browserCapable: false },
    ])
  })
})
