/**
 * DirectoryPicker's pure halves — the two places a malformed daemon response
 * or an odd path could otherwise throw inside render.
 */

import { describe, expect, it } from 'vitest'

import { crumbs, parseBrowseListing } from './DirectoryPicker.js'

describe('parseBrowseListing', () => {
  it('reads a well-formed /browse body', () => {
    expect(
      parseBrowseListing({
        path: '/Users/x/projects',
        parent: '/Users/x',
        entries: [
          { name: 'felt', path: '/Users/x/projects/felt', has_felt: true },
          { name: 'talks', path: '/Users/x/projects/talks', has_felt: false },
        ],
      }),
    ).toEqual({
      path: '/Users/x/projects',
      parent: '/Users/x',
      entries: [
        { name: 'felt', path: '/Users/x/projects/felt', hasFelt: true },
        { name: 'talks', path: '/Users/x/projects/talks', hasFelt: false },
      ],
    })
  })

  it('treats a null parent as "no parent" (the filesystem root)', () => {
    expect(parseBrowseListing({ path: '/', parent: null, entries: [] }).parent).toBeNull()
  })

  it('drops malformed entries rather than throwing', () => {
    const listing = parseBrowseListing({
      path: '/a',
      entries: [null, 'nope', { name: 'ok', path: '/a/ok' }, { name: 'nopath' }],
    })
    expect(listing.entries).toEqual([{ name: 'ok', path: '/a/ok', hasFelt: false }])
  })

  it('degrades a non-object body to an empty listing', () => {
    for (const body of [undefined, null, 'error page', ['x']]) {
      expect(parseBrowseListing(body)).toEqual({ path: '', parent: null, entries: [] })
    }
  })
})

describe('crumbs', () => {
  it('walks the path root-first', () => {
    expect(crumbs('/a/b/c')).toEqual([
      { label: '/', path: '/' },
      { label: 'a', path: '/a' },
      { label: 'b', path: '/a/b' },
      { label: 'c', path: '/a/b/c' },
    ])
  })

  it('is just the root at the root', () => {
    expect(crumbs('/')).toEqual([{ label: '/', path: '/' }])
  })

  it('yields nothing for an unresolved (empty or relative) path', () => {
    expect(crumbs('')).toEqual([])
    expect(crumbs('relative/x')).toEqual([])
  })
})
