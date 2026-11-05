import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { parsePatchFiles } from '@pierre/diffs'

/** Use the renderer's decoded rows, never a second Git parser. */
export function changedRows(file, hunks) {
  const keys = new Set()
  for (const window of hunks.flatMap(hunk => hunk.windows)) {
    const parsed = parsePatchFiles(window.patch)[0]?.files[0]
    assert.ok(parsed, `No rendered patch for ${file}`)
    for (const hunk of parsed.hunks) {
      let old = hunk.deletionStart, next = hunk.additionStart
      for (const content of hunk.hunkContent) {
        if (content.type === 'context') { old += content.lines; next += content.lines; continue }
        for (let i = 0; i < content.deletions; i++) keys.add(JSON.stringify([file, 'old', old++, parsed.deletionLines[content.deletionLineIndex + i]]))
        for (let i = 0; i < content.additions; i++) keys.add(JSON.stringify([file, 'new', next++, parsed.additionLines[content.additionLineIndex + i]]))
      }
    }
  }
  return keys
}

/** Every captured changed row must survive into Story, Tests or Remaining. */
export function checkChange(bundle) {
  const all = new Set(bundle.files.flatMap(file => [...changedRows(file.path, file.hunks)]))
  const remaining = new Set(bundle.files.flatMap(file => [...changedRows(file.path, file.remaining)]))
  const story = bundle.story?.chapters.flatMap(chapter => chapter.stops) ?? []
  const shown = new Set(story.flatMap(stop => [...changedRows(stop.file, stop.hunks)]))
  for (const key of shown) assert.ok(!remaining.has(key), 'a shown changed row must not reappear in Remaining')
  const visible = new Set([
    ...shown,
    ...bundle.files.flatMap(file => [...changedRows(file.path, file.role === 'test' ? file.hunks : file.remaining)]),
  ])
  assert.equal(all.size, bundle.files.reduce((count, file) => count + file.additions + file.deletions, 0), 'renderer must retain the captured line count')
  assert.deepEqual(visible, all, 'Story, Tests and Remaining must retain every changed row and its coordinates')
  for (const key of remaining) assert.ok(all.has(key), 'Remaining must not invent a changed row')
  assert.equal(shown.size + remaining.size, all.size, 'every changed row must be shown or remaining')
  return { total: all.size, shown: shown.size, remaining: remaining.size }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(checkChange(JSON.parse(readFileSync(process.argv[2], 'utf8'))), null, 2))
}
