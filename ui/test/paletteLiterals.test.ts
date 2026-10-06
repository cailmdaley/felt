import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * Every colour the board paints comes from `src/board/palette.css`, so one
 * appearance switch re-inks all of it. A literal written anywhere else would
 * stay light in the dark (or dark in the light). Constitution themes carry
 * their own palettes and are exempt; so are the few places listed below,
 * each for the reason given.
 */
const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const PALETTE = 'board/palette.css'
const THEMES = /^board\/workspace\/themes\//
const LITERAL = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|(?<![\w-])(?:white|black)(?![\w-])/gi
const EXEMPT: Array<[path: string, line: RegExp, reason: string]> = [
  ['forms/settings/AppearanceSection.tsx', /paper: '#[\da-f]{6}', ornament: '#[\da-f]{6}'/i, 'swatches preview each dark theme in its own colours'],
  ['board/workspace/AudioPage.ts', /\|\| '#[\da-f]{6}'/i, 'canvas fallback when computed style is empty'],
  ['board/workspace/MediaPoster.ts', /\|\| '#[\da-f]{6}'/i, 'canvas fallback when computed style is empty'],
  ['board/workspace/receiptMotion.ts', /\|\| '0 8px 18px rgba/, 'animation fallback when the shadow token is unset'],
  ['board/views/ChronicleView.css', /mask-image:/, 'a mask reads alpha, not colour'],
]

function sources(): Array<{ path: string; lines: string[] }> {
  const out: Array<{ path: string; lines: string[] }> = []
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(SRC, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) { walk(child); continue }
      if (!/\.(css|tsx?)$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue
      if (child === PALETTE || THEMES.test(child)) continue
      // Blank comments out, keeping line numbers, so prose about a colour is not a colour.
      const text = readFileSync(join(SRC, child), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
      out.push({ path: child, lines: text.split('\n') })
    }
  }
  walk('board'); walk('forms')
  return out
}

describe('the palette owns every colour', () => {
  it('writes no colour literal outside the palette and the constitution themes', () => {
    const found: string[] = []
    for (const { path, lines } of sources()) {
      lines.forEach((line, i) => {
        const hits = line.replace(/white-space|&#\d+;/g, '').match(LITERAL)
        if (!hits) return
        if (EXEMPT.some(([p, pattern]) => p === path && pattern.test(line))) return
        found.push(`${path}:${i + 1}: ${hits.join(' ')}`)
      })
    }
    expect(found).toEqual([])
  })
})
