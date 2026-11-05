import { fileURLToPath } from 'node:url'

/** Keep the production and offline reader builds on the same grammar and theme budget. */
export const changeAliases = [
  { find: 'shiki/langs', replacement: fileURLToPath(new URL('./src/board/workspace/changeLanguages.ts', import.meta.url)) },
  { find: '@pierre/theming/themes', replacement: fileURLToPath(new URL('./src/board/workspace/changeThemes.ts', import.meta.url)) },
  { find: '@pierre/highlights/themes/loader', replacement: fileURLToPath(new URL('./src/board/workspace/changeThemes.ts', import.meta.url)) },
]
