/**
 * The native picker's pure half: which of the three outcomes a
 * `/api/v1/choose-folder` response means. Everything that isn't a chosen path
 * or an explicit cancel must read as `unavailable`, because that is the answer
 * that routes the human into typing the path instead of a dead end.
 */

import { describe, expect, it } from 'vitest'

import { parseChooseFolder, parseRegisterProject } from './chooseFolder.js'
import { deriveHosts, deriveProjects } from './projectModel.js'

describe('parseChooseFolder', () => {
  it('reads a chosen path', () => {
    expect(parseChooseFolder(200, { ok: true, path: '/Users/x/dev/felt' })).toEqual({
      status: 'chosen',
      path: '/Users/x/dev/felt',
    })
  })

  it('reads a cancel as its own outcome, not an error', () => {
    expect(parseChooseFolder(200, { ok: false, cancelled: true })).toEqual({ status: 'cancelled' })
  })

  it('reads the 501 no-mechanism body as unavailable', () => {
    expect(
      parseChooseFolder(501, { ok: false, error: 'no native folder picker on this host' }),
    ).toEqual({ status: 'unavailable' })
  })

  it('degrades a garbage or missing body to unavailable', () => {
    for (const body of [undefined, null, 'nope', [], {}, { ok: true }, { ok: true, path: '' }]) {
      expect(parseChooseFolder(200, body).status).toBe('unavailable')
    }
  })

  it('never trusts a path behind a non-200', () => {
    expect(parseChooseFolder(500, { ok: true, path: '/tmp/x' }).status).toBe('unavailable')
  })
})

describe('deriveProjects native flag', () => {
  const feed = { host: 'laptop', origins: { laptop: { kind: 'local' } }, entries: [] }

  it('carries the local origin’s native_folder_picker', () => {
    const model = deriveProjects(feed, {
      host: 'laptop',
      origins: {
        laptop: { kind: 'local', felt_stores: ['/loom'], projects: ['/dev/felt'], native_folder_picker: true },
        candide: { kind: 'remote', felt_stores: [], native_folder_picker: false },
      },
    })
    expect(model.nativeFolderPicker).toBe(true)
  })

  it('is false when the daemon is too old to report one', () => {
    const model = deriveProjects(feed, {
      host: 'laptop',
      origins: { laptop: { kind: 'local', felt_stores: ['/loom'], projects: ['/dev/felt'] } },
    })
    expect(model.nativeFolderPicker).toBe(false)
  })

  it('ignores a remote’s dialog — nobody is sitting at that desktop', () => {
    const model = deriveProjects(feed, {
      host: 'laptop',
      origins: {
        laptop: { kind: 'local', felt_stores: ['/loom'], projects: ['/dev/felt'] },
        candide: { kind: 'remote', felt_stores: ['/loom'], projects: ['/home/x/p'], native_folder_picker: true },
      },
    })
    expect(model.nativeFolderPicker).toBe(false)
  })
})

describe('parseRegisterProject', () => {
  it('reads a successful registration', () => {
    expect(parseRegisterProject(200, true, { ok: true, path: '/dev/felt' })).toEqual({ ok: true })
  })

  it('carries the daemon’s reason verbatim — on a remote it is the only thing that says the typed path was wrong', () => {
    expect(
      parseRegisterProject(400, false, { ok: false, error: 'not a directory: /home/x/typo' }),
    ).toEqual({ ok: false, error: 'not a directory: /home/x/typo' })
  })

  it('falls back to the status when the body carries no reason', () => {
    expect(parseRegisterProject(502, false, undefined)).toEqual({
      ok: false,
      error: 'register failed (502)',
    })
  })
})

describe('deriveHosts', () => {
  const feedOrigins = { laptop: { kind: 'local' as const }, candide: { kind: 'remote' as const } }
  const registry = {
    host: 'laptop',
    origins: {
      laptop: { kind: 'local', native_folder_picker: true },
      candide: { kind: 'remote', display: 'Candide', native_folder_picker: true },
    },
  }

  it('normalizes the local origin to the id the projects carry, and sorts it first', () => {
    const hosts = deriveHosts(registry, 'laptop', feedOrigins)
    expect(hosts.map((h) => h.id)).toEqual(['local', 'candide'])
    expect(hosts[0]).toMatchObject({ label: 'laptop', isLocal: true, nativeFolderPicker: true })
  })

  it('never calls a remote native — its dialog would open on a desktop nobody is at', () => {
    const candide = deriveHosts(registry, 'laptop', feedOrigins).find((h) => h.id === 'candide')
    expect(candide).toMatchObject({ label: 'Candide', isLocal: false, nativeFolderPicker: false })
  })

  it('marks an unreachable remote stale', () => {
    const hosts = deriveHosts(
      { host: 'laptop', origins: { candide: { kind: 'remote', stale: true } } },
      'laptop',
      {},
    )
    expect(hosts.find((h) => h.id === 'candide')?.stale).toBe(true)
  })

  it('always yields a local host, even from a registry that names no origins', () => {
    expect(deriveHosts({}, 'laptop', {})).toEqual([
      { id: 'local', label: 'laptop', isLocal: true, nativeFolderPicker: false, stale: false },
    ])
  })

  it('collapses a registry host that disagrees with the feed host into one local entry', () => {
    const hosts = deriveHosts({ host: 'laptop', origins: { laptop: { kind: 'local' } } }, 'laptop-2', {
      'laptop-2': { kind: 'local' as const },
    })
    expect(hosts.filter((h) => h.id === 'local')).toHaveLength(1)
  })
})

describe('deriveProjects hosts', () => {
  it('offers every configured origin, including one with no projects yet', () => {
    const model = deriveProjects(
      { host: 'laptop', origins: { laptop: { kind: 'local' } }, entries: [] },
      {
        host: 'laptop',
        origins: {
          laptop: { kind: 'local', felt_stores: ['/loom'], projects: ['/dev/felt'] },
          cineca: { kind: 'remote', felt_stores: [], projects: [] },
        },
      },
    )
    expect(model.hosts.map((h) => h.id)).toEqual(['local', 'cineca'])
  })
})
