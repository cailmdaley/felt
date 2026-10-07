import { describe, expect, it } from 'vitest'
import {
  buildChannel, defaultSelection, docKey, documentKind, documentLabels, documentLabelMetadata, fallbackSelection,
  fiberKey, normalizeAbsolutePath, parseDocKey, proseDocument, type ChannelInput, type WorkspaceDocument,
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
    for (const ext of ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'opus']) expect(documentKind(`/x/sound.${ext}`)).toBe('audio')
    for (const ext of ['mp4', 'm4v', 'mov', 'webm']) expect(documentKind(`/x/movie.${ext}`)).toBe('video')
    expect(documentKind('/x/archive.zip')).toBe('other')
  })
})

describe('frame metadata', () => {
  const now = Date.parse('2026-10-05T12:00:00Z')
  it('carries genuine modification time and never substitutes creation or previous metadata', () => {
    const first = buildChannel({ ...base, modifiedAt: '2026-10-05T11:00:00Z' })
    expect(proseDocument(first)?.modifiedAt).toBe('2026-10-05T11:00:00Z')
    expect(documentLabelMetadata(proseDocument(first)!, 'Constitution', base.owner, now)).toEqual({ title: '', summary: 'Last changed 1h ago' })
    const unknown = proseDocument(buildChannel({ ...base, previous: first }))!
    expect(unknown.modifiedAt).toBeUndefined()
    expect(documentLabelMetadata(unknown, 'Note', base.owner, now)).toEqual({ title: '', summary: 'Last changed unknown' })
    expect(documentLabelMetadata({ ...unknown, modifiedAt: 'invalid' }, 'Note', base.owner, now).summary).toBe('Last changed unknown')
  })

  it('shows arrival and receipts without agent or same-owner host, and names foreign owners', () => {
    const report = { ...file(base.owner, '/report.html'), provenance: [
      { kind: 'embed' as const, title: 'Results' },
      { kind: 'sent' as const, time: now - 7200000, worker: 'sol' },
      { kind: 'sent' as const, time: now - 3600000, worker: 'sol' },
    ] }
    expect(documentLabelMetadata(report, 'report', base.owner, now)).toEqual({ title: 'Results', summary: 'sent 1h ago · 2 receipts' })
    expect(documentLabelMetadata({ ...report, owner: 'host-b' }, 'report', base.owner, now).summary).toBe('sent 1h ago · 2 receipts · host-b')
    expect(documentLabelMetadata({ ...report, provenance: report.provenance.slice(0, 1) }, 'report', base.owner, now)).toEqual({ title: 'Results', summary: 'embedded' })
  })
})

describe('buildChannel', () => {
  it('keeps the raw source body and extracts declared embeds as owner-aware documents', () => {
    const channel = buildChannel(base)
    expect(channel.body).toBe(base.body)
    expect(channel.documents.map((document) => document.key)).toEqual([
      'host-a:/store/project/task/report.html', 'fiber:host-a:fiber-1',
    ])
    expect(channel.documents[0]).toMatchObject({
      name: 'report.html', kind: 'html',
      provenance: [{ kind: 'embed', title: 'Results' }],
    })
    expect(channel.labels).toEqual(['Results', 'Note'])
    expect(channel.documents[1].path).toBe('/store/project/task/task.md')
  })

  it('labels the fiber page as a Note or Constitution according to Shuttle presence', () => {
    expect(buildChannel({ ...base, body: 'plain text' }).labels[0]).toBe('Note')
    expect(buildChannel({ ...base, body: 'plain text', isConstitution: true }).labels[0]).toBe('Constitution')
  })

  it('honors explicit embeds while preserving the unmodified source body', () => {
    const channel = buildChannel({
      ...base,
      embeds: [{ path: 'explicit.pdf', title: 'Explicit' }],
    })
    expect(channel.body).toBe(base.body)
    expect(channel.documents.map((document) => document.name)).toEqual(['explicit.pdf', 'A channel'])
    expect(channel.documents[0].provenance).toEqual([{ kind: 'embed', title: 'Explicit' }])
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
    expect(channel.documents[0]).toMatchObject({ owner: 'host-a', path: '/store/project/task/report.html' })
    expect(channel.documents[0].provenance).toEqual([
      { kind: 'embed', title: 'Results' },
      { kind: 'sent', time: 10, session: 'session-1' },
      { kind: 'sent', time: 20, session: 'session-2', worker: 'sol' },
      { kind: 'link', title: 'linked report' },
    ])
    expect(channel.documents[1].kind).toBe('fiber')
    expect(channel.documents[2]).toMatchObject({ owner: 'host-b', path: '/store/project/task/report.html' })
    expect(channel.documents[2].provenance).toEqual([{ kind: 'sent', time: 15, session: 'remote' }])
  })

  it('runs declarations leftward from the fiber page in body order and deliveries rightward, newest first, retaining receipt history', () => {
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
      'first.html', 'second.html', 'A channel', 'later.pdf', 'earlier.pdf',
    ])
    expect(second.documents.map((document) => document.name)).toEqual([
      'first.html', 'new-report.html', 'A channel', 'arrival.txt', 'later.pdf', 'earlier.pdf',
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
    expect(defaultSelection(declared)).toBe(declared.documents.find(d => d.name === 'report.html')?.key)
    const sent = buildChannel({ ...base, embeds: [{ path: 'notes.md' }], sent: [{ path: 'sent/report.html', time: 10 }] })
    expect(defaultSelection(sent)).toBe(sent.documents.find(d => d.name === 'report.html')?.key)
    const withoutReport = buildChannel({ ...base, embeds: [{ path: 'notes.md' }] })
    expect(defaultSelection(withoutReport)).toBe(proseDocument(withoutReport)?.key)
  })

  it('falls back toward the fiber page from either side, then to the fiber page', () => {
    const prose = 'fiber:host:u'
    const run = ['l2', 'l1', prose, 'r1', 'r2']
    expect(fallbackSelection(run, run, 'r1')).toBe('r1')
    // Right of the fiber page: the neighbour nearer it, never the far one.
    expect(fallbackSelection(run, ['l2', 'l1', prose, 'r2'], 'r1')).toBe(prose)
    expect(fallbackSelection(run, ['l2', 'l1', prose, 'r1'], 'r2')).toBe('r1')
    expect(fallbackSelection(run, ['l2', 'new', 'l1', prose, 'r1'], 'r2')).toBe('r1')
    // Left of it, the same walk rightward.
    expect(fallbackSelection(run, ['l1', prose, 'r1', 'r2'], 'l2')).toBe('l1')
    expect(fallbackSelection(run, ['l2', prose, 'r1', 'r2'], 'l1')).toBe(prose)
    // Nothing between survives: the fiber page.
    expect(fallbackSelection(run, [prose, 'l2'], 'r2')).toBe(prose)
    expect(fallbackSelection(['a'], [], 'a')).toBeUndefined()
  })

  it('uses the shortest unique path suffix and expands short directory segments', () => {
    const documents = [
      file('host-a', '/store/project/redesign-2/a/report.html'),
      file('host-a', '/store/project/redesign-2/b/report.html'),
      file('host-a', '/store/project/redesign-2/c/report.html'),
      file('host-a', '/store/project/redesign-2/a/comment.md'),
      file('host-a', '/store/project/redesign-2/b/comment.md'),
      file('host-a', '/store/project/redesign-2/d/index.html'),
    ]
    expect(documentLabels(documents)).toEqual([
      'redesign-2/a', 'redesign-2/b', 'redesign-2/c',
      'redesign-2/a/comment.md', 'redesign-2/b/comment.md', 'redesign-2/d',
    ])
    expect(documentLabels([file('host-a', '/store/project/redesign-2/a/b/c/report.html')]))
      .toEqual(['redesign-2/a/b/c'])
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
      'Note', 'host-a:task/a', 'task/b', 'host-b:task/a',
      'task/a/result.json', 'task/b/result.json',
    ])
    expect(new Set(documentLabels(documents)).size).toBe(documents.length)
  })
})
