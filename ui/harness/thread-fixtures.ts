import { WORKSPACE_HOST, WORKSPACE_ID, WORKSPACE_UID, type WorkspaceExample } from './workspace-fixtures.js'

/** Frontier stories: quiet ancestry, an awake root, an orphan, and an entirely quiet tree. */
export function addFrontierFixtures(example: WorkspaceExample, now: number): void {
  example.feed.fibers = []
  const rows: Array<{ id: string; name: string; parent?: string; status: string; phase?: string; horizon?: string; tempered?: boolean; pinned?: boolean }> = [
    { id: 'quiet-chair', name: 'Quiet chair', status: 'open', horizon: 'stashed' },
    { id: 'quiet-chair/analysis', name: 'Response analysis', parent: 'quiet-chair', status: 'active', phase: 'working' },
    { id: 'quiet-chair/quiet-branch', name: 'Validation', parent: 'quiet-chair', status: 'open', horizon: 'stashed' },
    { id: 'quiet-chair/quiet-branch/cut', name: 'Choose the response cut', parent: 'quiet-chair/quiet-branch', status: 'active', phase: 'attention' },
    { id: 'awake-chair', name: 'Live orchestration', status: 'active', phase: 'working' },
    { id: 'awake-chair/question', name: 'Choose the mask', parent: 'awake-chair', status: 'active', phase: 'attention', pinned: true },
    { id: 'awake-chair/quiet', name: 'Quiet branch', parent: 'awake-chair', status: 'open' },
    { id: 'awake-chair/quiet/review', name: 'Review null tests', parent: 'awake-chair/quiet', status: 'closed' },
    { id: 'awake-chair/draft', name: 'Quiet draft', parent: 'awake-chair', status: 'open' },
    { id: 'missing-chair/folder/orphan', name: 'Independent follow-up', parent: 'absent-uid', status: 'closed' },
    { id: 'resting-chair', name: 'Resting programme', status: 'open', horizon: 'stashed' },
    { id: 'resting-chair/draft', name: 'Unstarted plan', parent: 'resting-chair', status: 'open', pinned: true },
  ]
  for (const row of rows) {
    example.feed.fibers.push({
      origin: WORKSPACE_HOST, felt_store: '/fixture-store/workspace', path: `${row.id}/constitution.md`, orchestrator: row.parent,
      fiber: { id: row.id, uid: row.id, name: row.name, status: row.status, horizon: row.horizon, tempered: row.tempered,
        tags: row.pinned ? ['pinned'] : undefined, created_at: new Date(now - 3600000).toISOString(),
        closed_at: row.status === 'closed' ? new Date(now - 60000).toISOString() : undefined,
        shuttle: { kind: 'oneshot', host: WORKSPACE_HOST, agent: 'codex-sol', project_dir: '/fixture-project',
          ask: row.phase === 'attention' ? { text: 'Which cut should we use?', at: new Date(now - 120000).toISOString() } : undefined } },
      runtime: row.phase ? { state: 'running', phase: row.phase, session_uuid: `session-${row.id}` } : null,
    })
    example.bodies[row.id] = `## Desired State\n\n${row.name}.\n\n## Status\n\nFrontier fixture.`
  }
}

/** A small family with every state, a plain-folder gap and three constitution levels. */
export function addThreadFixtures(example: WorkspaceExample, now: number, many = false): void {
  const rows: Array<[string, string, string, string | null, string]> = [
    ['analysis', 'Response analysis', 'active', null, 'working'],
    ['analysis/checks/question', 'Choose the response cut', 'active', 'analysis', 'attention'],
    ['review', 'Review the null tests', 'closed', null, ''],
    ['draft', 'Draft the validation plan', 'open', null, ''],
    ['rest', 'Next validation', 'open', null, ''],
    ['archive', 'Accepted pilot', 'closed', null, ''],
    ['discard', 'Discarded pilot', 'closed', null, ''],
  ]
  if (many) {
    for (let n = 1; n <= 15; n++) rows.push([`review-${n}`, `Validation review ${n}`, 'closed', null, ''])
    for (let n = 1; n <= 2; n++) rows.push([`question-${n}`, `Choose validation ${n}`, 'active', null, 'attention'])
  }
  for (const [slug, name, status, parent, phase] of rows) {
    const id = `${WORKSPACE_ID}/${slug}`
    example.feed.fibers.push({
      origin: WORKSPACE_HOST, felt_store: '/fixture-store/workspace', path: `${id}/${slug.split('/').at(-1)}.md`,
      orchestrator: parent ? `thread-${parent}` : WORKSPACE_UID,
      // A thread with no worker holds results and messages for its next one.
      pending_results: slug === 'review' ? 2 : undefined,
      fiber: { id, uid: `thread-${slug}`, name, status, tags: slug === 'review' ? ['pinned'] : undefined, horizon: slug === 'rest' ? 'stashed' : undefined, created_at: new Date(now - 3600000).toISOString(),
        closed_at: status === 'closed' ? new Date(now - 60000).toISOString() : undefined,
        tempered: slug === 'archive' ? true : slug === 'discard' ? false : undefined,
        outcome: `${name}: evidence and next steps are ready.`,
        shuttle: slug === 'draft' ? { kind: 'oneshot' } : { kind: 'oneshot', host: WORKSPACE_HOST, agent: 'codex-sol', project_dir: '/fixture-project',
          ask: phase === 'attention' ? { text: 'Which cut should we use?', at: new Date(now - 120000).toISOString() } : undefined },
      },
      runtime: phase ? { state: 'running', phase, session_uuid: `session-${slug}` } : null,
    })
    example.bodies[id] = `## Desired State\n\n${name}.\n\n## Status\n\nEvidence ready.`
  }
}
