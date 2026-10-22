// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { parseWorkerTasks, TaskChecklist } from './tasks.js'
import { parseCompositeFeed } from '../KanbanComposite.js'
import { cardFromCompositeEntry } from '../KanbanReadModel.js'

const tasks = [
  { id: '1', subject: 'Inspect inputs', status: 'completed', activeForm: 'Inspecting inputs' },
  { id: '2', subject: 'Run checks', status: 'in_progress', activeForm: 'Running checks' },
  { id: '3', subject: 'Report', status: 'pending', activeForm: 'Reporting' },
]
describe('owner-served worker tasks', () => {
  it('preserves daemon ordering and activeForm while rejecting malformed and duplicate rows', () => {
    expect(parseWorkerTasks([...tasks, null, {}, { ...tasks[0], status: 'failed' }, tasks[0], { id: '4', subject: ' ', status: 'pending' }])).toEqual(tasks)
    expect(parseWorkerTasks(null)).toStrictEqual([])
    expect(parseWorkerTasks([{ ...tasks[0], activeForm: null }])).toEqual([{ id: '1', subject: 'Inspect inputs', status: 'completed' }])
  })
  it('carries the live owner projection through the read model and drops it with the worker', () => {
    const entry = { origin: 'owner', felt_store: '/felt', path: 'work.md', fiber: { id: 'work', name: 'Work', shuttle: { kind: 'oneshot' } } }
    const live = parseCompositeFeed({ fibers: [{ ...entry, runtime: { state: 'running', session_uuid: 'session', tasks } }] })
    expect(cardFromCompositeEntry(live.entries[0]).workerTasks).toEqual(tasks)
    const resting = parseCompositeFeed({ fibers: [entry] })
    expect(cardFromCompositeEntry(resting.entries[0]).workerTasks).toBeUndefined()
  })
  it('uses activeForm only for in-progress tasks and renders data as text', () => {
    const checklist = new TaskChecklist()
    expect(checklist.paint(parseWorkerTasks(tasks))).toBe(true)
    expect([...checklist.el.querySelectorAll('li')].map(row => row.textContent)).toEqual(['✓Inspect inputs', '◐Running checks', '○Report'])
    expect([...checklist.el.querySelectorAll('[aria-label]')].map(row => row.getAttribute('aria-label'))).toEqual(['Done', 'In progress', 'Pending'])
    checklist.paint(parseWorkerTasks([{ ...tasks[1], activeForm: '<img src=x onerror=bad()>' }]))
    expect(checklist.el.querySelector('img')).toBeNull()
    expect(checklist.el.textContent).toContain('<img src=x onerror=bad()>')
    expect(checklist.paint([])).toBe(false)
    expect(checklist.el.querySelectorAll('li')).toHaveLength(0)
  })
})
