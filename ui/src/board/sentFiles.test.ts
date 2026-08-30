/**
 * The sent-files trail: what the endpoint hands over, and which slice of it
 * belongs to a given day.
 */

import { describe, expect, it } from 'vitest'
import {
  disambiguateBasenames,
  normalizeSentFiles,
  sentFilesInWindow,
  sentFilesRevision,
} from './sentFiles.js'

const at = (h: number, min = 0): number => new Date(2026, 7, 11, h, min).getTime()
const DAY_START = at(6)
const DAY_END = at(6) + 24 * 60 * 60 * 1000

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

describe('sentFilesRevision', () => {
  it('changes when a worker sends the same path again', () => {
    const old = normalizeSentFiles([{ fullPath: '/a/report.html', timestamp: 10 }])
    const newer = normalizeSentFiles([{ fullPath: '/a/report.html', timestamp: 11 }])

    expect(sentFilesRevision(old)).not.toBe(sentFilesRevision(newer))
  })
})

describe('sentFilesInWindow', () => {
  const files = normalizeSentFiles([
    { fullPath: '/a/morning.html', timestamp: at(9) },
    { fullPath: '/a/evening.html', timestamp: at(21) },
    { fullPath: '/a/yesterday.html', timestamp: at(9) - 24 * 60 * 60 * 1000 },
  ])

  it('keeps today and drops the days around it, newest first', () => {
    expect(sentFilesInWindow(files, DAY_START, DAY_END).map((f) => f.basename)).toEqual([
      'evening.html',
      'morning.html',
    ])
  })

  // Half-open, like the rail: 06:00 opens the day it belongs to.
  it('puts a send at the boundary in the day that opens there', () => {
    const edge = normalizeSentFiles([
      { fullPath: '/a/dawn.html', timestamp: DAY_START },
      { fullPath: '/a/dusk.html', timestamp: DAY_END },
    ])
    expect(sentFilesInWindow(edge, DAY_START, DAY_END).map((f) => f.basename)).toEqual([
      'dawn.html',
    ])
  })

  it('says nothing when nothing was sent today', () => {
    expect(sentFilesInWindow(files, DAY_END, DAY_END + 1000)).toEqual([])
  })

  // Disambiguation runs AFTER the filter, so a label describes the set shown.
  it('names two same-named files apart only when both are on the day', () => {
    const twins = normalizeSentFiles([
      { fullPath: '/a/morning-post/report.html', timestamp: at(9) },
      { fullPath: '/a/standalone/report.html', timestamp: at(10) },
    ])
    expect(sentFilesInWindow(twins, DAY_START, DAY_END).map((f) => f.basename)).toEqual([
      'standalone/report.html',
      'morning-post/report.html',
    ])
    const one = sentFilesInWindow(twins, at(9, 30), DAY_END)
    expect(one.map((f) => f.basename)).toEqual(['report.html'])
  })
})

describe('disambiguateBasenames', () => {
  it('leaves a unique basename bare and does not mutate its input', () => {
    const files = normalizeSentFiles([{ fullPath: '/a/b/one.html', timestamp: 1 }])
    const out = disambiguateBasenames(files)
    expect(out[0].basename).toBe('one.html')
    expect(files[0].basename).toBe('one.html')
    expect(out[0]).not.toBe(files[0])
  })

  it('walks up as far as it takes to tell three collisions apart', () => {
    const out = disambiguateBasenames(
      normalizeSentFiles([
        { fullPath: '/x/one/deep/report.html', timestamp: 1 },
        { fullPath: '/x/two/deep/report.html', timestamp: 2 },
        { fullPath: '/x/three/deep/report.html', timestamp: 3 },
      ]),
    )
    expect(out.map((f) => f.basename)).toEqual([
      'one/deep/report.html',
      'two/deep/report.html',
      'three/deep/report.html',
    ])
  })
})
