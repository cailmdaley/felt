import { describe, expect, it } from 'vitest'
import type { MapFile } from '../family/model.js'
import { fiberHolding, sendLines, sentMark } from './sendLines.js'

const sent = (path: string, at: number): MapFile => ({ key: `host-a:${path}`, name: path.split('/').pop()!, at, unread: false })
const fibers = [
  { id: 'cmbx', name: 'CMB-lensing cross-correlation', fiberDir: '/loom/cmbx' },
  { id: 'cmbx/gc-forensics', name: 'GC forensics', fiberDir: '/loom/cmbx/gc-forensics' },
  { id: 'cmbx/meetings/oct-14', name: 'Meeting, 14 October', fiberDir: '/loom/cmbx/meetings/oct-14/' },
  { id: 'cmbx/noise-study', name: 'Why the noise spectrum has a bump at ell of four hundred', fiberDir: '/loom/cmbx/noise-study' },
]
const at = (path: string): string | undefined => fiberHolding(path, fibers)
const labels = (files: MapFile[]): string[][] => sendLines(files, at).map(send => send.files.map(file => file.label))

describe('sends', () => {
  it('puts the files of one send on one line, newest send first, named files before figures', () => {
    const lines = sendLines([sent('/x/a.png', 3), sent('/x/b.py', 3), sent('/x/c.md', 1), sent('/x/d.pdf', 3)], at)
    expect(lines.map(line => line.at)).toEqual([3, 1])
    expect(lines[0].files.map(file => [file.label, file.mark])).toEqual([['x/b.py', 'code'], ['x/d.pdf', 'pdf'], ['x/a.png', 'image']])
  })
  it('names a file by the deepest fiber whose directory holds it, by slug when the name is long', () => {
    expect(labels([
      sent('/loom/cmbx/gc-forensics/report.html', 5), sent('/loom/cmbx/meetings/oct-14/report.html', 4),
      sent('/loom/cmbx/noise-study/report.html', 3), sent('/loom/cmbx/report.html', 2),
    ])).toEqual([['GC forensics'], ['Meeting, 14 October'], ['noise-study'], ['CMB-lensing cross-correlation']])
  })
  it('names a fiber\'s file by the fiber when it is the send\'s only one from there, else by its own name, its companion page by the fiber', () => {
    expect(labels([sent('/loom/cmbx/gc-forensics/fit.py', 2)])).toEqual([['GC forensics']])
    expect(labels([sent('/loom/cmbx/gc-forensics/report.html', 2), sent('/loom/cmbx/gc-forensics/fit.py', 2)])).toEqual([['GC forensics', 'fit.py']])
  })
  it('names a file outside every fiber with its directory', () => {
    expect(labels([sent('/scratch/plots/fig.png', 1), sent('/top.md', 1)])).toEqual([['top.md', 'plots/fig.png']])
    expect(fiberHolding('/loom/cmbx-other/a.md', fibers), 'a sibling directory sharing a prefix is not inside').toBeUndefined()
  })
  it('names a file with no path it can read by its name, and draws it with a glyph', () => {
    expect(sendLines([{ key: 'doc:new.png', name: 'new.png', at: 1, unread: false }], at)[0].files[0]).toMatchObject({ label: 'new.png', mark: 'other' })
  })
  it('marks figures, pages, PDFs and code apart from everything else', () => {
    expect(['a.svg', 'a.webp', 'a.html', 'a.pdf', 'a.sh', 'a.ipynb', 'a.md', 'a.csv'].map(sentMark)).toEqual(['image', 'image', 'page', 'pdf', 'code', 'code', 'other', 'other'])
  })
})
