import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import ts from 'typescript'
import { expect, it } from 'vitest'

const board = fileURLToPath(new URL('../src/board/', import.meta.url))
const events = new Set(['pointerenter', 'pointerleave', 'pointerover', 'pointerout', 'mouseenter', 'mouseleave', 'mouseover', 'mouseout'])

// These exact listeners belong to surfaces outside the Desk design.
// Adding a listener, even in one of these files, needs its own reason.
const exceptions = [
  { file: 'workspace/AudioPage.ts', source: "this.waveform.addEventListener('pointerleave', () => { this.hover.hidden = true })", reason: 'The workspace audio waveform clears its time cursor when the pointer leaves.' },
  { file: 'workspace/Depth.ts', source: "document.addEventListener('pointerleave', this.leave)", reason: 'Workspace depth resets its pointer drift when leaving the document, only while the workspace is raised.' },
  { file: 'views/ChronicleView.ts', source: "el.addEventListener('mouseenter', () => hot(true))", reason: 'Chronicle tints a settled cycle under the pointer without changing its content or geometry.' },
  { file: 'views/ChronicleView.ts', source: "el.addEventListener('mouseleave', () => hot(false))", reason: 'Chronicle restores the settled cycle tint when the pointer leaves.' },
] as const

function files(dir: string, extension: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? files(path, extension) : extension.test(entry.name) ? [path] : []
  })
}

function pointerListeners(text: string): string[] {
  const source = ts.createSourceFile('board.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[] = []
  const property = (node: ts.Node): string | undefined => ts.isPropertyAccessExpression(node) ? node.name.text
    : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && property(node.expression) === 'addEventListener') {
      const event = node.arguments[0]
      if (event && ts.isStringLiteralLike(event) && events.has(event.text)) found.push(node.getText(source))
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const name = property(node.left)
      if (name?.startsWith('on') && events.has(name.slice(2).toLowerCase())) found.push(node.getText(source))
    }
    if (ts.isJsxAttribute(node) && events.has(node.name.getText(source).toLowerCase().replace(/^on/, ''))) found.push(node.getText(source))
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

// New stylesheets are guarded by default. Only these named surfaces are
// outside the Desk design; shared chrome and tint palettes remain in scope.
const styleExceptions = [
  { path: 'workspace/', reason: 'The document workspace, conversation and thread rail keep their own interaction design.' },
  { path: 'transcript/', reason: 'Transcript reading and search controls belong to the conversation surface.' },
  { path: 'views/ChronicleView.css', reason: 'Chronicle is a separate temporal view, outside the Desk design.' },
  { path: 'FileViewerPanel.css', reason: 'Document and media viewers belong to the reader, not Desk cards.' },
  { path: 'prose.css', reason: 'Rendered document prose and wikilinks belong to the reader, not Desk cards.' },
] as const
const tintProperties = new Set(['color', 'background', 'background-color', 'border-color', 'border-top-color', 'border-bottom-color', 'border-left-color', 'border-right-color', 'outline-color', 'text-decoration-color', 'fill', 'stroke', '--kbn-row-ground'])

function hoverViolations(css: string): string[] {
  const violations: string[] = []
  const root = postcss.parse(css)
  root.walkDecls(decl => {
    // A declaration nested in an at-rule or a nested selector still inherits
    // every :hover on its rule ancestors. Walk the parsed tree, not CSS text.
    let parent = decl.parent
    let hover = false
    while (parent) {
      if (parent.type === 'rule' && /:hover\b/.test(parent.selector)) hover = true
      parent = parent.parent
    }
    if (hover && (!tintProperties.has(decl.prop.toLowerCase()) || /url\s*\(/i.test(decl.value))) {
      violations.push(`${decl.source?.start?.line}: ${decl.prop}: ${decl.value}`)
    }
  })
  root.walkAtRules('media', rule => {
    if (/\(\s*hover\s*:\s*none\s*\)/i.test(rule.params)) violations.push(`${rule.source?.start?.line}: hover:none compensation`)
  })
  return violations
}

it('keeps pointer-over listeners out of the Desk, with narrowly reasoned exceptions for other surfaces', () => {
  const unused = new Set(exceptions)
  const violations: string[] = []
  for (const path of files(board, /\.(ts|tsx)$/).filter(path => !/\.(test|spec)\./.test(path))) {
    const file = relative(board, path)
    for (const source of pointerListeners(readFileSync(path, 'utf8'))) {
      const exception = exceptions.find(entry => entry.file === file && entry.source === source && unused.has(entry))
      if (exception) {
        expect(exception.reason.trim()).not.toBe('')
        expect(exception.reason).not.toMatch(/[\r\n]/)
        unused.delete(exception)
      } else violations.push(`${file}: ${source}`)
    }
  }
  expect(violations).toEqual([])
  expect([...unused], 'Remove obsolete exceptions rather than broadening them').toEqual([])
})

it('allows only flat tint declarations under Desk :hover selectors', () => {
  const used = new Set<string>()
  const violations = files(board, /\.css$/).flatMap(path => {
    const file = relative(board, path)
    const exception = styleExceptions.find(entry => entry.path.endsWith('/') ? file.startsWith(entry.path) : file === entry.path)
    if (exception) {
      expect(exception.reason.trim()).not.toBe('')
      expect(exception.reason).not.toMatch(/[\r\n]/)
      used.add(exception.path)
      return []
    }
    return hoverViolations(readFileSync(path, 'utf8')).map(message => `${file}:${message}`)
  })
  expect(violations).toEqual([])
  expect([...used].sort(), 'Remove obsolete stylesheet exclusions').toEqual(styleExceptions.map(entry => entry.path).sort())
})

it('recognizes pointer listeners across syntax and ignores comments and teardown', () => {
  for (const event of events) {
    for (const statement of [`el.addEventListener('${event}', show)`, `el["addEventListener"]("${event}", show)`, `el.on${event} = show`, `<div on${event}={show} />`]) {
      expect(pointerListeners(statement), statement).toHaveLength(1)
    }
  }
  expect(pointerListeners("// el.addEventListener('mouseenter', show)\nel.removeEventListener('pointerleave', hide)\nel.addEventListener('pointerdown', open)")).toEqual([])
})

it('checks declarations beneath nested selectors and media, including grouped and functional selectors', () => {
  const forbidden = ['opacity', 'display', 'visibility', 'transform', 'content', 'width', 'height', 'max-height', 'min-width', 'inline-size', 'box-shadow', 'font-size', 'text-decoration', 'pointer-events']
  for (const prop of forbidden) {
    const css = `@media (pointer: fine) { .row { &:is(:hover, :focus-visible), &.selected { @media (min-width: 1px) { > span { ${prop}: initial } } } } }`
    expect(hoverViolations(css), prop).toHaveLength(1)
  }
  expect(hoverViolations('.row:hover { color: red; & > span { background-color: blue } } .row:focus { opacity: 1 }')).toEqual([])
  expect(hoverViolations('.row:hover { background: url(image.png) }')).toHaveLength(1)
  expect(hoverViolations('@media (hover: none) { .row { opacity: 1 } }')).toHaveLength(1)
})
