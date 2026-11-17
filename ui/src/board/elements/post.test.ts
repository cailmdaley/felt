// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { Item } from '../channels.js'
import { card } from '../testFixtures.js'
import { post } from './post.js'

const now = 1_800_000_000_000
const item = (over: Partial<Item> = {}): Item => ({ kind: 'post', id: 'b1', card: card({ id: 'cmbx/tsz', uid: 'T', name: 'tSZ' }), at: now - 120_000, arrived: now, text: 'At **9σ**.', files: [], waiting: false, ...over })

describe('post', () => {
  it('draws who, what kind and when, then its words; a click outside its buttons opens its thread', () => {
    const open = vi.fn(), dot = document.createElement('button')
    const row = post(item(), { now, dot, open })
    expect([row.dataset.kind, row.dataset.slug, row.dataset.fiber, row.firstElementChild === dot]).toStrictEqual(['post', 'tsz', 'T', true])
    expect([...row.querySelectorAll('.kbn-ch-item-head > *')].map(part => part.textContent)).toStrictEqual(['tsz', 'posted', '2m ago'])
    expect(row.querySelector('.kbn-ch-item-text strong')!.textContent).toBe('9σ')
    row.querySelector<HTMLElement>('.kbn-ch-item-text')!.click()
    expect(open).toHaveBeenCalledTimes(1)
  })
  it('on a line names its kind as its button, and carries its clear and its previews', () => {
    const clear = document.createElement('button'), previews = document.createElement('div')
    const row = post(item({ line: 'T:0', waiting: true }), { now, dot: document.createElement('button'), open: () => {}, clear, previews })
    expect([row.dataset.line, row.hasAttribute('data-waiting'), row.querySelector('.kbn-ch-who')!.getAttribute('aria-label')]).toStrictEqual(['T:0', true, 'tsz posted'])
    expect([row.querySelector('.kbn-ch-item-head')!.lastElementChild === clear, row.querySelector('.kbn-ch-item-body')!.lastElementChild === previews]).toStrictEqual([true, true])
  })
})
