// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { changeTree } from './changeTree.js'
import type { ChangeFile } from './changeModel.js'

const file = (path: string, role: ChangeFile['role'] = 'implementation', status = 'added'): ChangeFile => ({
  path, role, status, additions: 2, deletions: 0, header: '', lines: [], hunks: [], remaining: [],
})

describe('change file tree', () => {
  it('compacts directory chains, separates roles, marks status and jumps by file identity', () => {
    const code = file('src/shear/nz_bins.py')
    let destination: ChangeFile | undefined
    const tree = changeTree([file('tests/unit/bins.py', 'test', 'modified'), code, file('schema.json', 'generated')], f => { destination = f })
    expect([...tree.querySelectorAll('summary')].map(node => node.textContent)).toEqual(['src/shear/1', 'tests/unit/1'])
    expect([...tree.querySelectorAll('[data-group]')].map(node => node.getAttribute('data-group'))).toEqual(['implementation', 'tests', 'generated'])
    expect(tree.querySelector('[data-file="src/shear/nz_bins.py"] .change-tree-status')!.textContent).toBe('new')
    expect(tree.querySelector('[data-file="tests/unit/bins.py"] .change-tree-status')!.textContent).toBe('')
    tree.querySelector<HTMLButtonElement>('[data-file="src/shear/nz_bins.py"]')!.click()
    expect(destination).toBe(code)
    expect(tree.textContent).toContain('+2 −0')
  })

  it('lists subdirectories before files at each level', () => {
    const tree = changeTree([file('src/a.py'), file('src/z/b.py'), file('src/z/c.py'), file('src/y/d.py')], () => {})
    const src = tree.querySelector('details')!.querySelector('.change-tree-children')!
    expect([...src.children].map(node => node.querySelector('.change-tree-path')!.textContent)).toEqual(['y/', 'z/', 'a.py'])
  })

  it('opens directories breadth-first within forty rows, folding any past twelve entries', () => {
    const wide = changeTree(Array.from({ length: 13 }, (_, i) => file(`src/value${i}.py`)), () => {})
    expect(wide.querySelector('details')!.open).toBe(false)
    const nested = changeTree(Array.from({ length: 30 }, (_, i) => file(`src/group${Math.floor(i / 10)}/value${i}.py`)), () => {})
    expect([...nested.querySelectorAll('details')].every(node => node.open)).toBe(true)
    const large = changeTree(Array.from({ length: 100 }, (_, i) => file(`src/group${Math.floor(i / 10)}/value${i}.py`)), () => {})
    expect([...large.querySelectorAll('details')].map(node => node.open)).toEqual([true, true, true, ...Array(8).fill(false)])
    expect(large.querySelectorAll('button')).toHaveLength(100)
  })
})
