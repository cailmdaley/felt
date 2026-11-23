# Setup & Tutorial

**We recommend having your coding agent guide you through setup and the interactive tutorial.**
Give Claude Code, Codex, Antigravity, or Pi either prompt below, or follow the manual felt quickstart further down if you want notes only.

## 1. Install and set up with your agent

Copy this prompt to install `felt` and `shuttle`, start the optional background service, prepare a notes collection, and put a **Set up Shuttle** card on your board:

```{.text .agent-prompt}
Read https://cailmdaley.github.io/felt/shuttle/agent-setup/ and help me install felt and set up Shuttle on this machine. Use existing configuration where possible, explain the choices I need to make, and record this setup as a task on the board. Give me the board URL when it is ready.
```

Your agent doesn't need the felt plugin beforehand — installing the integration is part of setup.
The [agent setup checklist](shuttle/agent-setup.md) is written for humans to read alongside the agent; it explains every file created and how each check is verified.

## 2. Take the interactive tutorial

Once felt (or Shuttle) is installed — or to try things out first — give your agent this prompt:

```{.text .agent-prompt}
Read https://cailmdaley.github.io/felt/tutorial/ and walk me through an interactive, hands-on tutorial of felt and Shuttle. Ask what I want to learn first, use a disposable scratch folder, and use the cheapest available model for any demo threads.
```

The tutor checks what is installed, works inside a disposable scratch folder, always picks the cheapest available model at low effort, asks before changing any host configuration, and runs real commands one small step at a time.

| # | Module | You will | Needs |
|---|---|---|---|
| 1 | felt, your Git-backed wiki | write, link, search, and close workshop notes | `felt` |
| 2 | Ambient mode | let an everyday agent session adopt itself into a thread | daemon, tmux or Rex |
| 3 | Running and steering a thread | write a goal, launch an agent, message it, and review the result | daemon, a signed-in agent |
| 4 | Trees of threads | give a parent two child threads and review what they return | Module 3's setup |
| 5 | Messages, files, and tapestries | follow the work entirely from a terminal | Module 3's setup |
| 6 | Multi-machine fleets | see which machine owns which work | daemon; second machine optional |
| 7 | The default UI, and your own | tour the board, then build a small personal UI with no build step | daemon, a browser |

Read or follow the full exercises yourself on the [Interactive tutorial](tutorial.md) page.

## Install felt yourself (notes only)

To use **felt on its own** with no background service, install the prebuilt release on macOS or Linux (x86_64 and arm64; no Windows build):

```sh
curl -fsSL https://raw.githubusercontent.com/cailmdaley/felt/main/install.sh | sh
```

Or with Homebrew:

```sh
brew install cailmdaley/tap/felt
```

The installer places both `felt` and `shuttle` in `/usr/local/bin` (if writable) or `~/.local/bin`, and registers felt's integration for supported agent CLIs it finds on `PATH`.
Add `SHUTTLE_DAEMON=1` after the pipe (`... | SHUTTLE_DAEMON=1 sh`) to include the prebuilt Shuttle daemon, or see the [installation reference](shuttle/installation.md) for source builds.
Upgrade later with `felt update` and reverse agent integration with `felt uninstall`.

### Create a store and record a decision

From your project directory:

```sh
felt init
felt add workshop-venue "Choose a workshop venue" -s open
```

This creates `.felt/workshop-venue/workshop-venue.md`.
Open it in your editor and write your constraints below the YAML header.
Once you've decided, close it with a standalone outcome and search for it later:

```sh
felt edit workshop-venue -s closed \
  -o "Use the library meeting room: it seats 30 and is near the station."
felt show workshop-venue
felt ls -s all "workshop"
```

`felt ls` shows open and active tasks; `-s all` includes closed decisions.
Status is optional — leave `-s` off for reference notes or decisions already made.
If you installed your agent CLI after felt, register its integration with:

```sh
felt setup claude
# Or: felt setup codex | felt setup pi
```

## Read the in-depth documentation

| Topic | Start here |
|---|---|
| Organizing notes, nesting, links, and file format | [Fibers](concepts/fibers.md), [Organizing](concepts/organizing.md), [Frontmatter](concepts/frontmatter.md) |
| Plots, PDFs, roles, diffs, and shared stores | [Companions](concepts/companions.md), [Roles](concepts/roles.md), [Changes](concepts/changes.md), [Cross-project stores](concepts/cross-project.md) |
| Agent plugins, skills, and hooks | [Agents & Plugin](agents.md) |
| Writing tasks and following workers | [Constitutions](shuttle/constitutions.md), [Lifecycle](shuttle/lifecycle.md), [The board](shuttle/board.md) |
| Terminals, multi-machine fleets, and custom UIs | [Opening conversations](shuttle/conversations.md), [Connect your machines](shuttle/remotes.md), [UI layers & SDK](shuttle/ui-architecture.md) |
| Daemon install, config, and troubleshooting | [Installation](shuttle/installation.md), [Configuration](shuttle/configuration.md), [Sharp edges](shuttle/troubleshooting.md) |
| Complete command and HTTP reference | [CLI reference](reference/cli.md), [Daemon HTTP API](reference/api.md) |
