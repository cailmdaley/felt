import { WORKSPACE_HOST, WORKSPACE_ID, type WorkspaceExample } from './workspace-fixtures.js'

/** A small family with every state, a plain-folder gap and three constitution levels. */
export function addThreadFixtures(example: WorkspaceExample, now: number): void {
  const rows: Array<[string, string, string, string | null, string]> = [
    ['analysis', 'Response analysis', 'active', null, 'working'],
    ['analysis/checks/question', 'Choose the response cut', 'active', 'analysis', 'attention'],
    ['review', 'Review the null tests', 'closed', null, ''],
    ['rest', 'Next validation', 'open', null, ''],
    ['archive', 'Accepted pilot', 'closed', null, ''],
    ['discard', 'Discarded pilot', 'closed', null, ''],
  ]
  for (const [slug, name, status, parent, phase] of rows) {
    const id = `${WORKSPACE_ID}/${slug}`
    example.feed.fibers.push({
      origin: WORKSPACE_HOST, felt_store: '/fixture-store/workspace', path: `${id}/${slug.split('/').at(-1)}.md`,
      orchestrator: parent ? `${WORKSPACE_ID}/${parent}` : WORKSPACE_ID,
      fiber: { id, uid: `thread-${slug}`, name, status, created_at: new Date(now - 3600000).toISOString(),
        closed_at: status === 'closed' ? new Date(now - 60000).toISOString() : undefined,
        tempered: slug === 'archive' ? true : slug === 'discard' ? false : undefined,
        outcome: `${name}: evidence and next steps are ready.`,
        shuttle: { kind: 'oneshot', host: WORKSPACE_HOST, agent: 'codex-sol', project_dir: '/fixture-project',
          ask: phase === 'attention' ? { text: 'Which cut should we use?', at: new Date(now - 120000).toISOString() } : undefined },
      },
      runtime: phase ? { state: 'running', phase, session_uuid: `session-${slug}` } : null,
    })
    example.bodies[id] = `## Desired State\n\n${name}.\n\n## Status\n\nEvidence ready.`
  }
}
