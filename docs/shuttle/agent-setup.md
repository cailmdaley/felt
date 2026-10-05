# Agent setup guide

This is the checklist behind [Set up Shuttle](setup.md).
It is written for the agent doing the work and the person following along.
The result is a working board with a **Set up Shuttle** task that records this setup, plus a clear account of what was verified.

Start on one machine.
Reuse existing configuration, explain the choices that affect the user, and add remote machines only when requested.
An agent that is already helping should attach its own conversation when supported; do not launch a second agent just to represent the setup.

## Before making changes

Inspect the operating system, current project directory, installed tools, and existing configuration.
Use these commands when the tools are present; `shuttle host --json` can seed the host identity on first use:

```sh
command -v felt shuttle tmux claude codex pi
felt --version
shuttle host --json
shuttle doctor
felt setup receipt --json
```

Missing tools are expected on a fresh machine.
Read existing Shuttle configuration before editing it; preserve custom ports, service options, stores, and remotes.
Never print authentication files or tokens.

Explain what setup will do: install the tools and a per-user background service, prepare a notes folder if needed, and record this task on the board.
The user must complete any agent login, operating-system permission, or institutional authentication prompt themselves.
Ask whether other people have accounts on this machine if that isn't established; a shared server needs a different listener from a personal laptop.

## Install the tools

Use the prebuilt release unless the user is developing Shuttle.
This guide targets **2.0.0-rc.1**; explain that it is a release candidate before installing it.
Keep the explicit version pin: the latest stable release does not provide this setup flow.
Install `tmux` with the machine's package manager, and confirm that the chosen agent is installed and signed in.
Then install felt, Shuttle, and the daemon:

```sh
curl -fsSL https://raw.githubusercontent.com/cailmdaley/felt/main/install.sh \
  | FELT_VERSION=2.0.0-rc.1 SHUTTLE_DAEMON=1 sh
felt --version
shuttle --help
tmux -V
```

`SHUTTLE_DAEMON=1` belongs after the pipe.
The installer prints the binary directory; add it to `PATH` if necessary.
The prebuilt daemon includes its runtime and board, so the user doesn't need Go, Elixir, or Node.
For a source checkout, use [Build from a checkout](installation.md#build-from-a-checkout).

The installer also registers felt's integration for agent CLIs it finds.
If the current agent was installed afterward, run the matching command:

```sh
felt setup claude
# Or: felt setup codex
# Or: felt setup pi
```

Check the installed command help before using the steps below.
Run `shuttle claim --help` before attempting adoption.
If the installed release lacks that command or default-store setup, explain that this guided flow requires the newer source build and follow [Build from a checkout](installation.md#build-from-a-checkout), or use the installed version's documented manual route.
Don't claim the newer behavior is available or silently switch execution surfaces.

## Prepare the service and notes

The commands below show a fresh personal laptop or workstation.
For an existing supervised daemon, preserve its installed label, port, PATH, log paths, socket settings, and fixed store list in the install arguments and environment.
Inspect the installed service first; a bare reinstall does not automatically recover every custom option.
If it is already healthy and correctly configured, leave it running.

For a fresh personal machine:

```sh
shuttle host seed
shuttle host class single-user
shuttle daemon install
shuttle doctor
```

When there is no store configuration, the service installer reuses a felt store in the current project if one exists; otherwise it creates and registers `~/felt/.felt`.
Existing store configuration takes precedence, including an intentionally empty registry.
`shuttle daemon install --print` previews the service without creating this folder or installing anything.
Read the effective registered paths and use one for the setup task.
If an existing registry is empty, add the selected collection through **Settings → Notes & tasks** or the [store registry](installation.md#configuring-stores), preserving the rest of the configuration.
If a fixed environment list controls the service, update that list deliberately rather than writing an ignored registry.
Keep the default for a first setup unless the user already has a store or wants a different location.
A working project and the folder holding its notes can be different directories.

For a shared server or cluster, use `shared-multi-user` and follow [the shared-host route](remotes.md#shared-servers-and-clusters).
Its listener is a private Unix socket; don't assume the laptop's localhost URL applies.

On macOS, a terminal worker needs a terminal-owned tmux server.
If none exists, have the user run this from a terminal opened normally from the Dock or Finder:

```sh
tmux new-session -d -s shuttle-anchor
```

Don't replace or kill an existing tmux server that holds work.
Keep project and notes folders outside Documents, Desktop, and Downloads so the background service can read them.
[Kitty setup](conversations.md#kitty) covers opening terminal workers from the board.

On Linux, confirm the supervisor survives logout.
The installer prints the systemd lingering command where applicable; follow the machine's policy.
Without a systemd user session, use the [tmux supervisor](installation.md#linux-without-systemd-tmux-respawn-loop).

## Put this setup on the board

Use the selected notes collection throughout the following steps; `~/felt` is the fresh-install default, not a reason to replace an existing store.
Search for a setup task before creating one so that retrying onboarding doesn't leave duplicate cards.
Inspect its runtime before reusing it: don't reinstall or claim a task owned by another live worker.
Continue your own existing setup task, or record this separate setup under a distinct slug when another conversation is still responsible for the earlier one.
Create a fiber named **Set up Shuttle** with status `open`:

```sh
felt -C "$STORE" add setup-shuttle "Set up Shuttle" -s open
```

Here `STORE` is the selected store root established above.
Its body should say:

```markdown
Set up Shuttle on this machine and leave a working board with this setup task visible.

## Desired State

- The service reads the selected notes collection.
- The board displays this task and its actual connection to the setup conversation.
- The user knows how to open conversations and where notes are stored.
- The outcome records passed checks and anything still requiring attention.

## Status

Record the current machine, store, project, completed checks, and next step here.
```

Use the current project directory for the worker; don't substitute the notes folder merely because it holds the fiber.
Select an agent from `shuttle agents` that matches the current harness and choose its actual execution surface.
Install the task **as a draft**, then claim the current session, then activate it—in that order.
The installed Shuttle skill's [capture reference](https://github.com/cailmdaley/felt/blob/main/claude-plugin/skills/shuttle/references/capture.md) explains why: activating before a successful claim can launch a duplicate worker.

For example, after creating the task in the selected store:

```sh
shuttle -C "$STORE" install setup-shuttle --disabled \
  --project-dir "$PROJECT" --model "$AGENT" --surface "$SURFACE"
shuttle -C "$STORE" claim setup-shuttle --surface "$SURFACE"
# Only after claim succeeds:
shuttle -C "$STORE" resume setup-shuttle
```

Here `STORE` is the selected store root, `PROJECT` is the current working project, `AGENT` is its installed agent ID, and `SURFACE` is `cli` or `app` for this conversation.
Set these from the inspected environment before running the commands.
The claim command can identify the current tmux session, or a Codex app conversation with `CODEX_THREAD_ID`.
When native identity is available through the harness rather than the environment, pass its exact ID with `--session`; an existing terminal session can be specified with `--tmux-session`.
Claim does not activate or launch anything itself.
Stop this sequence on any failed command, leaving the fiber as a draft if the claim fails.

A claim must identify the current native conversation or tmux session exactly.
Never guess an ID, reuse another worker's conversation, or create a replacement App Server to make a claim succeed.
If this conversation can't be attached, keep the task as a draft, explain that limitation in its outcome, and continue setup from here.
The board can still show useful progress without a connected worker.

## Give the user the board link

On a single-user machine with the default port, verify and return <http://127.0.0.1:4000/>.
For a remote machine, return the URL reachable from the user's browser through the configured route.
Explain that localhost refers to the browser's machine, not automatically the remote host.

Check that **Set up Shuttle** appears in the board's task feed, that the selected store is present, and that the card's state matches the actual claim result.
Open the board visually when a browser tool is available; distinguish an API check from visual verification.
Don't call setup complete solely because a process is listening.

Help the user choose the Aloft default in Settings.
[Opening conversations](conversations.md) describes which harnesses support terminal, desktop, and browser opening.
Claude Remote Control, Kitty's control socket, and Codex remote access are separate features; don't tell users to enable all of them indiscriminately.
A choice in browser settings changes how a conversation opens, not where the worker runs.

## Verify a worker

Attaching the current setup conversation checks adoption; it doesn't prove Shuttle can launch a fresh worker.
When the user wants agent execution, prepare a small read-only task in their project, such as describing its contents without changing files.
Choose an installed agent explicitly and use `--surface cli` for a terminal Codex test; Codex app workers require the [desktop backend setup](codex-desktop.md).

Install the test as a draft before activating it.
Inspect all eligible tasks before running `shuttle daemon release`: release applies to the whole host after a deliberate restart.
Verify that the task starts in the correct directory, receives a message, and reaches **Awaiting review** with a useful result.
For a terminal worker, test `shuttle attach <fiber>` and detach with `Ctrl-b`, then `d`.
Test Aloft separately; a successful worker launch doesn't establish that the preferred opener works.
If the user only wants the board, don't launch a worker as an unnecessary test.

## Finish with a useful record

Update the setup fiber's outcome and body with what actually passed, the notes location, the board URL, and any remaining login or device checks.
Keep machine-specific paths in that fiber, not in public documentation.
Leave rollback instructions for services or app overrides you added.
When an attached setup worker is finished, close the task through the Shuttle lifecycle so it appears in **Awaiting review**.
If anything remains unverified, say what and why.

Add [remote machines](remotes.md) only after the first machine works.
For desktop integration, verify the same live conversation and native tools; a thread file or successful API call alone doesn't establish that the app can continue it.
