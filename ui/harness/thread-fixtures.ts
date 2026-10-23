import { WORKSPACE_HOST, WORKSPACE_ID, WORKSPACE_UID, type WorkspaceExample } from './workspace-fixtures.js'

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
