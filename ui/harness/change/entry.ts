import { mountChangeReader } from '../../src/board/workspace/ChangeReader.js'
import type { ChangeBundle } from '../../src/board/workspace/changeModel.js'
import { renderMarkdown } from '../../src/board/utils.js'
import { isHighlighterLoaded, disposeHighlighter } from '@pierre/diffs'

declare global {
  interface Window {
    __mountChange: (bundle: ChangeBundle) => void
    __disposeChange: () => void
    __renderMarkdown: typeof renderMarkdown
    __changeHighlighterLoaded: typeof isHighlighterLoaded
  }
}

window.__renderMarkdown = renderMarkdown
window.__changeHighlighterLoaded = isHighlighterLoaded
let mounted: ReturnType<typeof mountChangeReader> | undefined
window.__disposeChange = () => {
  mounted?.dispose()
  mounted = undefined
  void disposeHighlighter()
}
window.__mountChange = bundle => {
  window.__disposeChange()
  const root = document.getElementById('root')!
  root.replaceChildren()
  mounted = mountChangeReader(root, bundle, 'change-smoke')
}
