# felt

**felt is a CLI for the durable trail that builds up around work.**

Each entry is a *fiber*: a directory under `.felt/` holding a `<slug>.md` file
with YAML frontmatter and a plain markdown body. A fiber can be a task, a
decision, a question, a finding, a spec, or a reference doc. The tree of
directories is the hierarchy. `[[wikilinks]]` in bodies are the narrative
cross-references.

There is no database. Back-references, reverse consumers, and body search are
computed from the markdown on demand. The markdown *is* the store — so the
store stays readable, greppable, diffable, and yours.

```bash
felt add covariance-estimation "Covariance estimation" -s open
felt edit covariance-estimation -s closed \
  -o "Jackknife on 150 patches — 10x faster than analytic, <2% bias"
```

## Why it exists

Work leaves a trail: the thing you decided, the reason you rejected the other
option, the number you measured at 2am. Issue trackers want tickets. Notes apps
want a silo. Neither survives contact with a coding agent, which needs the trail
in a form it can read and write without a special client.

felt takes the boring option. Plain markdown files in a directory next to the
code. That makes the store legible to three readers at once:

- **You**, with any editor. A `.felt/` directory opens as an
  [Obsidian](https://obsidian.md) vault — the wikilinks and graph view work
  because the format is the same.
- **Your tooling**, with `grep`, `git`, and the `felt` CLI.
- **Coding agents**, which read and write fibers through the same CLI you do.
  felt ships a plugin for Claude Code and Codex so agents see the active fibers
  at session start and file what they learn before they exit.

That last reader is the design constraint, not an afterthought. Agent sessions
end. The fiber tree is what carries context to the next one.

Metadata stays small on purpose. Everything except `name` is optional, `status`
is opt-in, and any frontmatter key felt does not own is preserved untouched — so
downstream tools can layer their own schema without felt claiming it.

## felt and Shuttle

This repository builds two things.

**felt** is the CLI and the data model. It is the whole product for most people.
It has no daemon, no server, and no runtime dependencies. The only network calls
are `felt update` and `felt setup`, which fetch from GitHub on demand; the store
itself never leaves your disk. If you want a fiber tracker and agent memory, you
can stop at felt.

**Shuttle** is an optional orchestration layer on top of it. A fiber that
carries a `shuttle:` frontmatter block becomes a *constitution* — a spec of a
desired state. An Elixir/OTP daemon polls the tree, launches one tmux worker per
eligible fiber, and serves a kanban board at `http://127.0.0.1:4000/`. Workers
hand off to each other through the fiber, so a piece of work can span many
sessions.

Shuttle is the more experimental half, and it is **currently fleet-oriented** —
it runs the maintainer's machines every day, and parts of it still say so. See
[Honest scoping](shuttle/index.md#honest-scoping) for the full list. Nothing
about felt changes if you ignore it.

## Where to go next

| If you want to | Read |
|---|---|
| Install the CLI and file your first fiber | [Getting started](getting-started.md) |
| Understand what a fiber is | [Fibers](concepts/fibers.md) |
| Learn statuses, nesting, outcomes, wikilinks | [Organizing](concepts/organizing.md) |
| Carry your own YAML alongside felt's | [Frontmatter](concepts/frontmatter.md) |
| Attach plots, PDFs, and HTML reports to a fiber | [Companion files](concepts/companions.md) |
| Search across every project at once | [Cross-project stores](concepts/cross-project.md) |
| Wire up Claude Code or Codex | [Agent integration](agents.md) |
| See the orchestration layer | [Shuttle](shuttle/index.md) |
| Look up a command | [CLI reference](reference/cli.md) |

## License

The felt CLI and the board UI are under the
[MIT License](https://github.com/cailmdaley/felt/blob/main/LICENSE). The Shuttle
daemon (`lib/`) contains code derived from OpenAI's Symphony under the
[Apache License 2.0](https://github.com/cailmdaley/felt/blob/main/LICENSE-APACHE),
preserved in [`NOTICE`](https://github.com/cailmdaley/felt/blob/main/NOTICE).

## Contributing

Source and issues:
[github.com/cailmdaley/felt](https://github.com/cailmdaley/felt). To build or
patch felt, read
[CONTRIBUTING.md](https://github.com/cailmdaley/felt/blob/main/CONTRIBUTING.md)
for the setup, and
[AGENTS.md](https://github.com/cailmdaley/felt/blob/main/AGENTS.md) for the
architecture, build and lifecycle, deploy path, and invariants.
