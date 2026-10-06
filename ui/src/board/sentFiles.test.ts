/**
 * The sent-files trail: what the endpoint hands over, and how its files are
 * named.
 */

import { describe, expect, it } from 'vitest'
import { normalizeSentFiles } from './sentFiles.js'

const at = (h: number, min = 0): number => new Date(2026, 7, 11, h, min).getTime()

describe('normalizeSentFiles', () => {
  it('keeps a well-formed record whole', () => {
    expect(
      normalizeSentFiles([
        { fullPath: '/a/report.html', basename: 'report.html', timestamp: 17, sessionId: 's1' },
      ]),
    ).toEqual([
      { fullPath: '/a/report.html', basename: 'report.html', timestamp: 17, sessionId: 's1' },
    ])
  })

  it('parses a timestamp written as an ISO string', () => {
    const [file] = normalizeSentFiles([
      { fullPath: '/a/x.png', timestamp: new Date(at(9)).toISOString() },
    ])
    expect(file.timestamp).toBe(at(9))
  })

  it('falls back to the path tail when no basename came through', () => {
    expect(normalizeSentFiles([{ fullPath: '/a/b/plot.png' }])[0].basename).toBe('plot.png')
  })

  // A chip that opens nothing is worse than no chip.
  it('drops a record with no path, and a non-array payload', () => {
    expect(normalizeSentFiles([{ timestamp: 3 }, null, 'x'])).toEqual([])
    expect(normalizeSentFiles(undefined)).toEqual([])
  })
})
