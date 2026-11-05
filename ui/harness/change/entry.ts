import { mountChangeReader } from '../../src/board/workspace/ChangeReader.js'
import type { ChangeBundle } from '../../src/board/workspace/changeModel.js'
import { renderMarkdown } from '../../src/board/utils.js'

declare global {
  interface Window { __mountChange: (bundle: ChangeBundle) => void; __renderMarkdown: typeof renderMarkdown }
}

window.__renderMarkdown = renderMarkdown
let mounted: ReturnType<typeof mountChangeReader> | undefined
window.__mountChange = bundle => {
  mounted?.dispose()
  const root = document.getElementById('root')!
  root.replaceChildren()
  mounted = mountChangeReader(root, bundle, 'dom-conservation')
}
