/**
 * Attachment extraction: a body's `:::{embed}` declarations become a list, and
 * nothing of them survives in the prose.
 */

import { describe, expect, it } from 'vitest'
import { attachmentGlyph, extractEmbeds, fileTapAction, formatBytes } from './attachments.js'

describe('extractEmbeds', () => {
  it('pulls an embed out and leaves the prose clean', () => {
    const md = 'Before.\n\n:::{embed} report.html\n:::\n\nAfter.'
    const { body, attachments } = extractEmbeds(md)
    expect(attachments).toEqual([{ path: 'report.html' }])
    expect(body).toBe('Before.\n\nAfter.')
  })

  it('keeps :title: and drops the other options', () => {
    const md = ':::{embed} figs/plot.png\n:title: Covariance\n:height: 400\n:::\n\nText.'
    const { body, attachments } = extractEmbeds(md)
    expect(attachments).toEqual([{ path: 'figs/plot.png', title: 'Covariance' }])
    expect(body).toBe('Text.')
  })

  it('keeps body order across several embeds', () => {
    const md = ':::{embed} a.pdf\n:::\n\nmid\n\n:::{embed} /abs/b.html\n:title: B\n:::\n'
    const { body, attachments } = extractEmbeds(md)
    expect(attachments.map((a) => a.path)).toEqual(['a.pdf', '/abs/b.html'])
    expect(attachments[1].title).toBe('B')
    expect(body).toBe('mid')
  })

  it('leaves a body with no embeds untouched apart from trimming', () => {
    const md = 'Just prose.\n\nWith a paragraph.'
    expect(extractEmbeds(md)).toEqual({ body: md, attachments: [] })
  })

  it('collapses an embed-only body to nothing', () => {
    expect(extractEmbeds(':::{embed} report.html\n:::\n').body).toBe('')
  })

  it('ignores a fenced-looking line that is not an embed directive', () => {
    const md = ':::{note}\nnot an embed\n:::'
    expect(extractEmbeds(md).attachments).toEqual([])
  })
})

describe('attachmentGlyph', () => {
  it('reads the suffix', () => {
    expect(attachmentGlyph('a/b/report.HTML')).toBe('html')
    expect(attachmentGlyph('plot.png?v=2')).toBe('png')
  })
  it('falls back for a suffixless name', () => {
    expect(attachmentGlyph('Makefile')).toBe('file')
  })
})

describe('formatBytes', () => {
  it('scales to the unit that reads', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
  it('says nothing when there is nothing to say', () => {
    expect(formatBytes(undefined)).toBe('')
  })
})

describe('fileTapAction', () => {
  it('sends a finger straight to the file and a mouse to the Reader', () => {
    expect(fileTapAction(true)).toBe('download')
    expect(fileTapAction(false)).toBe('read')
  })
})
