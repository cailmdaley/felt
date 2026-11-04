import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trimEnd()
const head = git('rev-parse', 'f629d29c417f20c16b8e4415ebd6e424235060d3'), base = git('rev-parse', `${head}~5`)
const patch = git('diff', '--no-ext-diff', '--no-color', '--find-renames', base, head) + '\n'
const classify = path => /(?:test|spec|e2e|fixtures)/i.test(path) ? 'test' : /(?:lock|generated)/i.test(path) ? 'generated' : /(?:\.json$|config|Makefile)/.test(path) ? 'config' : /\.md$/.test(path) ? 'docs' : 'implementation'
const statuses = new Map(git('diff', '--name-status', base, head).split('\n').map(line => { const [status, path] = line.split('\t'); return [path, status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified'] }))
const files = git('diff', '--numstat', base, head).split('\n').filter(Boolean).map(line => {
  const [additions, deletions, path] = line.split('\t')
  return { path, status: statuses.get(path), role: classify(path), additions: +additions || 0, deletions: +deletions || 0 }
})
const commits = git('log', '--format=%H%x09%s%x09%an%x09%aI', `${base}..${head}`).split('\n').map(line => {
  const [sha, subject, , time] = line.split('\t'); return { sha, subject, author: 'Repository contributor', time }
})
const story = {
  overview: 'The Desk keeps a family’s root visible beside its most urgent thread. The reader carries the same family into a persistent sidebar: requests come first, quiet work stays folded, and the page you are reading remains reachable. Two small independent changes complete this snapshot: Pi’s Sol model is selectable, and the cache test locates the running application rather than assuming a build directory.',
  flags: [{ file: 'ui/src/board/threads.ts', from: 224, to: 246, text: '**Check the row-relative counts.** Keeping both root and lead means a count must exclude the row it is printed on, not always the lead. The `others` calculation is where that distinction lives.' }],
  chapters: [
    { id: 'desk-roots', title: 'Keep the root in sight', narrative: 'Start with the shared projection. Each family contributes its root and, when different, its leading request. The count is relative to the row that displays it, so the root and the urgent thread do not silently disagree.', why_here: 'The sidebar consumes the same family graph; establish its identities before looking at the presentation.', stops: [{ file: 'ui/src/board/threads.ts', from: 224, to: 246, note: 'Two rows can represent one family. The root remains an address for the work, while the lead represents the next human decision.', importance: 'critical' }, { file: 'ui/src/board/DeskFrontier.ts', from: 38, to: 65, note: 'Both rows can carry the family count. Only the lead carries the extra request list.', importance: 'important' }] },
    { id: 'outline', title: 'Make the family walkable', narrative: 'The outline is a pure projection of the graph plus the viewer’s fold choices. Three requests are shown before “more”; working descendants retain the ancestors that make their nesting intelligible. A folded family still reveals the currently open page.', why_here: 'This is the behavioral core, independent of DOM layout and animation.', stops: [{ file: 'ui/src/board/workspace/SidebarOutline.ts', from: 45, to: 81, note: 'Read the current-page exception at the end closely: revealing a page must not change a stored fold preference.', importance: 'critical' }, { file: 'ui/src/board/workspace/SidebarOutline.ts', from: 20, to: 43, note: 'The explicit choices are browser-local, keyed by stable root identity. Merely navigating never writes them.', importance: 'supporting' }] },
    { id: 'reader', title: 'Join the reader to that outline', narrative: 'The reader renders fold controls and nested rows from the outline. Workspace placement resolves through the root rather than treating the leading thread as the family’s identity. Tests remain below in their own lane; every other edit stays visible in Remaining.', why_here: 'With the projection understood, the rendering and placement glue can be checked against it.', stops: [{ file: 'ui/src/board/workspace/Reader.ts', from: 772, to: 825, note: 'Controls preserve keyboard focus after repaint, while filtering exposes descendants regardless of folds.', importance: 'important' }, { file: 'ui/src/board/workspace/Workspace.ts', from: 340, to: 385, note: 'Placement uses the root when the Desk has it; a lead supplies a caption only when the root is absent.', importance: 'supporting' }] },
  ], roles: {},
}
const bundle = { version: 1, title: 'Keep a family’s root visible, and its requests close', repo: { name: 'felt', dir: '/fixture-repo/felt', forge_url: 'https://github.com/cailmdaley/felt' }, base, head, base_ref: 'origin/main~5', head_ref: 'origin/main', commits, patch, files, story }
writeFileSync(fileURLToPath(new URL('../harness/fixtures/dogfood.change.json', import.meta.url)), JSON.stringify(bundle, null, 2) + '\n')
console.log(`${base.slice(0, 8)}..${head.slice(0, 8)}: ${files.length} files`)
