/**
 * The pickers' pure halves — the label, the host scoping that decides which
 * projects the project select may show at all, and the sentinel rule that keeps
 * "Add a new project…" from ever becoming a selected state.
 *
 * `projectsForHost` is the whole point of the host/project split: a project
 * belonging to another host must never be reachable from the list, because
 * selecting it would send the create (or the "+ Add project…") to a machine
 * other than the one named next door.
 */

import { describe, expect, it } from 'vitest'

import {
  ADD_PROJECT_VALUE,
  interpretProjectChange,
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

describe('projectLabel', () => {
  it('is the bare name — the host is chosen in its own control', () => {
    expect(projectLabel(projects[0])).toBe('felt')
    expect(projectLabel(projects[2])).toBe('cmbx')
  })

  it('falls back to the id when a project has no name', () => {
    expect(projectLabel({ id: 'local:/x', path: '/x', originId: 'local' })).toBe('local:/x')
  })
})

describe('interpretProjectChange', () => {
  it('reads a real project id as a selection', () => {
    expect(interpretProjectChange('local:/dev/felt')).toEqual({
      kind: 'select',
      id: 'local:/dev/felt',
    })
  })

  it('reads the add sentinel as the add flow, never as a selection', () => {
    expect(interpretProjectChange(ADD_PROJECT_VALUE)).toEqual({ kind: 'add' })
  })

  it('ignores the empty placeholder rather than selecting nothing', () => {
    expect(interpretProjectChange('')).toEqual({ kind: 'ignore' })
  })

  it('keeps the sentinel out of the id space — no project can collide with it', () => {
    expect(projects.some((p) => p.id === ADD_PROJECT_VALUE)).toBe(false)
    expect(ADD_PROJECT_VALUE.startsWith('__')).toBe(true)
  })
})
