<p align="center">
  <img src=".github/banner.jpg" alt="felt" width="600">
</p>

<p align="center">
  <a href="https://github.com/cailmdaley/felt/actions/workflows/ci.yml"><img src="https://github.com/cailmdaley/felt/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

# felt

**[Documentation](https://cailmdaley.github.io/felt/)**

felt keeps the durable trail that builds up around work — and, when you want it, keeps that work
moving while you're away. One repo ships two pieces on one substrate:

**felt** is the substrate. You record each entry as a *fiber*: a directory under `.felt/`, holding
a `<slug>.md` file with YAML frontmatter and a plain-markdown body. A fiber can carry a task, a
decision, a research claim, a question, or a spec. The directory tree gives hierarchy;
`[[wikilinks]]` in bodies give narrative cross-references. Native metadata stays small — `name`,
`status`, `tags`, timestamps, `outcome`, `due`, `description` — and felt preserves any other
top-level YAML key opaquely, so another tool can own its own schema without felt claiming it.

felt computes back-references, reverse data-flow consumers, and body search from the markdown tree
on demand. Your markdown holds everything, so felt adds no authoring burden and diffs like the rest
of your repo. It also gives AI coding agents persistent memory, as much as it gives you one: one
plugin installs into both Claude Code and Codex, and a pi package installs into pi. Both bundle the
**felt** and **shuttle** skills from one shared source tree, and make `.felt/` the thing an agent
reaches for between sessions.

**shuttle** is the orchestrator, and strictly optional. Add a `shuttle:` block to a fiber's
frontmatter and it becomes a *constitution*: a spec of a desired state rather than a list of steps.
An Elixir/OTP daemon polls your felt stores, launches one tmux worker per eligible constitution,
and serves a board at `http://127.0.0.1:4000/` for watching and steering them. Workers stay
attachable, and each rewrites its fiber's `outcome` and `## Status` on exit, so the next worker
lands warm. felt works entirely on its own — record, search, and link with nothing running. Adopt
shuttle when you want work dispatched, not just recorded.

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
