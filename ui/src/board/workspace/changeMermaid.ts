import type { MermaidConfig } from 'mermaid'
import { APPEARANCE_CHANGED } from '../appearance.js'

type Mermaid = typeof import('mermaid').default

let loading: Promise<Mermaid> | undefined
let drawn = 0
const figures = new Map<HTMLElement, string>()

/**
 * Replaces each mermaid fence in rendered story Markdown with its diagram.
 * Mermaid loads as its own chunk the first time a story holds a fence. A
 * diagram takes the board's colours as they stand and is drawn again when the
 * appearance changes. A fence Mermaid cannot parse stays as its source.
 */
export function drawMermaid(root: HTMLElement): void {
  const fences = [...root.querySelectorAll<HTMLElement>('pre.language-mermaid')]
  if (!fences.length) return
  // Only figures still on a page are kept for redrawing, so a page left lets go of its own.
  for (const figure of figures.keys()) if (!figure.isConnected) figures.delete(figure)
  if (!loading) {
    loading = import('mermaid').then(module => module.default)
    window.addEventListener(APPEARANCE_CHANGED, () => {
      for (const figure of figures.keys()) if (!figure.isConnected) figures.delete(figure)
      void draw([...figures.keys()])
    })
  }
  void draw(fences.map(fence => {
    const figure = document.createElement('figure')
    figure.className = 'change-mermaid'
    figures.set(figure, fence.textContent ?? '')
    fence.replaceWith(figure)
    return figure
  }))
}

async function draw(targets: HTMLElement[]): Promise<void> {
  if (!targets.length) return
  const mermaid = await loading!
  mermaid.initialize(config(targets[0].isConnected ? targets[0] : document.documentElement))
  for (const figure of targets) {
    const source = figures.get(figure) ?? ''
    try {
      figure.innerHTML = (await mermaid.render(`change-mermaid-${++drawn}`, source)).svg
    } catch {
      const fallback = document.createElement('pre')
      fallback.className = 'md-code-block change-mermaid-failed'
      fallback.textContent = source
      figure.replaceChildren(fallback)
    }
  }
}

function config(scope: Element): MermaidConfig {
  const [ink, soft, paper, node, machine, fill, hairline] = resolve(scope, [
    'var(--ws-ink)', 'var(--ws-ink-soft)', 'var(--ws-paper)',
    'color-mix(in srgb, var(--ws-machine) 18%, var(--ws-paper))', 'var(--ws-machine)', 'var(--ws-fill)', 'var(--ws-hairline)',
  ])
  return {
    startOnLoad: false,
    suppressErrorRendering: true,
    theme: 'base',
    fontFamily: 'var(--font-serif)',
    themeVariables: {
      background: paper, mainBkg: node, primaryColor: node, primaryTextColor: ink, primaryBorderColor: machine,
      secondaryColor: fill, tertiaryColor: paper, lineColor: soft, textColor: ink,
      clusterBkg: fill, clusterBorder: hairline, edgeLabelBackground: paper,
    },
  }
}

/** CSS colours as hex, which Mermaid's colour maths reads whatever space the board's tokens use. */
function resolve(scope: Element, colors: string[]): string[] {
  const probe = scope.appendChild(document.createElement('span'))
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const paint = canvas.getContext('2d', { willReadFrequently: true })
  const resolved = colors.map(css => {
    probe.style.color = css
    const computed = getComputedStyle(probe).color
    if (!paint) return computed
    paint.clearRect(0, 0, 1, 1)
    paint.fillStyle = computed
    paint.fillRect(0, 0, 1, 1)
    return `#${[...paint.getImageData(0, 0, 1, 1).data.slice(0, 3)].map(v => v.toString(16).padStart(2, '0')).join('')}`
  })
  probe.remove()
  return resolved
}
