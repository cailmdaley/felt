import { expect, it } from 'vitest'
import { bundledLanguages, changeLanguage } from './changeLanguages.js'

it('ships only the chosen grammars and renders all other extensions as text', async () => {
  expect(Object.keys(bundledLanguages)).toEqual(['go', 'typescript', 'tsx', 'javascript', 'jsx', 'python', 'elixir', 'shellscript', 'json', 'yaml', 'toml', 'markdown', 'css', 'html', 'c', 'cpp', 'rust', 'sql', 'latex'])
  expect(changeLanguage('src/main.go')).toBe('go')
  expect(changeLanguage('bin/check.sh')).toBe('shellscript')
  expect(changeLanguage('src/header.h')).toBe('c')
  expect(changeLanguage('src/source.rb')).toBe('text')
  expect(changeLanguage('Makefile')).toBe('text')
  for (const name of ['evil.constructor', 'evil.__proto__', 'evil.toString', '.constructor', '.__proto__']) expect(changeLanguage(name)).toBe('text')
  for (const loader of Object.values(bundledLanguages)) expect((await loader()).default.length).toBeGreaterThan(0)
})
