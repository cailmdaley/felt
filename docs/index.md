# felt

**felt tracks the durable trail that builds up around work, from the command
line.**

!!! warning "A personal experiment, evolving fast"

    felt is a personal experiment in agentic working practices, and it will keep
    evolving with the state of the field. It moves fast, it is shaped by one
    person's daily use, and it makes no promise of backwards compatibility —
    expect commands, formats and defaults to change between versions. Your
    fibers are plain markdown in your own git repository, so the trail survives
    whatever felt does next. That is the guarantee on offer.

Each entry — a *fiber* — lives in its own directory under `.felt/`. The
directory holds a `<slug>.md` file with YAML frontmatter and a plain markdown
body. File a fiber for a task, a decision, a question, a finding, a spec, or a
reference doc. Nest the directories to build hierarchy. Write `[[wikilinks]]`
in bodies to cross-reference.

felt computes back-references, reverse consumers, and body search from the
markdown on demand. So the store stays readable, greppable, diffable, and
yours.

Install it in one line — [Getting started](getting-started.md) walks the rest:

```bash
curl -fsSL https://raw.githubusercontent.com/cailmdaley/felt/main/install.sh | sh
```

```bash
felt add covariance-estimation "Covariance estimation" -s open
felt edit covariance-estimation -s closed \
  -o "Jackknife on 150 patches — 10x faster than analytic, <2% bias"
```

## The trail and its readers

Work leaves a trail: the thing you decided, the reason you rejected the other
option, the number you measured at 2am. Issue trackers want tickets. Notes apps
want a silo. Neither survives contact with a coding agent, which needs the trail
in a form it can read and write without a special client.

felt takes the boring option. Plain markdown files in a directory next to the
code. That keeps the store legible to three readers at once:

- **You**, with any editor. A `.felt/` directory opens as an
  [Obsidian](https://obsidian.md) vault — the wikilinks and graph view work
  because the format matches.
- **Your tooling**, with `grep`, `git`, and the `felt` CLI.
- **Coding agents**, which read and write fibers through the same CLI you do.
  felt ships a plugin for Claude Code and Codex so agents see the active fibers
  at session start and file what they learn before they exit.

felt treats that last reader as a design constraint, not an afterthought. Agent
sessions end. The fiber tree carries context to the next one.

Metadata stays small on purpose. Everything except `name` is optional. `status`
is opt-in. felt preserves any frontmatter key it does not own, so downstream
tools can layer their own schema without felt claiming it.

## felt and shuttle

This repository builds two things.

**felt** gives you the CLI and the data model. Most people need nothing more.
It runs with no daemon, no server, and no runtime dependencies. Only `felt
update` and `felt setup` reach the network, and they fetch from GitHub on
demand; the store itself never leaves your disk. If you want a fiber tracker
and agent memory, you can stop at felt.

**shuttle** adds an optional orchestration layer on top. Give a fiber a
`shuttle:` frontmatter block and it becomes a *constitution* — a spec of a
desired state. An Elixir/OTP daemon polls the tree. It launches one tmux worker
per eligible fiber, and serves a [board](shuttle/board.md) at
`http://127.0.0.1:4000/` — a kanban desk for steering the work, and four more
views for seeing where the time went. Workers hand off to each other through
the fiber, so a piece of work can span many sessions.

shuttle stays the more experimental half, and it runs the author's machines
every day. The daemon installs the way the CLI does:

```bash
curl -fsSL https://raw.githubusercontent.com/cailmdaley/felt/main/install.sh | SHUTTLE=1 sh
```

That fetches a prebuilt daemon for your platform, carrying its own Erlang
runtime and the board bundle, so the host needs no toolchain to run it. (The
variable goes after the pipe, on `sh`. In front of `curl` it sets curl's
environment and the script never sees it.) What is still rough is operating it:
see [Honest scoping](shuttle/index.md#honest-scoping). Ignore shuttle and felt
behaves the same.

## Where to go next

| If you want to | Read |
|---|---|
| Install the CLI and file your first fiber | [Getting started](getting-started.md) |
| Understand the fiber layout on disk | [Fibers](concepts/fibers.md) |
| Learn statuses, nesting, outcomes, wikilinks | [Organizing](concepts/organizing.md) |
| Carry your own YAML alongside felt's | [Frontmatter](concepts/frontmatter.md) |
| Attach plots, PDFs, and HTML reports to a fiber | [Companion files](concepts/companions.md) |
| Search across every project at once | [Cross-project stores](concepts/cross-project.md) |
| Wire up Claude Code or Codex | [Agent integration](agents.md) |
| See shuttle orchestration | [shuttle](shuttle/index.md) |
| Look up a command | [CLI reference](reference/cli.md) |

## License

The felt CLI and the board UI ship under the
[MIT License](https://github.com/cailmdaley/felt/blob/main/LICENSE). The shuttle
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
