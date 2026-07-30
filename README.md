<p align="center">
  <img src=".github/banner.png" alt="felt" width="600">
</p>

<p align="center">
  <a href="https://github.com/cailmdaley/felt/actions/workflows/ci.yml"><img src="https://github.com/cailmdaley/felt/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

# felt

**[Documentation](https://cailmdaley.github.io/felt/)**

felt is a CLI for the durable trail that builds up around work. Each entry is a *fiber*: a directory
under `.felt/` holding a `<slug>.md` file with YAML frontmatter and a plain-markdown body. A fiber
can be a task, a decision, a research claim, a question, or a spec.

The directory tree gives hierarchy. `[[wikilinks]]` in bodies give narrative cross-references.
Native metadata stays small — `name`, `status`, `tags`, timestamps, `outcome`, `due`, `description`.
Any other top-level YAML key is preserved opaquely, so another tool can own its own schema without
felt claiming it.

There is no database and no derived state on disk. Back-references, reverse data-flow consumers, and
body search are computed from the markdown tree on demand. The markdown *is* the store, so it adds
no authoring burden and diffs like the rest of your repo.

felt is built to be persistent memory for AI coding agents as much as for you. It ships one plugin
that installs into both Claude Code and Codex, and makes `.felt/` the thing an agent reaches for
between sessions.

A fiber on disk, at `.felt/covariance-estimation/covariance-estimation.md`:

```yaml
---
id: 01KTC9C1G1CBJ84H6WB92J8A13
name: Covariance estimation
status: closed
tags: [methods]
created-at: 2026-01-15T10:30:00Z
closed-at: 2026-01-16T14:20:00Z
outcome: "Jackknife covariance, 10x faster than analytic, <2% bias at all scales"
---

Tried analytic first — too slow for the number of bins we need.
Jackknife on 150 patches gives a stable diagonal and off-diagonal.

See also [[use-des-y3-weights]].
```

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/cailmdaley/felt/main/install.sh | sh  # release binary
brew install cailmdaley/tap/felt                                                  # Homebrew
go install github.com/cailmdaley/felt@latest                                      # from source
```

The install script needs only `curl` and `tar`, and supports macOS and Linux on x86_64 and arm64.
It installs to `/usr/local/bin` if writable, else `~/.local/bin`; override with `FELT_INSTALL_DIR`.
If `claude` or `codex` is on your `PATH`, it also registers the felt plugin for them. Later,
`felt update` refreshes both the binary and the plugin wiring.

## Quickstart

```bash
felt init                                            # create .felt/ in this project
felt add covariance-estimation "Covariance estimation"
felt edit covariance-estimation -s active            # status is opt-in
felt edit covariance-estimation -s closed -o "jackknife — 10x faster, <2% bias"
felt show covariance-estimation                      # body, metadata, back-references
felt tree                                            # containment hierarchy
felt ls -s all "jackknife"                           # search names, outcomes, frontmatter
felt setup claude                                    # install the Claude Code plugin
```

## Shuttle

The same repo ships **Shuttle**, an optional orchestration layer. Add a `shuttle:` block to a
fiber's frontmatter and it becomes a *constitution* — a spec of a desired state. An Elixir/OTP
daemon polls your felt stores, launches one tmux worker per eligible constitution, and serves a
kanban board at `http://127.0.0.1:4000/` for watching and steering them. Workers stay attachable;
each one rewrites the fiber's `outcome` and `## Status` on exit, so the next worker lands warm.

Shuttle is honest about its origins: it is **currently fleet-oriented**. The agent registry is
compiled into the binary, hostnames are hardcoded in `cmd/shuttle_tunnels.go` and `config/dev.exs`,
and the launchd keep-alive defaults `FELT_STORES` to `~/loom`, a private store. It runs, but you
will be adapting someone else's fleet rather than configuring your own. The daemon is not needed to
use felt. Full list:
[Honest scoping](https://cailmdaley.github.io/felt/shuttle/#honest-scoping).

## Documentation

Everything deeper lives at **<https://cailmdaley.github.io/felt/>**:

- concepts — fibers, stores, nesting, wikilinks, outcomes, frontmatter ownership
- the full command reference and flags
- agent integration — one plugin for Claude Code and Codex, its hooks and bundled skills
- Obsidian compatibility — a `.felt/` directory is a valid Obsidian vault
- the Shuttle layer — constitutions, dispatch, the board, the HTTP API
- installing and operating the daemon, including its sharp edges

## Contributing

See **[CONTRIBUTING.md](CONTRIBUTING.md)** to get set up, and **[AGENTS.md](AGENTS.md)** for the
architecture, build and lifecycle, deploy path, and invariants. Issues and pull requests are
welcome.

## License

The felt CLI and the board UI are under the [MIT License](LICENSE). The Shuttle daemon (`lib/`)
contains code derived from OpenAI's Symphony under the [Apache License 2.0](LICENSE-APACHE),
preserved in [`NOTICE`](NOTICE).
