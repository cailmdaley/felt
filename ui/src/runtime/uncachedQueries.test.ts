// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { keepQueriesUncached } from './uncachedQueries.js'
import './installUncachedQueries.js'

afterEach(() => document.body.replaceChildren())

it('finds what the plain selector finds, and still refuses what the browser refuses', () => {
  document.body.innerHTML = '<p class="a md:b">one</p><p>two</p><b id="c">three</b>'
  expect([...document.querySelectorAll('p')].map(p => p.textContent)).toEqual(['one', 'two'])
  expect(document.body.querySelectorAll('*').length).toBe(3)
  expect(document.querySelector('.a')?.textContent).toBe('one')
  expect(document.querySelector(' .md\\:b ')?.textContent).toBe('one')
  expect(document.createDocumentFragment().querySelectorAll('p').length).toBe(0)
  expect(document.querySelector('#c')?.textContent).toBe('three')
  expect(document.querySelectorAll('p, b').length).toBe(3)
  expect(document.querySelector('body > p:not(.z)')?.textContent).toBe('one')
  expect(() => document.querySelectorAll('p..')).toThrow()
  expect(() => (document.querySelectorAll as unknown as () => unknown).call(document)).toThrow()
  expect(() => document.querySelector.call({} as Document, 'p')).toThrow()
  expect(() => document.querySelector(Symbol('p') as unknown as string)).toThrow(TypeError)
})

it('asks the browser for a list of the selector twice exactly where WebKit would keep the result', () => {
  // A fresh window, with a recorder standing in for each of the browser's methods beneath the installed ones.
  const view = document.body.appendChild(document.createElement('iframe')).contentWindow as Window & typeof globalThis
  const asked: unknown[] = []
  const record = function (selectors: string): never { asked.push(selectors); return null as never }
  for (const proto of [view.Document.prototype, view.DocumentFragment.prototype, view.Element.prototype]) { proto.querySelector = record; proto.querySelectorAll = record }
  new view.Function(`(${keepQueriesUncached.toString()})()`)()
  const twice = (selector: string): string => `${selector},${selector}`
  const kept = ['p', ' p\n', 'P', '*', '.c', 'p.c', '.md\\:flex', '.\\31 0', '.\\32 xl\\:flex', '.a\\ b', '.c\\,x', '/*a,b*/p', 'p/* */', 'p\\', '\u00a0p', 'p\u000b']
  const left = ['p,p', 'body p', 'a>b', 'a+b', 'a~b', '#b', '[data-x]', 'p:not(q)', 'p:not(\\.c', '[a="\\62 ', '']
  const nodes = [view.document, view.document.createDocumentFragment(), view.document.createElement('div')]
  for (const node of nodes) for (const method of ['querySelector', 'querySelectorAll'] as const) {
    asked.length = 0
    for (const selector of [...kept, ...left]) (node[method] as (selectors: string) => unknown)(selector)
    expect(asked).toEqual([...kept.map(twice), ...left])
  }
  asked.length = 0
  nodes[0].querySelectorAll(new String('p') as unknown as string)
  expect(asked).toEqual(['p,p'])
  expect(view.Element.prototype.querySelectorAll.name).toBe('record')
})
