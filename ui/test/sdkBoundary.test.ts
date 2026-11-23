// The SDK stands below the board: a page builds on it with nothing of the
// board's. Nothing under src/sdk/ may import from the board, the pages, the
// forms or the map, nor load a stylesheet, nor dress an element with a class
// or an inline style; a skin is the page's.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

const SDK = resolve('src/sdk')
const LAYERS = ['board', 'pages', 'forms', 'map', 'phone', 'runtime', 'styles']

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : [path]
  })
}

/** Every module specifier a source file names: imports, re-exports and dynamic imports. */
function specifiers(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text)
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) found.push(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** Why a specifier crosses the SDK's boundary, or undefined when it does not. */
function crossing(file: string, spec: string): string | undefined {
  if (/\.(css|scss|less)(\?.*)?$/.test(spec)) return 'a stylesheet'
  if (spec.includes('/internal')) return 'an SDK internal'
  if (!spec.startsWith('.')) return /^@ui-sdk\/(core|web)(\/|$)/.test(spec) ? undefined : 'a package beyond @ui-sdk/core and @ui-sdk/web'
  const target = relative(SDK, resolve(join(file, '..'), spec))
  if (target.startsWith('..')) {
    const layer = relative(resolve('src'), resolve(join(file, '..'), spec)).split('/')[0]
    return LAYERS.includes(layer) ? `the ${layer} layer` : 'a module outside src/sdk'
  }
  return undefined
}

it('src/sdk imports nothing above it, and no stylesheet', () => {
  const found = sources(SDK)
    .filter(file => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .flatMap(file => specifiers(file).flatMap(spec => {
      const why = crossing(file, spec)
      return why ? [`${relative(SDK, file)} imports ${spec}: ${why}`] : []
    }))
  expect(found).toEqual([])
})

it('src/sdk holds no stylesheet, class or inline style', () => {
  const files = sources(SDK)
  expect(files.filter(file => /\.(css|scss|less)$/.test(file)).map(file => relative(SDK, file))).toEqual([])
  const dressed = files
    .filter(file => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .flatMap(file => readFileSync(file, 'utf8').split('\n').flatMap((line, index) =>
      /\.(className|classList|style)\b|setAttribute\(\s*['"](class|style)['"]/.test(line) ? [`${relative(SDK, file)}:${index + 1}  ${line.trim()}`] : []))
  expect(dressed).toEqual([])
})

it('the guard sees what it exists to catch', () => {
  const at = join(SDK, 'x.ts')
  expect(crossing(at, '../board/attention.js')).toBe('the board layer')
  expect(crossing(at, '../pages/route.js')).toBe('the pages layer')
  expect(crossing(at, '../forms/AppDialog.js')).toBe('the forms layer')
  expect(crossing(at, '../map/layout.js')).toBe('the map layer')
  expect(crossing(at, './x.css')).toBe('a stylesheet')
  expect(crossing(at, '@ui-sdk/core/internal/x')).toBe('an SDK internal')
  expect(crossing(at, 'marked')).toBe('a package beyond @ui-sdk/core and @ui-sdk/web')
  expect(crossing(join(SDK, 'primitives', 'x.ts'), '../model.js')).toBeUndefined()
  expect(crossing(at, '@ui-sdk/web/menu')).toBeUndefined()
})
