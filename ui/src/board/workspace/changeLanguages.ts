/** The change reader ships these grammars; other source files remain plain text. */
export const bundledLanguages = {
  go: () => import('@shikijs/langs/go'),
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  python: () => import('@shikijs/langs/python'),
  elixir: () => import('@shikijs/langs/elixir'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  json: () => import('@shikijs/langs/json'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  markdown: () => import('@shikijs/langs/markdown'),
  css: () => import('@shikijs/langs/css'),
  html: () => import('@shikijs/langs/html'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  rust: () => import('@shikijs/langs/rust'),
  sql: () => import('@shikijs/langs/sql'),
  latex: () => import('@shikijs/langs/latex'),
}
const extensions: Record<string, keyof typeof bundledLanguages> = {
  go: 'go', ts: 'typescript', tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  py: 'python', ex: 'elixir', exs: 'elixir', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', md: 'markdown', css: 'css', html: 'html',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', rs: 'rust', sql: 'sql', tex: 'latex',
}
export function changeLanguage(path: string): keyof typeof bundledLanguages | 'text' {
  return extensions[path.split('.').at(-1) ?? ''] ?? 'text'
}
