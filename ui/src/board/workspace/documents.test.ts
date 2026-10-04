import { describe, expect, it } from 'vitest'
import {
  buildChannel, defaultSelection, docKey, documentKind, documentLabels, fallbackSelection,
  fiberKey, normalizeAbsolutePath, parseDocKey, type ChannelInput, type WorkspaceDocument,
} from './documents.js'

const base: ChannelInput = {
  uid: 'fiber-1', owner: 'host-a', name: 'A channel',
  path: 'task.md', fiberDir: '/store/project/task', body: 'Read the report.\n\n:::{embed} report.html\n:title: Results\n:::\n',
}

const file = (owner: string, path: string, name = path.split('/').pop() ?? path): WorkspaceDocument => ({
  key: docKey(owner, path, owner), owner, path, name, kind: documentKind(path), provenance: [],
})

describe('document identity and kinds', () => {
  it('normalizes absolute and fiber-relative POSIX paths without touching the filesystem', () => {
    expect(normalizeAbsolutePath('../reports/./latest.html', '/store/project/task')).toBe('/store/project/reports/latest.html')
    expect(normalizeAbsolutePath('/store//project/../report.pdf')).toBe('/store/report.pdf')
    expect(normalizeAbsolutePath('../../../../report.html', '/store/task')).toBe('/report.html')
  })

  it('round-trips owner-aware file keys and rejects fiber or malformed keys', () => {
    const key = docKey('local', '../output/report.html', 'host-a', '/store/task')
    expect(key).toBe('host-a:/store/output/report.html')
    expect(parseDocKey(key)).toEqual({ owner: 'host-a', path: '/store/output/report.html' })
    expect(parseDocKey('host-a:/store/../bad')).toBeNull()
    expect(parseDocKey('fiber:host-a:uid')).toBeNull()
    expect(parseDocKey(':/absolute/path')).toBeNull()
    expect(parseDocKey('host-a:relative/path')).toBeNull()
    expect(fiberKey('host-a', 'uid')).toBe('fiber:host-a:uid')
  })

  it('uses the shared file-renderer extension vocabulary', () => {
    expect(documentKind('/x/REPORT.HTM')).toBe('html')
    expect(documentKind('/x/scan.PDF')).toBe('pdf')
    expect(documentKind('/x/map.SVG')).toBe('image')
    expect(documentKind('/x/notes.markdown')).toBe('text')
    expect(documentKind('/x/source.rs')).toBe('text')
    expect(documentKind('/x/sound.mp3')).toBe('other')
    expect(documentKind('/x/archive.zip')).toBe('other')
  })
})

describe('buildChannel', () => {
  it('keeps the raw source body and extracts declared embeds as owner-aware documents', () => {
    const channel = buildChannel(base)
    expect(channel.body).toBe(base.body)
    expect(channel.documents.map((document) => document.key)).toEqual([
      'fiber:host-a:fiber-1', 'host-a:/store/project/task/report.html',
    ])
    expect(channel.documents[1]).toMatchObject({
      name: 'report.html', kind: 'html',
      provenance: [{ kind: 'embed', title: 'Results' }],
    })
    expect(channel.labels).toEqual(['Prose', 'task'])
    expect(channel.documents[0].path).toBe('/store/project/task/task.md')
  })

  it('honors explicit embeds while preserving the unmodified source body', () => {
    const channel = buildChannel({
      ...base,
      embeds: [{ path: 'explicit.pdf', title: 'Explicit' }],
    })
    expect(channel.body).toBe(base.body)
    expect(channel.documents.map((document) => document.name)).toEqual(['A channel', 'explicit.pdf'])
    expect(channel.documents[1].provenance).toEqual([{ kind: 'embed', title: 'Explicit' }])
  })

  it('merges embed, send, and link provenance by owner and normalized path', () => {
    const channel = buildChannel({
      ...base,
      embeds: [{ path: 'sub/../report.html', title: 'Results' }],
      sent: [
        { path: 'report.html', owner: 'local', time: 20, session: 'session-2', worker: 'sol' },
        { path: 'report.html', owner: 'host-a', time: 10, session: 'session-1' },
        { path: 'report.html', owner: 'host-b', time: 15, session: 'remote' },
      ],
      links: [{ path: 'report.html', title: 'linked report' }],
    })
    expect(channel.documents).toHaveLength(3)
    expect(channel.documents[1]).toMatchObject({ owner: 'host-a', path: '/store/project/task/report.html' })
    expect(channel.documents[1].provenance).toEqual([
      { kind: 'embed', title: 'Results' },
      { kind: 'sent', time: 10, session: 'session-1' },
      { kind: 'sent', time: 20, session: 'session-2', worker: 'sol' },
      { kind: 'link', title: 'linked report' },
    ])
    expect(channel.documents[2]).toMatchObject({ owner: 'host-b', path: '/store/project/task/report.html' })
    expect(channel.documents[2].provenance).toEqual([{ kind: 'sent', time: 15, session: 'remote' }])
  })

  it('sorts new deliveries by first arrival while retaining prior page order and receipts', () => {
    const first = buildChannel({
      ...base,
      embeds: [{ path: 'second.html' }, { path: 'first.html' }],
      sent: [
        { path: 'later.pdf', time: 40, session: 'late' },
        { path: 'earlier.pdf', time: 30, session: 'early' },
      ],
    })
    const second = buildChannel({
      ...base,
      embeds: [{ path: 'new-report.html' }, { path: 'first.html' }],
      sent: [
        { path: 'later.pdf', time: 40, session: 'late' },
        { path: 'later.pdf', time: 50, session: 'resend' },
        { path: 'earlier.pdf', time: 30, session: 'early' },
        { path: 'arrival.txt', time: 60, session: 'new' },
      ],
      previous: first,
    })
    expect(first.documents.map((document) => document.name)).toEqual([
      'A channel', 'second.html', 'first.html', 'earlier.pdf', 'later.pdf',
    ])
    expect(second.documents.map((document) => document.name)).toEqual([
      'A channel', 'first.html', 'earlier.pdf', 'later.pdf', 'new-report.html', 'arrival.txt',
    ])
    expect(second.documents.find((document) => document.name === 'later.pdf')?.provenance)
      .toEqual([
        { kind: 'sent', time: 40, session: 'late' },
        { kind: 'sent', time: 50, session: 'resend' },
      ])
    expect(first.documents.find((document) => document.name === 'later.pdf')?.provenance)
      .toEqual([{ kind: 'sent', time: 40, session: 'late' }])
    expect(first.body).toBe(base.body)
  })

  it('does not carry a removed declaration forward, and ignores another channel’s prior state', () => {
    const previous = buildChannel({ ...base, embeds: [{ path: 'old.html' }] })
    const current = buildChannel({ ...base, body: 'plain text', previous })
    const unrelated = buildChannel({ ...base, uid: 'other', body: 'plain text', previous })
    expect(current.documents.map((document) => document.name)).toEqual(['A channel'])
    expect(unrelated.documents.map((document) => document.name)).toEqual(['A channel'])
  })
})

describe('selection and labels', () => {
  it('starts at a declared report, then any delivered report, otherwise prose', () => {
    const declared = buildChannel({ ...base, embeds: [{ path: 'reports/report.html' }, { path: 'notes.md' }] })
    expect(defaultSelection(declared)).toBe(declared.documents[1].key)
    const sent = buildChannel({ ...base, embeds: [{ path: 'notes.md' }], sent: [{ path: 'sent/report.html', time: 10 }] })
    expect(defaultSelection(sent)).toBe(sent.documents[2].key)
    const withoutReport = buildChannel({ ...base, embeds: [{ path: 'notes.md' }] })
    expect(defaultSelection(withoutReport)).toBe(withoutReport.documents[0].key)
  })

  it('falls back to the page at the old position, then the prior page', () => {
    expect(fallbackSelection(['a', 'b', 'c'], ['a', 'b', 'c'], 'b')).toBe('b')
    expect(fallbackSelection(['a', 'b', 'c'], ['a', 'c'], 'b')).toBe('c')
    expect(fallbackSelection(['a', 'b', 'c'], ['a'], 'c')).toBe('a')
    expect(fallbackSelection(['a'], [], 'a')).toBeUndefined()
  })

  it('disambiguates duplicate names with the nearest folder and owner', () => {
    const documents = [
      file('host-a', '/store/task/Prose.md', 'Fiber prose'),
      file('host-a', '/store/task/a/report.html'),
      file('host-a', '/store/task/b/report.html'),
      file('host-b', '/store/task/a/report.html'),
      file('host-a', '/store/task/a/result.json'),
      file('host-a', '/store/task/b/result.json'),
    ]
    documents[0].kind = 'fiber'
    expect(documentLabels(documents)).toEqual([
      'Prose', 'host-a:a', 'b', 'host-b:a', 'a/result.json', 'b/result.json',
    ])
    expect(new Set(documentLabels(documents)).size).toBe(documents.length)
  })
})
