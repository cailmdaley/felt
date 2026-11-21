// The pages stay light: a page never loads the board's workspace shell.
//
// Each page is a pane of its own, one WebKit process apiece, beside a worker's
// chat. Its entry must never reach, statically or by a dynamic import, the
// modules that own the board's workspace, its history and its voice: those
// would bring the reader, Rex following and the voice target with them. This
// walks the module graph from the pages entry, as the bundler does (type-only
// imports are erased and followed nowhere), and names the chain to any of them.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

const ENTRY = resolve('src/pages/main.ts')
const FORBIDDEN = ['board/workspace/Workspace.ts', 'board/KanbanModal.ts', 'board/workspace/route.ts', 'board/voice.ts']

/** The relative modules a source file loads at run time. */
function imports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      const typeOnly = !!clause && (clause.isTypeOnly || (!clause.name && !!clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(each => each.isTypeOnly)))
      if (!typeOnly) found.push((node.moduleSpecifier as ts.StringLiteral).text)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
      found.push((node.moduleSpecifier as ts.StringLiteral).text)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) {
      found.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found.filter(spec => spec.startsWith('.') && !/\.css(\?|$)/.test(spec)).flatMap(spec => {
    const path = resolve(dirname(file), spec.replace(/\?.*$/, ''))
    const module = [path.replace(/\.js$/, '.ts'), path.replace(/\.js$/, '.tsx'), path].find(each => existsSync(each) && /\.tsx?$/.test(each))
    return module ? [module] : []
  })
}

/** Every module the entry reaches, each with the module that first loaded it. */
function graph(entry: string): Map<string, string | null> {
  const from = new Map<string, string | null>([[entry, null]])
  for (const queue = [entry]; queue.length;) {
    const file = queue.shift()!
    for (const next of imports(file)) if (!from.has(next)) { from.set(next, file); queue.push(next) }
  }
  return from
}

it('the pages entry never loads the workspace, the board shell, its history or voice', () => {
  const reached = graph(ENTRY)
  const chain = (file: string): string => {
    const steps: string[] = []
    for (let at: string | null | undefined = file; at; at = reached.get(at)) steps.unshift(relative(resolve('src'), at))
    return steps.join(' → ')
  }
  const offending = [...reached.keys()].filter(file => FORBIDDEN.some(path => file.endsWith(path))).map(chain)
  expect(offending).toEqual([])
  // The walk really follows the graph: the page reaches the board's view of a thread.
  expect([...reached.keys()].some(file => file.endsWith('board/workspace/FamilyPage.ts'))).toBe(true)
})
