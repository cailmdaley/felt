import { HUB_ROWS, hubTimes, type HubRow } from './hub-family.js'
import { WORKSPACE_HOST, WORKSPACE_ID, WORKSPACE_UID, type WorkspaceExample } from './workspace-fixtures.js'

/** Family stories: a question under quiet ancestry, a working root over an asker, an orphan, and an entirely quiet tree. */
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
    ['analysis/review', 'Review the response tests', 'closed', 'analysis', ''],
    ['analysis/checks/question/deep', 'Deep follow-up on the response cut', 'active', 'analysis/checks/question', 'working'],
    ['archive/followup', 'Question from the accepted pilot', 'active', 'archive', 'attention'],
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
  for (const [n, [slug, name, status, parent, phase]] of rows.entries()) {
    const id = `${WORKSPACE_ID}/${slug}`
    example.feed.fibers.push({
      origin: WORKSPACE_HOST, felt_store: '/fixture-store/workspace', path: `${id}/${slug.split('/').at(-1)}.md`,
      orchestrator: parent ? `thread-${parent}` : WORKSPACE_UID,
      // A thread with no worker holds results and messages for its next one.
      pending_results: slug === 'review' ? 2 : undefined,
      fiber: { id, uid: `thread-${slug}`, name, status, tags: slug === 'review' ? ['pinned'] : undefined, horizon: slug === 'rest' ? 'stashed' : undefined, created_at: new Date(now - 3600000 + n * 60000).toISOString(),
        closed_at: status === 'closed' ? new Date(now - 60000).toISOString() : undefined,
        tempered: slug === 'archive' ? true : slug === 'discard' ? false : undefined,
        outcome: `${name}: evidence and next steps are ready.`,
        shuttle: slug === 'draft' ? { kind: 'oneshot' } : { kind: 'oneshot', host: WORKSPACE_HOST, agent: 'codex-sol', project_dir: '/fixture-project',
          ...(slug === 'rest' ? { role: 'surveyor', seat: true } : {}),
          ask: phase === 'attention' ? { text: 'Which cut should we use?', at: new Date(now - 120000).toISOString() } : undefined },
      },
      runtime: phase ? { state: 'running', phase, session_uuid: `session-${slug}` } : null,
    })
    example.bodies[id] = `## Desired State\n\n${name}.\n\n## Status\n\nEvidence ready.`
  }
}

/**
 * Roots beside their leading requests: a root
 * in Your turn over ten workers, a working root over four askers and another
 * over seven, a resting root whose only life is a thread, and a root awaiting
 * review while its threads work.
 */
export function addFamilyFixtures(example: WorkspaceExample, now: number): void {
  example.feed.fibers = []
  type Row = { id: string; name: string; parent?: string; status: string; phase?: string; horizon?: string; ask?: boolean; age?: number }
  const rows: Row[] = [
    { id: 'cmbx', name: 'CMB-lensing cross-correlation', status: 'active', phase: 'waiting', age: 14 },
    ...Array.from({ length: 10 }, (_, n): Row => ({ id: `cmbx/patch-${n + 1}`, name: `Reconstruct patch ${n + 1}`, parent: 'cmbx', status: 'active', phase: 'working' })),
    { id: 'shear', name: 'Cosmic shear null tests', status: 'active', phase: 'working' },
    { id: 'shear/psf', name: 'Choose the PSF leakage model', parent: 'shear', status: 'active', phase: 'attention', ask: true, age: 3 },
    { id: 'shear/bmodes', name: 'B-mode covariance', parent: 'shear', status: 'active', phase: 'waiting', age: 9 },
    { id: 'shear/blinding', name: 'Blinding scheme', parent: 'shear', status: 'active', phase: 'waiting', age: 22 },
    { id: 'shear/masks', name: 'Mask apodisation', parent: 'shear', status: 'active', phase: 'waiting', age: 41 },
    { id: 'kinlens', name: 'Kinematic lensing pilot', status: 'open', horizon: 'stashed' },
    { id: 'kinlens/rotation', name: 'Rotation-curve priors', parent: 'kinlens', status: 'open', horizon: 'stashed' },
    { id: 'kinlens/rotation/fit', name: 'Fit the Tully-Fisher scatter', parent: 'kinlens/rotation', status: 'active', phase: 'working' },
    { id: 'pipeline', name: 'Pipeline orchestration', status: 'closed' },
    { id: 'pipeline/slurm', name: 'SLURM allocation sizing', parent: 'pipeline', status: 'active', phase: 'working' },
    { id: 'pipeline/containers', name: 'Container rebuild', parent: 'pipeline', status: 'active', phase: 'working' },
    { id: 'survey', name: 'Survey footprint audit', status: 'active', phase: 'working' },
    ...Array.from({ length: 7 }, (_, n): Row => ({ id: `survey/tile-${n + 1}`, name: `Tile ${n + 1} depth check`, parent: 'survey', status: 'active', phase: 'waiting', age: 5 + n * 6 })),
  ]
  for (const row of rows) {
    const at = new Date(now - (row.age ?? 30) * 60000)
    example.feed.fibers.push({
      origin: WORKSPACE_HOST, felt_store: '/fixture-store/workspace', path: `${row.id}/constitution.md`, orchestrator: row.parent,
      fiber: { id: row.id, uid: row.id, name: row.name, status: row.status, horizon: row.horizon,
        created_at: new Date(now - 3600000).toISOString(),
        closed_at: row.status === 'closed' ? new Date(now - 60000).toISOString() : undefined,
        shuttle: { kind: 'oneshot', host: WORKSPACE_HOST, agent: 'codex-sol', project_dir: '/fixture-project',
          ask: row.ask ? { text: 'Which leakage model?', at: at.toISOString() } : undefined } },
      runtime: row.phase ? { state: 'running', phase: row.phase, session_uuid: `session-${row.id}`, last_activity_at: at.getTime() } : null,
    })
    example.bodies[row.id] = `## Desired State\n\n${row.name}.\n\n## Status\n\nFamily fixture.`
  }
  addHubFixture(example, now)
}

/** The hub family, with its ledgers and sent files; the map's unread marks count from three hours back. */
function addHubFixture(example: WorkspaceExample, now: number): void {
  const hour = 3_600_000
  const phases: Partial<Record<HubRow['state'], string>> = { work: 'working', turn: 'waiting', ask: 'attention', new: 'waiting', blocked: 'blocked' }
  try { localStorage.setItem('shuttle.workspace.document-seen-baseline', String(now - 3 * hour)) } catch { /* The harness runs without storage too. */ }
  for (const row of HUB_ROWS) {
    const moved = now - row.hours * hour, closed = ['review', 'done', 'discard'].includes(row.state)
    const session = `session-${row.id}`, launches = hubTimes(row, row.launches, now)
    example.feed.fibers.push({
      origin: WORKSPACE_HOST, felt_store: '/fixture-store/workspace', path: `${row.id}/constitution.md`, orchestrator: row.parent,
      fiber: { id: row.id, uid: row.id, name: row.name, status: closed ? 'closed' : row.state === 'draft' || row.state === 'rest' ? 'open' : 'active',
        horizon: row.state === 'rest' ? 'stashed' : undefined, tempered: row.state === 'done' ? true : row.state === 'discard' ? false : undefined,
        outcome: row.note && row.state !== 'ask' ? row.note : undefined,
        created_at: new Date(moved - (row.parent ? row.hours / 2 + 20 + row.launches * 9 : 30 * 24) * hour).toISOString(), closed_at: closed ? new Date(moved).toISOString() : undefined,
        shuttle: { kind: 'oneshot', host: WORKSPACE_HOST, agent: 'codex-sol', project_dir: '/fixture-project',
          ask: row.state === 'ask' ? { text: row.note, at: new Date(moved).toISOString() } : undefined } },
      runtime: phases[row.state] ? { state: 'running', phase: phases[row.state], session_uuid: session, last_activity_at: moved } : null,
    })
    example.bodies[row.id] = `## Desired State\n\n${row.name}.\n\n## Status\n\n${row.note}`
    launches.forEach((at, n) => example.sessions.push({ at, fiber: row.id, uid: row.id, session, harness: 'codex', agent: 'codex-sol', host: WORKSPACE_HOST, tmux: null, kind: n === launches.length - 1 ? 'dispatch' : 'resume' }))
    for (const at of hubTimes(row, row.commits, now)) example.commits.push({ at, session, host: WORKSPACE_HOST })
    hubTimes(row, row.files, now).forEach((at, n) => {
      const fullPath = `/fixture-project/${row.id}/${['report.html', 'summary.png', 'figure.png', 'notes.md'][n % 4]}`
      example.receipts.push({ fullPath, basename: fullPath.split('/').at(-1), timestamp: at, sessionId: session, uid: row.id, host: WORKSPACE_HOST })
    })
  }
}

/** Two seats with requests, reviews, and work for the sidebar's folded tree. */
export function addSidebarFixtures(example: WorkspaceExample, now: number): void {
  example.feed.fibers = []
  const rows = [
    { id: 'chair', name: 'CMB cross-correlations chair', status: 'active', phase: 'working', seat: true },
    { id: 'hub', name: 'Shear survey hub', status: 'active', phase: 'working', seat: true },
    { id: 'rest', name: 'Resting research chair', status: 'open', horizon: 'stashed' },
    { id: 'role', name: 'Archive chair seat', status: 'open', horizon: 'stashed', seat: true },
    { id: 'rest/review', parent: 'rest', name: 'Review the rotation model', status: 'closed' },
    { id: 'rest/ask', parent: 'rest', name: 'Choose the rotation prior', status: 'active', phase: 'attention' },
    { id: 'lone', name: 'Choose the observation window', status: 'active', phase: 'attention' },
    { id: 'settled', name: 'Completed instrument chair', status: 'closed', tempered: true },
    { id: 'settled/ask', parent: 'settled', name: 'Choose the calibration release', status: 'active', phase: 'attention' },
    { id: 'quiet', name: 'Completed archive chair', status: 'closed', tempered: true },
    { id: 'quiet/draft', parent: 'quiet', name: 'Draft archive inventory', status: 'open' },
    ...['chair', 'hub'].flatMap(root => [
      ...Array.from({ length: 5 }, (_, n) => ({ id: `${root}/review-${n}`, parent: root, name: `Review ${root === 'chair' ? 'cross-spectrum' : 'shear'} ${n + 1}`, status: 'closed' })),
      { id: `${root}/question`, parent: root, name: `Choose the ${root === 'chair' ? 'overlap cut' : 'leakage model'}`, status: 'active', phase: 'attention' },
      { id: `${root}/analysis`, parent: root, name: 'Response analysis', status: 'active', phase: 'working' },
      { id: `${root}/analysis/deep`, parent: `${root}/analysis`, name: 'Check the response kernel', status: 'active', phase: 'working' },
    ]),
  ] as Array<{ id: string; name: string; parent?: string; status: string; phase?: string; seat?: boolean; horizon?: string; tempered?: boolean }>
  for (const row of rows) {
    example.feed.fibers.push({
      origin: WORKSPACE_HOST, felt_store: '/fixture-store/workspace', path: `${row.id}/constitution.md`, orchestrator: row.parent,
      fiber: { id: row.id, uid: row.id, name: row.name, status: row.status, horizon: row.horizon, tempered: row.tempered,
        created_at: new Date(now - 3600000).toISOString(), closed_at: row.status === 'closed' ? new Date(now - 60000).toISOString() : undefined,
        shuttle: { kind: 'oneshot', host: WORKSPACE_HOST, agent: 'codex-sol', role: row.seat ? 'chair' : undefined, seat: row.seat,
          ask: row.phase === 'attention' ? { text: 'Which model?', at: new Date(now - 120000).toISOString() } : undefined } },
      runtime: row.phase ? { state: 'running', phase: row.phase, session_uuid: `sidebar-${row.id}` } : null,
    })
    example.bodies[row.id] = `## Desired State\n\n${row.name}.\n\n## Status\n\nEvidence ready.`
  }
}
