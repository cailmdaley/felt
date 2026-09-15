/**
 * Attachment extraction: a body's `:::{embed}` declarations become a list, and
 * nothing of them survives in the prose.
 */

import { describe, expect, it } from 'vitest'
import {
  attachmentGlyph,
  extractEmbeds,
  fileKind,
  fileTapAction,
  formatBytes,
  previewText,
} from './attachments.js'

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

describe('fileKind', () => {
  it('sorts the kinds the browser can show from the ones it cannot', () => {
    expect(fileKind('plot.PNG')).toBe('image')
    expect(fileKind('take.m4a')).toBe('audio')
    expect(fileKind('report.html')).toBe('html')
    expect(fileKind('notes.md')).toBe('markdown')
    expect(fileKind('run.log')).toBe('text')
    expect(fileKind('config.yaml')).toBe('text')
    expect(fileKind('paper.pdf')).toBe('pdf')
    expect(fileKind('bundle.zip')).toBe('other')
    expect(fileKind('Makefile')).toBe('other')
  })

  it('keeps an astra.yaml on the paper (iframe) path, not the text one', () => {
    expect(fileKind('analysis/astra.yaml')).toBe('html')
  })
})

describe('fileTapAction', () => {
  it('sends a mouse to the Reader whatever the kind', () => {
    for (const p of ['a.pdf', 'a.zip', 'a.md', 'a.png']) {
      expect(fileTapAction(false, p)).toBe('read')
    }
  })

  it('keeps a finger in the Reader for anything the browser can lay out', () => {
    expect(fileTapAction(true, 'report.html')).toBe('read')
    expect(fileTapAction(true, 'notes.md')).toBe('read')
    expect(fileTapAction(true, 'run.log')).toBe('read')
    expect(fileTapAction(true, 'plot.png')).toBe('read')
    expect(fileTapAction(true, 'take.m4a')).toBe('read')
  })

  it('hands a finger the file itself only where the native viewer is better', () => {
    expect(fileTapAction(true, 'paper.pdf')).toBe('download')
    expect(fileTapAction(true, 'bundle.zip')).toBe('download')
    expect(fileTapAction(true, 'Makefile')).toBe('download')
  })
})

describe('previewText', () => {
  it('takes the opening lines and skips the blank ones above them', () => {
    expect(previewText('\n\none\ntwo\nthree', 2)).toBe('one\ntwo')
  })

  it('caps a long line so it cannot crowd out the rest', () => {
    const out = previewText('x'.repeat(200), 6, 20)
    expect(out).toHaveLength(20)
    expect(out.endsWith('…')).toBe(true)
  })

  it('has nothing to say about an empty slice', () => {
    expect(previewText('   \n\n  ')).toBe('')
  })
})
