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

**shuttle** is a daemon that runs AI coding agents against those fibers. Add a `shuttle:` block to
a fiber and it becomes a "constitution" — a description of a desired end state, not a list of
steps. The daemon launches one tmux worker per active constitution; the worker drives toward that
state, rewrites the fiber's `outcome` and `## Status` on exit, and the next worker lands warm. A
localhost status board shows the fleet and lets you steer it.

This repo ships both. felt works entirely on its own — record, search, and link with nothing
running — and it gives AI agents the same memory it gives you: one plugin installs into Claude
Code and Codex, and a pi package into pi. shuttle is strictly optional; adopt it when you want
work dispatched, not just recorded.

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
go install github.com/cailmdaley/felt@latest                                      # from source
```

The install script needs only `curl` and `tar`. It supports macOS and Linux on x86_64 and arm64.
It installs to `/usr/local/bin` if writable, else `~/.local/bin`; override with `FELT_INSTALL_DIR`.
If `claude`, `codex`, or `pi` is on your `PATH`, it also registers the felt plugin for them. Later,
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
felt find "jackknife"                                # the same search, across the whole store
felt setup claude                                    # install the Claude Code plugin
felt setup codex                                     # install the Codex plugin
felt setup pi                                        # install the pi package
```

## shuttle

The board is five views behind a hotkey row. A kanban desk is the first; beside it, Day, Week and
Chronicle fold a per-minute activity record — joined to fibers through recorded sessions and
commits — into where the time actually went, and a fifth lays out every file a worker sent as a
canvas of rendered pages. Details:
[The board](https://cailmdaley.github.io/felt/shuttle/board/).

Configure shuttle from your home directory. `~/.config/felt/agents.json` layers your agents over the
built-in set (`felt shuttle agents init` seeds it). `~/.config/felt/remotes.json` lists the remote
daemons a hub aggregates (`felt shuttle remotes add`). Linux and macOS both run a single host —
daemon, board, and workers — with the keep-alive installed as a systemd user unit or a launchd
LaunchAgent. Multi-host tunnel management (`felt shuttle tunnels`) installs the hub's autossh jobs
under whichever of the two the hub runs.

The daemon installs the way the CLI does:

```bash
curl -fsSL https://raw.githubusercontent.com/cailmdaley/felt/main/install.sh | SHUTTLE=1 sh
```

Note where `SHUTTLE=1` sits — after the pipe, on `sh`. In front of `curl` it sets curl's
environment, the script never sees it, and you get the CLI and no daemon.

What lands in `~/.local/share/shuttle` is a prebuilt daemon for your platform, carrying its own
Erlang runtime and the board bundle, so running the daemon needs no Erlang, Elixir or Node — only
tmux and `felt` on `PATH`. `FELT_VERSION` pins an exact tag, which is the only way to install a
release candidate: prereleases stay invisible to the plain line. Building from a checkout stays the
path for changing daemon code and for the fleet. felt works without the daemon either way. See
[Installation](https://cailmdaley.github.io/felt/shuttle/installation/) and
[Honest scoping](https://cailmdaley.github.io/felt/shuttle/#honest-scoping).

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

The felt CLI and the board UI are under the [MIT License](LICENSE). The shuttle daemon (`lib/`)
contains code derived from OpenAI's Symphony under the [Apache License 2.0](LICENSE-APACHE),
preserved in [`NOTICE`](NOTICE).
