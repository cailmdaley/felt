/**
 * The pickers' pure halves — the label, the filter, and the host scoping that
 * decides which projects the project dropdown may show at all.
 *
 * `projectsForHost` is the whole point of the host/project split: a project
 * belonging to another host must never be reachable from the list, because
 * selecting it would send the create (or the "+ Add project…") to a machine
 * other than the one named next door.
 */

import { describe, expect, it } from 'vitest'

import {
  filterProjects,
  projectLabel,
  projectsForHost,
  type PickerProject,
} from './ProjectPicker.js'

const projects: PickerProject[] = [
  { id: 'local:/dev/felt', name: 'felt', path: '/dev/felt', originId: 'local' },
  { id: 'local:/dev/mystra', name: 'mystra', path: '/dev/mystra', originId: 'local' },
  { id: 'candide:/home/x/cmbx', name: 'cmbx', path: '/home/x/cmbx', originId: 'candide' },
]

describe('projectsForHost', () => {
  it('keeps only the selected host’s projects', () => {
    expect(projectsForHost(projects, 'local').map((p) => p.id)).toEqual([
      'local:/dev/felt',
      'local:/dev/mystra',
    ])
  })

  it('scopes to a remote host on its bare name', () => {
    expect(projectsForHost(projects, 'candide').map((p) => p.id)).toEqual(['candide:/home/x/cmbx'])
  })

  it('answers empty for a host with nothing on it yet — the add row’s case', () => {
    expect(projectsForHost(projects, 'cineca')).toEqual([])
  })

  it('answers empty rather than everything when no host is selected', () => {
    expect(projectsForHost(projects, null)).toEqual([])
  })

  it('preserves the incoming order, which is the form’s recency ranking', () => {
    const reversed = [...projects].reverse()
    expect(projectsForHost(reversed, 'local').map((p) => p.id)).toEqual([
      'local:/dev/mystra',
      'local:/dev/felt',
    ])
  })
})

describe('filterProjects', () => {
  it('is the identity on an empty query', () => {
    expect(filterProjects(projects, '   ')).toEqual(projects)
  })

  it('matches a name, case-insensitively', () => {
    expect(filterProjects(projects, 'FE').map((p) => p.id)).toEqual(['local:/dev/felt'])
  })

  it('matches the path, so a directory you remember narrows the list', () => {
    expect(filterProjects(projects, '/home/x').map((p) => p.id)).toEqual(['candide:/home/x/cmbx'])
  })

  it('answers empty when nothing matches', () => {
    expect(filterProjects(projects, 'zzz')).toEqual([])
  })
})

describe('projectLabel', () => {
  it('is the bare name — the host is chosen in its own control', () => {
    expect(projectLabel(projects[0])).toBe('felt')
    expect(projectLabel(projects[2])).toBe('cmbx')
  })

  it('falls back to the id when a project has no name', () => {
    expect(projectLabel({ id: 'local:/x', path: '/x', originId: 'local' })).toBe('local:/x')
  })
})
