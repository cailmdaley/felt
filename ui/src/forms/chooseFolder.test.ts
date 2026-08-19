/**
 * The native picker's pure half: which of the three outcomes a
 * `/api/v1/choose-folder` response means. Everything that isn't a chosen path
 * or an explicit cancel must read as `unavailable`, because that is the answer
 * that routes the human into the `/browse` fallback instead of a dead end.
 */

import { describe, expect, it } from 'vitest'

import { parseChooseFolder } from './chooseFolder.js'
import { deriveProjects } from './projectModel.js'

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
