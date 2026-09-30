<p align="center">
  <img src=".github/banner.jpg" alt="felt" width="600">
</p>

<p align="center">
  <a href="https://github.com/cailmdaley/felt/actions/workflows/ci.yml"><img src="https://github.com/cailmdaley/felt/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

# felt

**[Documentation](https://cailmdaley.github.io/felt/)**

**felt** is a work journal made of markdown files, with a CLI. Each entry is a "fiber": a
directory under `.felt/` holding one markdown file — YAML frontmatter (`name`, `status`, `tags`,
`outcome`, timestamps) above a free-form body. A fiber holds a task, a decision, a finding, a
question, or a spec. Directories nest fibers into a hierarchy; `[[wikilinks]]` in bodies
cross-reference them. The `felt` command adds, edits, searches, and shows them; the markdown holds
everything, so the store diffs and versions like the rest of your repo.

**shuttle** is a separate Go CLI and optional daemon built on felt. felt treats a `shuttle:`
frontmatter block as opaque data; shuttle interprets it as a "constitution" — a description of a
desired end state, not a list of steps. The daemon launches one tmux worker per active
constitution; the worker drives toward that state, rewrites the fiber's `outcome` and `## Status`
on exit, and the next worker lands warm. A localhost status board shows the fleet and lets you
steer it.

This repository ships two Go CLIs — `felt` for memory and notes, `shuttle` for orchestration —
plus the optional shuttle daemon and its board UI. You can use felt on its own to record, search,
and link with nothing running. It gives AI agents the same memory it gives you: one plugin
installs into Claude Code and Codex, and a pi package into pi. The shuttle daemon is optional;
adopt it when you want work dispatched, not just recorded.

![Shuttle board with example data](docs/assets/shuttle-board-example.png)

*Shuttle board with example data.*

Any other top-level YAML key in a fiber's frontmatter is preserved opaquely, so another tool can
own its own schema without felt claiming it. Back-references, data-flow consumers, and body search
are computed from the markdown tree on demand — nothing else to maintain.

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
go install github.com/cailmdaley/felt/cmd/felt@latest                            # felt from source
go install github.com/cailmdaley/felt/cmd/shuttle@latest                         # shuttle from source
```

The install script needs only `curl` and `tar`. It supports macOS and Linux on x86_64 and arm64.
It installs both Go CLIs to `/usr/local/bin` if writable, else `~/.local/bin`; override the
location with `FELT_INSTALL_DIR`. If `claude`, `codex`, or `pi` is on your `PATH`, it also
registers the shared plugin and package. Later, `felt update` replaces both Go binaries together
and refreshes the plugin wiring.

Add the optional shuttle daemon with `SHUTTLE_DAEMON=1`:

```bash
curl -fsSL https://raw.githubusercontent.com/cailmdaley/felt/main/install.sh | SHUTTLE_DAEMON=1 sh
```

Put `SHUTTLE_DAEMON=1` after the pipe, on `sh`, so the installer sees it. The daemon release
carries its own Erlang runtime and board bundle; running it needs tmux plus both Go CLIs on
`PATH`. See [Installation](https://cailmdaley.github.io/felt/shuttle/installation/).

## Quickstart

```bash
felt init                                            # create .felt/ in this project
felt add covariance-estimation "Covariance estimation"
felt edit covariance-estimation -s active            # status is opt-in
felt edit covariance-estimation -s closed -o "jackknife — 10x faster, <2% bias"
felt show covariance-estimation                      # body, metadata, back-references
felt tree                                            # containment hierarchy
felt ls -s all "jackknife"                           # search names, outcomes, frontmatter
felt find "jackknife"                                # the same search, across the whole store
felt setup claude                                    # install the Claude Code plugin
felt setup codex                                     # install the Codex plugin
felt setup pi                                        # install the pi package
```

## Documentation

Everything deeper lives at **<https://cailmdaley.github.io/felt/>**:

- concepts — fibers, stores, nesting, wikilinks, outcomes, frontmatter ownership
- the full command reference and flags
- agent integration — one plugin for Claude Code and Codex, one pi package, shared skills and hook-equivalent behavior
- Obsidian compatibility — open a `.felt/` directory directly as an Obsidian vault
- the shuttle layer — constitutions, dispatch, the board, the HTTP API
- installing and operating the daemon, including its sharp edges

## Contributing

See **[CONTRIBUTING.md](CONTRIBUTING.md)** to get set up, and **[AGENTS.md](AGENTS.md)** for the
architecture, build and lifecycle, deploy path, and invariants. Issues and pull requests are
welcome.

## License

Both Go CLIs and the board UI are under the [MIT License](LICENSE). The shuttle daemon (`daemon/lib/`)
contains code derived from OpenAI's Symphony under the [Apache License 2.0](LICENSE-APACHE),
preserved in [`NOTICE`](NOTICE).
