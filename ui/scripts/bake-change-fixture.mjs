import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))

export function fixtureRepo(dir) {
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q'); git('config', 'user.name', 'Fixture contributor'); git('config', 'user.email', 'fixture@example.invalid')
  const put = (path, text) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text) }
  put('ui/src/board/threads.ts', 'export const roots = families.map(family => family.lead)\n')
  put('README.md', '# Family navigation\n')
  git('add', '.'); git('commit', '-qm', 'Family navigation base')
  const base = git('rev-parse', 'HEAD')
  put('ui/src/board/threads.ts', 'export const roots = families.flatMap(family => [family.root, family.lead])\n')
  put('ui/src/board/workspace/Reader.ts', 'export function revealFamily(root) {\n  return root.children.filter(child => child.active)\n}\n')
  put('ui/src/board/workspace/Reader.test.ts', 'it("keeps the root visible", () => {\n  expect(revealFamily(root)).toContain(request)\n})\n')
  put('README.md', '# Family navigation\n\nThe root stays visible beside its requests.\n')
  put('ui/public/change-reader-NOTICES.txt', 'Third-party licence inventory\n')
  git('add', '.'); git('commit', '-qm', 'Keep the family root visible')
  return { repo, base, head: git('rev-parse', 'HEAD') }
}

export function buildShuttle(dir) {
  const binary = join(dir, 'shuttle')
  execFileSync('go', ['build', '-o', binary, './cmd/shuttle'], { cwd: root })
  return binary
}

/** Exercise the public CLI with a disposable fiber, without touching the operator's store. */
export function bakeChange(binary, repo, base, head, story) {
  const dir = mkdtempSync(join(tmpdir(), 'change-bake-'))
  try {
    mkdirSync(join(dir, '.felt', 'review'), { recursive: true })
    writeFileSync(join(dir, '.felt', 'review', 'review.md'), '---\nname: Review\n---\n')
    const args = ['-C', dir, 'change', 'review', '--repo', repo, '--base', base, '--head', head, '--name', 'snapshot', '--json']
    if (story !== undefined) {
      writeFileSync(join(dir, 'story.json'), JSON.stringify(story))
      args.push('--story', join(dir, 'story.json'))
    }
    const report = JSON.parse(execFileSync(binary, args, { encoding: 'utf8', env: { ...process.env, SHUTTLE_EVENTS_FILE: join(dir, 'events.jsonl'), SHUTTLE_HOST: 'fixture-host' } }))
    return { bundle: JSON.parse(readFileSync(report.path, 'utf8')), report }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = mkdtempSync(join(tmpdir(), 'change-cli-'))
  try {
    const fixture = new URL('../harness/generated/dogfood.change.json', import.meta.url)
    mkdirSync(dirname(fileURLToPath(fixture)), { recursive: true })
    const { repo, base, head } = fixtureRepo(dir)
    const story = JSON.parse(readFileSync(new URL('../harness/fixtures/dogfood.story.json', import.meta.url), 'utf8'))
    const binary = buildShuttle(dir)
    for (const [target, input] of [[fixture, story], [new URL('../harness/generated/dogfood-plain.change.json', import.meta.url), undefined]]) {
      const { bundle } = bakeChange(binary, repo, base, head, input)
      // The harness is portable and carries no operator identity.
      bundle.repo.dir = '/fixture-repo/felt'
      for (const commit of bundle.commits) commit.author = 'Repository contributor'
      writeFileSync(target, JSON.stringify(bundle, null, 2) + '\n')
      console.log(`Baked ${bundle.files.length} files with shuttle change into ${dirname(fileURLToPath(target))}`)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
