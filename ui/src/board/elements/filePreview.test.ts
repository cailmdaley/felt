// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Unfold } from './filePreview.js'

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
