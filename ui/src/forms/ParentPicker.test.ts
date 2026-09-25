import { describe, expect, it } from 'vitest'
import { parentCandidates } from './ParentPicker'

const INDEX = [
  { id: 'work', name: 'Work' },
  { id: 'other', name: 'Other' },
  { id: 'work/lensing', name: 'Lensing' },
  { id: 'work/lensing/analysis', name: 'Analysis' },
  { id: 'work/lensing/analysis/pipeline', name: 'Pipeline' },
  { id: 'work/other/notes', name: 'Other notes' },
]

describe('ParentPicker commit ids', () => {
  it('keeps Stash candidates project-relative', () => {
    expect(parentCandidates(INDEX, '', 'work/lensing').map((row) => row.id))
      .toEqual(['analysis'])
    expect(parentCandidates(INDEX, 'pipeline', 'work/lensing', 'project-relative').map((row) => row.id))
      .toEqual(['analysis/pipeline'])
  })

  it('commits loom-relative meeting ids and offers the project root fiber', () => {
    expect(parentCandidates(INDEX, 'work/lensing', 'work/lensing', 'loom-relative'))
      .toEqual([
        { id: 'work/lensing', name: 'Lensing', depth: 0 },
        { id: 'work/lensing/analysis', name: 'Analysis', depth: 1 },
      ])
    expect(parentCandidates(INDEX, 'pipeline', 'work/lensing', 'loom-relative').map((row) => row.id))
      .toEqual(['work/lensing/analysis/pipeline'])
  })

  it('keeps a store-root project in the store-relative id space', () => {
    expect(parentCandidates(INDEX, '', '', 'loom-relative').map((row) => row.id))
      .toEqual(['other', 'work'])
  })
})
