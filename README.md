<p align="center">
  <img src=".github/banner.jpg" alt="felt" width="600">
</p>

<p align="center">
  <a href="https://github.com/cailmdaley/felt/actions/workflows/ci.yml"><img src="https://github.com/cailmdaley/felt/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

# felt

**[Documentation](https://cailmdaley.github.io/felt/)**

When work spans several days or coding-agent sessions, decisions and unfinished tasks can disappear into chat transcripts.
**felt** keeps them in Markdown files beside your project, with a command-line tool for recording, searching, and connecting them.
You and your agents read and write the same notes; Git keeps their history.

## Set up with your agent

**Shuttle** is the optional task board that launches agents and follows their work.
We recommend asking your existing agent to help you set it up.
Give it this prompt:

```text
Read https://cailmdaley.github.io/felt/shuttle/agent-setup/ and help me set up Shuttle. Record this setup as a task on the board, and give me the board URL when it is ready.
```

The [setup guide](https://cailmdaley.github.io/felt/shuttle/setup/) explains what to expect.
To use felt for notes on its own, follow the commands below.

## Keep project notes

Each note is called a **fiber**.
It can hold a task, a question, a decision, a finding, or a project specification.
A fiber lives in its own directory under `.felt/`, with metadata above its Markdown body:

```markdown
---
name: Choose a workshop venue
status: closed
outcome: "Use the library meeting room: it seats 30 and is near the station."
---

We expect 25 people, and several will arrive by train.
The café is closer, but its back room only seats 18.
```

Related fibers nest in directories and connect through `[[wikilinks]]` in their text.
Plots and reports live beside the note that explains them.
Use any editor, open `.felt/` as an Obsidian vault, or give a coding agent the [felt integration](https://cailmdaley.github.io/felt/agents/).
felt works without a background service.

**shuttle** adds optional agent orchestration: write a task, choose an agent and project directory, and let it run.
A background service launches agents and serves a browser board where you can follow work and review results.
Agents record conclusions and continuation notes in the task's fiber, so unfinished work can span sessions.
Start on one machine, then connect others if you need remote execution.

![Shuttle board showing tasks for a small workshop](docs/assets/shuttle-board-example.png)

This repository ships the `felt` and `shuttle` Go CLIs, plus the optional Shuttle service and board.
[Getting started](https://cailmdaley.github.io/felt/getting-started/) walks through a first note.
[Set up Shuttle](https://cailmdaley.github.io/felt/shuttle/setup/) walks through a first agent task.

## Install

Install the release binaries:

```sh
curl -fsSL https://raw.githubusercontent.com/cailmdaley/felt/main/install.sh | sh
```

Or use Homebrew:

```sh
brew install cailmdaley/tap/felt
```

To build from source with Go:

```sh
go install github.com/cailmdaley/felt/cmd/felt@latest
go install github.com/cailmdaley/felt/cmd/shuttle@latest
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
`PATH`. Follow [Set up Shuttle](https://cailmdaley.github.io/felt/shuttle/setup/) for a first task,
[connect your machines](https://cailmdaley.github.io/felt/shuttle/remotes/) for a multi-machine setup, and
[choose where conversations open](https://cailmdaley.github.io/felt/shuttle/conversations/) for terminal, desktop, or browser use.

## Quickstart

From your project directory:

```sh
felt init
felt add workshop-venue "Choose a workshop venue" -s open
```

Open `.felt/workshop-venue/workshop-venue.md` in your editor and describe the question below its metadata.
When you've answered it, close the task with a conclusion you can use later:

```sh
felt edit workshop-venue -s closed \
  -o "Use the library meeting room: it seats 30 and is near the station."
felt show workshop-venue
felt ls -s all "workshop"
```

Status is optional: use it for unfinished work, and leave it off a note that records an existing decision.
Install your agent's integration with `felt setup claude`, `felt setup codex`, or `felt setup pi`.

## Documentation

The [documentation site](https://cailmdaley.github.io/felt/) covers the next steps:

- [Organize notes and tasks](https://cailmdaley.github.io/felt/concepts/organizing/): nesting, links, statuses, and useful conclusions.
- [Integrate coding agents](https://cailmdaley.github.io/felt/agents/): Claude Code, Codex, and pi.
- [Keep files with notes](https://cailmdaley.github.io/felt/concepts/companions/): plots, PDFs, and reports.
- [Run tasks with Shuttle](https://cailmdaley.github.io/felt/shuttle/): task descriptions, the board, and review.
- [Look up commands](https://cailmdaley.github.io/felt/reference/cli/).

## Contributing

See **[CONTRIBUTING.md](CONTRIBUTING.md)** to get set up, and **[AGENTS.md](AGENTS.md)** for the
architecture, build and lifecycle, deploy path, and invariants. Issues and pull requests are
welcome.

## License

Both Go CLIs and the board UI are under the [MIT License](LICENSE). The shuttle daemon (`daemon/lib/`)
contains code derived from OpenAI's Symphony under the [Apache License 2.0](LICENSE-APACHE),
preserved in [`NOTICE`](NOTICE).
