// Dollar signs in outcomes and bodies: money stays prose, TeX still renders.
// The regression: an outcome listing several prices ("$5,866.24 (CapOne
// $1,232.30 …") rendered as one long italic KaTeX span, because the old
// extension paired any two `$` on a line.

import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './utils.js'

const isMath = (html: string) => html.includes('class="katex')

describe('dollar-delimited math', () => {
  it('leaves a line of prices as plain text', () => {
    const outcome =
      'Sep: total $5,866.24 (CapOne $1,232.30 Sep 20 · Fidelity $36.27 · ' +
      'Chase $1,090.29). USAA has $1,414.05 → target $4,652 in (with $200 buffer).'
    const html = renderMarkdown(outcome)
    expect(isMath(html)).toBe(false)
    expect(html).toContain('$5,866.24 (CapOne $1,232.30')
    expect(html).toContain('$200 buffer')
  })

  it('does not pair "$20 and $30"', () => {
    expect(isMath(renderMarkdown('between $20 and $30 a month'))).toBe(false)
  })

  it('does not close on a dollar followed by a digit', () => {
    expect(isMath(renderMarkdown('from $5 to$10'))).toBe(false)
  })

  it('renders inline math, including after punctuation', () => {
    expect(isMath(renderMarkdown('the $x$ axis'))).toBe(true)
    expect(isMath(renderMarkdown('a pseudo-$C_\\ell$ estimator'))).toBe(true)
    expect(isMath(renderMarkdown('$\\sigma_8 = 0.81$, roughly'))).toBe(true)
  })

  it('renders inline and block display math', () => {
    expect(renderMarkdown('so $$E = mc^2$$ holds')).toContain('katex-display')
    expect(renderMarkdown('$$\n\\int f\\,dx\n$$')).toContain('katex-display')
  })

  it('treats an escaped dollar as a literal', () => {
    const html = renderMarkdown('costs \\$5 and \\$6')
    expect(isMath(html)).toBe(false)
    expect(html).toContain('$5 and $6')
  })

  it('leaves dollars inside code spans alone', () => {
    const html = renderMarkdown('run `echo $HOME$PATH`')
    expect(isMath(html)).toBe(false)
    expect(html).toContain('$HOME$PATH')
  })
})
