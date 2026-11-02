import { addThreadFixtures } from './thread-fixtures.js'
import { WORKSPACE_ID, WORKSPACE_REPORT, type WorkspaceExample } from './workspace-fixtures.js'

/** A nested Desk landing, a sibling, and a linked file for visited-path navigation. */
export function addNavigationFixtures(example: WorkspaceExample, now: number): void {
  addThreadFixtures(example, now)
  const review = example.feed.fibers.find(row => (row.fiber as { id: string }).id === `${WORKSPACE_ID}/review`)!
  review.dir = WORKSPACE_REPORT.replace('/report.html', '/review')
  example.bodies[`${WORKSPACE_ID}/review`] += `\n\n[Open validation](${WORKSPACE_REPORT.replace('report.html', 'validation.html')})`
}
