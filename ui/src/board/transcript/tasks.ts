export interface WorkerTask {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

/** The owner-served harness projection; malformed rows never become checklist claims. */
export function parseWorkerTasks(value: unknown): WorkerTask[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const row = item as Record<string, unknown>
    if (typeof row.id !== 'string' || !row.id || seen.has(row.id) || typeof row.subject !== 'string'
      || !row.subject.trim() || !['pending', 'in_progress', 'completed'].includes(String(row.status))) return []
    seen.add(row.id)
    return [{ id: row.id, subject: row.subject, status: row.status as WorkerTask['status'],
      ...(typeof row.activeForm === 'string' && row.activeForm.trim() ? { activeForm: row.activeForm } : {}) }]
  })
}

/** Live tasks sit outside the transcript's arrival stream and never rewrite its history. */
export class TaskChecklist {
  readonly el = document.createElement('section')
  private readonly list = document.createElement('ul')
  private key = ''
  constructor() {
    this.el.className = 'ws-transcript-checklist'
    this.el.setAttribute('aria-label', 'Worker checklist')
    const heading = document.createElement('div')
    heading.className = 'ws-transcript-checklist-heading'
    heading.textContent = 'Worker checklist'
    this.el.append(heading, this.list)
  }
  paint(tasks: readonly WorkerTask[]): boolean {
    const key = JSON.stringify(tasks)
    if (key === this.key) return tasks.length > 0
    this.key = key
    this.list.replaceChildren(...tasks.map(task => {
      const row = document.createElement('li')
      row.dataset.task = task.id
      row.dataset.status = task.status
      const mark = document.createElement('span')
      mark.className = 'ws-transcript-task-mark'
      mark.setAttribute('aria-label', task.status === 'completed' ? 'Done' : task.status === 'in_progress' ? 'In progress' : 'Pending')
      mark.textContent = task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '◐' : '○'
      const label = document.createElement('span')
      label.textContent = task.status === 'in_progress' ? task.activeForm ?? task.subject : task.subject
      row.title = task.subject
      row.append(mark, label)
      return row
    }))
    return tasks.length > 0
  }
}
