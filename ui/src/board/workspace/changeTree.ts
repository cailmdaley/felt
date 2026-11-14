import { el, button } from './changeElements.js'
import type { ChangeFile } from './changeModel.js'
import { changeFileLabel } from './changeFileLabel.js'

interface Directory {
  directories: Map<string, Directory>
  files: ChangeFile[]
  count: number
}

/** Directories open breadth-first while their group shows at most `GROUP_ROWS` rows; one with more than `DIRECTORY_FOLD` entries stays folded. */
const DIRECTORY_FOLD = 12
const GROUP_ROWS = 40

const MARKERS: Record<string, string> = { added: 'new', deleted: 'deleted', renamed: 'renamed' }

/**
 * Where a change lands on disk: implementation, tests and generated files as separate path trees,
 * single-child directory chains collapsed, each file with its line counts and a status marker.
 */
export function changeTree(files: ChangeFile[], jump: (file: ChangeFile) => void): HTMLElement {
  const tree = el('section', 'change-tree')
  tree.setAttribute('aria-label', 'Changed files')
  tree.append(el('h2', '', 'Files'))
  const groups: [string, ChangeFile[]][] = [
    ['Implementation', files.filter(file => file.role !== 'test' && file.role !== 'generated')],
    ['Tests', files.filter(file => file.role === 'test')],
    ['Generated', files.filter(file => file.role === 'generated')],
  ]
  const directory = (): Directory => ({ directories: new Map(), files: [], count: 0 })
  const render = (host: HTMLElement, node: Directory): void => {
    for (const [name, child] of [...node.directories].sort(([a], [b]) => a.localeCompare(b))) {
      let label = name, branch = child
      while (!branch.files.length && branch.directories.size === 1) {
        const [next, nested] = [...branch.directories][0]
        label += `/${next}`
        branch = nested
      }
      const details = el('details', 'change-tree-directory')
      const summary = el('summary', '')
      summary.append(el('span', 'change-tree-path', `${label}/`), el('span', 'change-tree-total', `${branch.count}`))
      const children = el('div', 'change-tree-children')
      render(children, branch)
      details.append(summary, children)
      host.append(details)
    }
    for (const file of node.files.sort((a, b) => a.path.localeCompare(b.path))) {
      const row = button('', () => jump(file))
      row.className = 'change-tree-file'
      row.dataset.file = file.path
      row.dataset.status = file.status
      row.title = `${file.path} · ${changeFileLabel(file)}`
      const identity = el('span', 'change-tree-identity')
      identity.append(el('span', 'change-tree-path', file.path.split('/').at(-1)!))
      if (file.old_path) identity.append(el('span', 'change-tree-source', `from ${file.old_path}`))
      row.append(
        identity,
        el('span', 'change-tree-status', MARKERS[file.status] ?? ''),
        el('span', 'change-tree-counts', `+${file.additions} −${file.deletions}`),
      )
      host.append(row)
    }
  }
  for (const [label, members] of groups) {
    if (!members.length) continue
    const group = el('div', 'change-tree-group')
    group.dataset.group = label.toLowerCase()
    const additions = members.reduce((sum, file) => sum + file.additions, 0)
    const deletions = members.reduce((sum, file) => sum + file.deletions, 0)
    const heading = el('h3', '')
    heading.append(el('span', '', `${label} · ${members.length}`), el('span', 'change-tree-counts', `+${additions} −${deletions}`))
    group.append(heading)
    const root = directory()
    for (const file of members) {
      let node = root
      for (const part of file.path.split('/').slice(0, -1)) {
        if (!node.directories.has(part)) node.directories.set(part, directory())
        node = node.directories.get(part)!
        node.count++
      }
      node.files.push(file)
    }
    render(group, root)
    let rows = group.childElementCount - 1
    const queue = [...group.querySelectorAll<HTMLDetailsElement>(':scope > details')]
    for (const details of queue) {
      const entries = [...details.lastElementChild!.children]
      if (entries.length > DIRECTORY_FOLD || rows + entries.length > GROUP_ROWS) continue
      details.open = true
      rows += entries.length
      queue.push(...entries.filter(entry => entry instanceof HTMLDetailsElement))
    }
    tree.append(group)
  }
  return tree
}
