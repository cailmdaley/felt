/**
 * ProjectPicker's pure halves — the filter and the label, shared now by both
 * forms' project pickers (Stash's combobox and, since Capture's <select> can't
 * host the add row, Capture's too).
 */

import { describe, expect, it } from 'vitest'

import { filterProjects, projectLabel, type PickerProject } from './ProjectPicker.js'

const projects: PickerProject[] = [
  { id: 'local:/dev/felt', name: 'felt', path: '/dev/felt', originId: 'local' },
  { id: 'candide:/home/x/cmbx', name: 'cmbx', path: '/home/x/cmbx', originId: 'candide' },
]

describe('filterProjects', () => {
  it('is the identity on an empty query', () => {
    expect(filterProjects(projects, '   ')).toEqual(projects)
  })

  it('matches a name, case-insensitively', () => {
    expect(filterProjects(projects, 'FE').map((p) => p.id)).toEqual(['local:/dev/felt'])
  })

  it('matches the origin too, so a remote host name narrows the list', () => {
    expect(filterProjects(projects, 'candide').map((p) => p.id)).toEqual(['candide:/home/x/cmbx'])
  })

  it('answers empty when nothing matches', () => {
    expect(filterProjects(projects, 'zzz')).toEqual([])
  })
})

describe('projectLabel', () => {
  it('leaves a local project bare', () => {
    expect(projectLabel(projects[0])).toBe('felt')
  })

  it('qualifies a remote one with its host', () => {
    expect(projectLabel(projects[1])).toBe('cmbx · candide')
  })

  it('falls back to the id when a project has no name', () => {
    expect(projectLabel({ id: 'local:/x', path: '/x', originId: 'local' })).toBe('local:/x')
  })
})
