/**
 * The sent-files trail: what the endpoint hands over, and how its files are
 * named.
 */

import { describe, expect, it } from 'vitest'
import { normalizeSentFiles, sentFileSends } from './sentFiles.js'

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

describe('sentFileSends', () => {
  const receipt = (fullPath: string, timestamp: number, sessionId = 'session'): ReturnType<typeof normalizeSentFiles>[number] => ({
    fullPath,
    basename: fullPath.split('/').pop()!,
    timestamp,
    sessionId,
  })

  it('keeps several paths from one send in one row and leaves other sessions out', () => {
    expect(sentFileSends([
      receipt('/tmp/z.png', 20),
      receipt('/tmp/a.pdf', 20),
      receipt('/tmp/other.png', 20, 'other-session'),
    ], 'session')).toEqual([{
      id: 'session:20',
      sessionId: 'session',
      timestamp: 20,
      files: [receipt('/tmp/a.pdf', 20), receipt('/tmp/z.png', 20)],
    }])
  })

  it('keeps separate sends apart and does not invent a time for undated receipts', () => {
    const sends = sentFileSends([
      receipt('/tmp/late.png', 30),
      receipt('/tmp/early.png', 10),
      receipt('/tmp/unknown.png', 0),
    ], 'session')
    expect(sends).toMatchObject([
      { timestamp: 10, files: [{ basename: 'early.png' }] },
      { timestamp: 30, files: [{ basename: 'late.png' }] },
      { files: [{ basename: 'unknown.png' }] },
    ])
    expect(sends[2]).not.toHaveProperty('timestamp')
  })
})
