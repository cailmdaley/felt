---
title: '[felt] Build concise documentation'
status: closed
created-at: 2026-01-12T23:28:51.891705+01:00
closed-at: 2026-01-22T15:48:18.756391+01:00
outcome: Updated reason
---

(build-concise-documentation)=
# Goal

Build tight, concise documentation for felt. One README + up to 4 reference docs. ~300 lines total. Readable by humans and LLMs equally.

## Philosophy

Documentation should be discoverable, not exhaustive. If something is obvious from `felt --help`, don't repeat it. Document the *why* and the *mental model*, not just the *what*.

## Structure

```
docs/
  README.md      # Quick start + philosophy (~80-100 lines)
  [reference]/   # Up to 4 docs, discovered from code needs
```

### README.md
- Why felt exists (1-2 paragraphs)
- Install (3 lines)
- Quick start (create, depend, close — 10 lines)
- Core mental model: fibers, DAG, closure-as-documentation
- Link to reference docs

### Reference Docs (Ralph discovers)
- Look at the code, find what needs explaining
- Each doc should earn its place
- If something is more important than existing content, replace

## Iteration Loop

1. Read through felt codebase (cmd/, internal/)
2. Identify concepts/features not yet documented
3. If docs < 300 lines: add documentation for most important gap
4. If docs >= 300 lines: check if any gap is MORE important than existing content
   - If yes: replace less important content
   - If no: done
5. Repeat until nothing more important to add

## Completion Criteria

- [ ] README.md exists with quick start + philosophy
- [ ] Reference docs cover non-obvious concepts discovered from code
- [ ] Total lines <= 300
- [ ] No redundancy with `felt --help` output
- [ ] Equally readable by human and LLM

## Style Guidelines

- Terse but not cryptic
- Examples over explanations where possible
- Code blocks for commands
- No fluff, no "Welcome to felt!"
- Hooks: summarize what `felt hook session` does, don't include full output

## Context Pointers

- Felt codebase: ~/code/felt/
- Felt binary: ~/code/felt/felt
- Session hook spec: archived dot loom-loom-rewrite-dots-in-go-with-dag-38dacd71
