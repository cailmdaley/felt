// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error Node types are excluded from the browser UI's tsconfig.
import { readFileSync } from 'node:fs'
import { settle } from '../testFixtures.js'
import { CARD_PX, densityOf, fileRow, foldPx, openFileList, PREVIEW_GAP, previewsHeight, Unfold } from './filePreview.js'

const files = [{ key: 'host:/w/a.html', name: 'a.html' }, { key: 'host:/w/b.png', name: 'b.png' }, { key: 'host:/w/c.md', name: 'c.md' }]
const made = (single = false): { unfold: Unfold; seen: ReturnType<typeof vi.fn> } => {
  const seen = vi.fn(), unfold = new Unfold({ shuttleBase: '', single, seen })
  document.body.append(unfold.el)
  unfold.update(files)
  return { unfold, seen }
}
const press = (el: Element, key: string, init: KeyboardEventInit = {}): boolean => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
const bar = (unfold: Unfold): string[] => [...unfold.el.querySelectorAll('.uf-bar .uf-name, .uf-bar .uf-count')].map(part => part.textContent!)

afterEach(() => { document.body.replaceChildren() })

describe('files that unfold in place', () => {
  it('folded, draws every file in one row, the next peeking; single, only the first', () => {
    const { unfold } = made()
    expect([...unfold.el.querySelectorAll<HTMLElement>('.uf-card')].map(card => card.dataset.key)).toStrictEqual(files.map(file => file.key))
    expect(unfold.el.hasAttribute('data-several')).toBe(true)
    const one = made(true).unfold
    expect(one.el.querySelectorAll('.uf-card')).toHaveLength(1)
    expect(one.el.hasAttribute('data-several')).toBe(false)
  })

  it('unfolds a file in place under its bar, steps with ← and → to the ends and no further, and folds with Escape to its card', () => {
    const { unfold, seen } = made()
    unfold.el.querySelectorAll<HTMLButtonElement>('.uf-card')[1].click()
    expect([unfold.unfolded, unfold.el.hasAttribute('data-unfolded'), bar(unfold)]).toStrictEqual(['host:/w/b.png', true, ['b.png', '2 / 3']])
    expect(unfold.el.querySelector('.uf-row')).toBeNull()
    expect(seen).toHaveBeenLastCalledWith('host:/w/b.png')
    const page = unfold.el.querySelector('.uf-page')!
    press(page, 'ArrowRight')
    expect(bar(unfold)).toStrictEqual(['c.md', '3 / 3'])
    press(page, 'ArrowRight')
    expect(bar(unfold)).toStrictEqual(['c.md', '3 / 3'])
    // A chord is not a step.
    expect(press(page, 'ArrowLeft', { metaKey: true })).toBe(true)
    expect(bar(unfold)).toStrictEqual(['c.md', '3 / 3'])
    expect(press(page, 'Escape')).toBe(false)
    expect(unfold.unfolded).toBeNull()
    expect(document.activeElement).toBe(unfold.el.querySelector('.uf-card[data-key="host:/w/c.md"]'))
  })

  it('offers full screen only when its host can open the file there, and hands it the unfolded file', () => {
    expect(made().unfold.el.querySelector('.uf-full')).toBeNull()
    const full = vi.fn(), unfold = new Unfold({ shuttleBase: '', full })
    document.body.append(unfold.el)
    unfold.update(files)
    unfold.el.querySelectorAll<HTMLButtonElement>('.uf-card')[2].click()
    unfold.el.querySelector<HTMLButtonElement>('.uf-full')!.click()
    expect(full).toHaveBeenCalledExactlyOnceWith('host:/w/c.md')
    expect(unfold.unfolded).toBe('host:/w/c.md')
  })

  it('keeps its cards in place across an update with the same files, focus included, and folds when the unfolded file is gone without taking the focus', () => {
    const { unfold } = made()
    const first = unfold.el.querySelector<HTMLElement>('.uf-card')!
    first.focus()
    unfold.update(files)
    expect([unfold.el.querySelector('.uf-card'), document.activeElement]).toStrictEqual([first, first])
    unfold.unfold('host:/w/c.md')
    const elsewhere = document.body.appendChild(document.createElement('input'))
    elsewhere.focus()
    unfold.update(files.slice(0, 2))
    expect(unfold.unfolded).toBeNull()
    expect(unfold.el.querySelectorAll('.uf-card')).toHaveLength(2)
    expect(document.activeElement).toBe(elsewhere)
  })
})

describe('a file as a row of a list', () => {
  it('draws the card\'s face in a line, kind glyph, name and age, with its caption under it when it has one', () => {
    const now = Date.UTC(2026, 10, 17, 12)
    const row = fileRow({ key: 'host:/w/sweep.png', name: 'sweep.png', at: now - 5 * 60_000, caption: 'The shear sweep, bin 3', unread: true }, now)
    expect([...row.children].map(part => [part.className, part.textContent])).toStrictEqual([
      ['uf-glyph', '▨'], ['uf-file-name', 'sweep.png'], ['el-time uf-age', '5m ago'], ['uf-caption', 'The shear sweep, bin 3'],
    ])
    expect([row.dataset.key, row.hasAttribute('data-unread')]).toStrictEqual(['host:/w/sweep.png', true])
    expect(fileRow({ key: 'host:/w/c.md', name: 'c.md', at: now }, now).querySelector('.uf-caption')).toBeNull()
  })

  it('lists a bar\'s files from its count, the one unfolded marked, and a row unfolds its file in place', async () => {
    const { unfold } = made()
    unfold.el.querySelectorAll<HTMLButtonElement>('.uf-card')[0].click()
    unfold.el.querySelector<HTMLButtonElement>('.uf-count')!.click()
    await settle()
    const rows = [...document.querySelectorAll<HTMLElement>('.kbn-conversation-menu .uf-file-row')]
    expect(rows.map(row => [row.dataset.key, row.hasAttribute('data-current')])).toStrictEqual(files.map((file, i) => [file.key, i === 0]))
    rows[2].closest('button')!.click()
    await settle(); await settle()
    expect([unfold.unfolded, bar(unfold)]).toStrictEqual(['host:/w/c.md', ['c.md', '3 / 3']])
  })
})

describe('a preview\'s box', () => {
  it('takes its size from its density, by the file\'s kind alone, with no content mounted', () => {
    const style = document.createElement('style')
    // The stylesheet as the board ships it: the test reads the sizes CSS sets, not the module's numbers.
    style.textContent = readFileSync('src/board/elements/filePreview.css', 'utf8')
    document.head.append(style)
    const unfold = new Unfold({ shuttleBase: '', awake: () => false })
    document.body.append(unfold.el)
    unfold.update([...files, { key: 'host:/w/plot.svg', name: 'plot.svg', at: Date.now() - 60_000 }])
    // jsdom lays nothing out: the box is the width and the height its rules give it (e2e/channels.mjs measures it drawn).
    const boxes = [...unfold.el.querySelectorAll<HTMLElement>('.uf-card')].map(card => {
      const style = getComputedStyle(card)
      return [card.dataset.density, style.width, style.height, !!card.querySelector('.ws-thumbnail-body, iframe, img')]
    })
    expect(boxes).toStrictEqual([
      ['page', '100%', 'var(--uf-fold)', false],
      ['figure', '100%', 'var(--uf-fold)', false],
      ['card', '100%', `${CARD_PX}px`, false],
      ['figure', '100%', 'var(--uf-fold)', false],
    ])
    // A card has nothing to load: its kind, its name and when it came.
    expect([...unfold.el.querySelector('[data-density="card"]')!.children].map(part => part.textContent)).toStrictEqual(['≡', 'c.md', ''])
    style.remove()
  })
  it('reckons a post\'s previews each on a line of its own, a figure or a page at the fold\'s height and a card at its own', () => {
    expect([densityOf('/w/a.svg'), densityOf('/w/deck.html'), densityOf('/w/notes.md'), densityOf('/w/paper.pdf')]).toStrictEqual(['figure', 'page', 'card', 'card'])
    const three = ['/w/notes.md', '/w/deck.html', '/w/a.png']
    expect([previewsHeight([], 300), previewsHeight(['/w/notes.md'], 300), previewsHeight(three, 300), previewsHeight(three, 200)])
      .toStrictEqual([0, CARD_PX, CARD_PX + 300 + 300 + 2 * PREVIEW_GAP, CARD_PX + 200 + 200 + 2 * PREVIEW_GAP])
    // The fold is a third of the screen, 300px at most, as the stylesheet caps it.
    vi.stubGlobal('innerHeight', 600)
    expect(foldPx()).toBe(198)
    vi.stubGlobal('innerHeight', 1200)
    expect(foldPx()).toBe(300)
    vi.unstubAllGlobals()
    const css = readFileSync('src/board/elements/filePreview.css', 'utf8')
    expect(css).toContain('--uf-fold: min(300px, 33vh);')
    expect(css).toContain(`flex-direction: column; gap: ${PREVIEW_GAP}px;`)
  })
})

describe('a list of files', () => {
  it('lists them newest first, whatever order it is given', async () => {
    const anchor = document.body.appendChild(document.createElement('button'))
    openFileList(anchor, [{ key: 'host:/w/a.md', name: 'a.md', at: 1 }, { key: 'host:/w/c.md', name: 'c.md', at: 3 }, { key: 'host:/w/b.md', name: 'b.md', at: 2 }], () => {})
    await settle()
    expect([...document.querySelectorAll<HTMLElement>('.uf-file-row')].map(row => row.dataset.key)).toStrictEqual(['host:/w/c.md', 'host:/w/b.md', 'host:/w/a.md'])
  })
})

describe('the list an unfolded file\'s count opens', () => {
  it('follows the files while it is open', async () => {
    const { unfold } = made()
    unfold.unfold(files[0].key)
    unfold.el.querySelector<HTMLButtonElement>('.uf-count')!.click()
    await settle()
    const rows = (): string[] => [...document.querySelectorAll<HTMLElement>('.kbn-conversation-menu .uf-file-row')].map(row => row.dataset.key!)
    expect(rows()).toHaveLength(3)
    unfold.update([...files, { key: 'host:/w/d.md', name: 'd.md', at: 9 }])
    expect(rows()).toStrictEqual(['host:/w/d.md', ...files.map(file => file.key)])
  })
})
