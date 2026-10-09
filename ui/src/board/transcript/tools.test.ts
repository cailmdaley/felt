import { describe, expect, it } from 'vitest'
import { toolLabel } from './tools.js'

describe('toolLabel', () => {
  it('quietly summarizes shell commands and marks truncated multiline commands', () => {
    expect(toolLabel('Bash', { command: 'git log --oneline -5\nmore detail' })).toEqual({
      name: 'Bash', summary: 'git log --oneline -5 …',
    })
    expect(toolLabel('bash', 'npm test')).toEqual({ name: 'Bash', summary: 'npm test' })
    expect(toolLabel('exec_command', { cmd: 'pytest tests/test_response.py' })).toEqual({
      name: 'Exec_command', summary: 'pytest tests/test_response.py',
    })
  })

  it('extracts a Codex exec command from source without exposing the source', () => {
    expect(toolLabel('exec', { code: 'await tools.exec_command({cmd: "git status --short", max_output_tokens: 10})' })).toEqual({
      name: 'Exec', summary: 'git status --short',
    })
    expect(toolLabel('exec', { code: 'no command here' })).toEqual({ name: 'Exec', summary: '' })
  })

  it('decodes quoted Codex command fields without throwing on invalid code points', () => {
    expect(toolLabel('exec', { code: String.raw`await tools.exec_command({"cmd": 'printf \x41\nline'})` })).toEqual({
      name: 'Exec', summary: 'printf A …',
    })
    expect(toolLabel('exec', { code: String.raw`await tools.exec_command({cmd: 'printf \u{110000}'})` })).toEqual({
      name: 'Exec', summary: String.raw`printf \u{110000}`,
    })
  })

  it('shortens file paths and gives search tools their useful query', () => {
    expect(toolLabel('Read', { file_path: '/home/cail/project/src/response.py' })).toEqual({ name: 'Read', summary: 'src/response.py' })
    expect(toolLabel('Edit', { path: 'src/response.py' })).toEqual({ name: 'Edit', summary: 'src/response.py' })
    expect(toolLabel('grep', { pattern: 'null test', path: '/repo/tests' })).toEqual({ name: 'Grep', summary: 'null test in repo/tests' })
    expect(toolLabel('Glob', { pattern: '**/*response*' })).toEqual({ name: 'Glob', summary: '**/*response*' })
  })

  it('uses focused summaries for collaboration and browser tools', () => {
    expect(toolLabel('Task', { description: 'Check the mask split', subagent_type: 'reviewer' })).toEqual({ name: 'Task', summary: 'Check the mask split' })
    expect(toolLabel('WebFetch', { url: 'https://example.test/paper' })).toEqual({ name: 'WebFetch', summary: 'https://example.test/paper' })
    expect(toolLabel('WebSearch', { query: 'shear response calibration' })).toEqual({ name: 'WebSearch', summary: 'shear response calibration' })
    expect(toolLabel('Skill', { skill: 'shear-check' })).toEqual({ name: 'Skill', summary: 'shear-check' })
    expect(toolLabel('TodoWrite', { todos: [{}, {}, {}] })).toEqual({ name: 'TodoWrite', summary: '3 items' })
    expect(toolLabel('SendMessage', { to: 'reviewer' })).toEqual({ name: 'SendMessage', summary: 'to reviewer' })
  })

  it('shows only the MCP tool name and bounds the one-line summary', () => {
    expect(toolLabel('mcp__github__create_issue', { title: 'response calibration' })).toEqual({
      name: 'create_issue', summary: 'response calibration',
    })
    const long = 'x'.repeat(200)
    expect(toolLabel('Other', { text: long }).summary).toHaveLength(160)
    expect(toolLabel('Other', { text: long }).summary.endsWith('…')).toBe(true)
  })
})
