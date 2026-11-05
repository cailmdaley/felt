import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
export const rowID = (file, side, line) => JSON.stringify([file, side, line])
// The DOM has no line terminators; CRLF and LF display the same source text.
export const displayedText = text => text.replace(/\r?\n$/, '').replace(/\r$/, '')

/** Parse Git's patch grammar directly, independently of Shuttle and @pierre/diffs. */
export function parseGitRows(patch, file) {
  const rows = new Map()
  let old, next, oldLeft = 0, nextLeft = 0
  for (const line of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (header) {
      assert.equal(oldLeft + nextLeft, 0, `Incomplete Git hunk for ${JSON.stringify(file)}`)
      old = Number(header[1]); next = Number(header[3])
      oldLeft = Number(header[2] ?? 1); nextLeft = Number(header[4] ?? 1)
      continue
    }
    if (!oldLeft && !nextLeft) continue
    if (line.startsWith('\\ No newline')) continue
    const text = displayedText(line.slice(1))
    if (line[0] === '-') { rows.set(rowID(file, 'old', old++), text); oldLeft-- }
    else if (line[0] === '+') { rows.set(rowID(file, 'new', next++), text); nextLeft-- }
    else if (line[0] === ' ') { old++; next++; oldLeft--; nextLeft-- }
    else assert.fail(`Unexpected Git hunk row for ${JSON.stringify(file)}: ${JSON.stringify(line)}`)
    assert.ok(oldLeft >= 0 && nextLeft >= 0, `Invalid Git hunk counts for ${JSON.stringify(file)}`)
  }
  assert.equal(oldLeft + nextLeft, 0, `Incomplete Git hunk for ${JSON.stringify(file)}`)
  return rows
}

/** NUL-delimited names avoid interpreting Git's quoted, potentially hostile path headers. */
export function gitChangedRows(repo, base, head) {
  const names = git(repo, 'diff', '--name-status', '-z', '--find-renames', base, head, '--').split('\0')
  const rows = new Map()
  for (let i = 0; i < names.length - 1;) {
    const status = names[i++], before = names[i++]
    const after = /^[RC]/.test(status) ? names[i++] : before
    const patch = git(repo, '-c', 'core.bigFileThreshold=1g', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--unified=3', base, head, '--', before, after)
    for (const [id, text] of parseGitRows(patch, after)) rows.set(id, text)
  }
  return rows
}

/** All windows must contain source rows; every changed coordinate and its text must survive. */
export function assertDOMConservation(truth, windows) {
  assert.ok(windows.length, 'No diff windows rendered')
  const seen = new Map()
  for (const window of windows) {
    const label = `${window.lane}: ${JSON.stringify(window.file)} window ${window.index}`
    assert.ok(window.rows.length, `Blank diff window: ${label}`)
    for (const row of window.rows) {
      if (row.type !== 'change-addition' && row.type !== 'change-deletion') continue
      const id = rowID(window.file, row.type === 'change-addition' ? 'new' : 'old', Number(row.line))
      assert.ok(truth.has(id), `Invented DOM row ${id} (${label})`)
      const text = displayedText(row.text)
      assert.equal(text, truth.get(id), `Wrong DOM source text at ${id} (${label})`)
      seen.set(id, text)
    }
  }
  const missing = [...truth.keys()].filter(id => !seen.has(id))
  assert.deepEqual(missing, [], `Missing ${missing.length}/${truth.size} Git rows in the DOM`)
  return { rows: seen.size, windows: windows.length }
}

/** Visit each virtual window while mounted, traversing open shadow roots as well as light DOM. */
export async function collectDOMWindows(page) {
  await page.locator('details.change-file').evaluateAll(cards => { for (const card of cards) card.open = true })
  // Opening a generated-file card creates its windows on the toggle event.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const windows = page.locator('.change-diff-window'), out = []
  for (let index = 0; index < await windows.count(); index++) {
    const window = windows.nth(index)
    await window.evaluate(host => host.scrollIntoView({ block: 'start' }))
    // Let optional grammar imports finish (or fail) before inspecting the visible result.
    await page.waitForLoadState('networkidle')
    // Playwright's CSS engine pierces open shadow roots. An empty window is a failure,
    // not a reason to skip the file or to count Go's serialized patch as rendered.
    await window.locator('[data-line]:visible, .change-plain-row:visible').first().waitFor({ state: 'attached', timeout: 15_000 }).catch(() => {})
    out.push(await readDOMWindow(window, index))
  }
  return out
}

export function readDOMWindow(window, index) {
  return window.evaluate((host, index) => {
    const rows = []
    const visit = root => {
      for (const node of root.querySelectorAll('*')) {
        const visible = node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden'
        if (visible && node.matches('.change-plain-row')) {
          const type = node.getAttribute('data-line-type')
          rows.push({ line: node.getAttribute(type === 'change-deletion' ? 'data-old-line' : 'data-new-line'), type, text: node.querySelector('[data-line-text]')?.textContent ?? '' })
        } else if (visible && node.hasAttribute('data-line')) {
          rows.push({ line: node.getAttribute('data-line'), type: node.getAttribute('data-line-type'), text: node.textContent })
        }
        if (node.shadowRoot) visit(node.shadowRoot)
      }
    }
    visit(host)
    return { index, renderer: host.dataset.renderState, file: host.closest('.change-file')?.getAttribute('data-change-file'), lane: host.closest('.change-section')?.querySelector('h2')?.textContent, rows }
  }, index)
}
