# Set up Shuttle

Shuttle gives your coding agents a shared board and keeps their work attached to written tasks.
Start with one machine, run a small task, then connect another machine if you need it.
You can use macOS or Linux; Windows isn't supported.

If you'd like your coding agent to guide the setup, install the [felt integration](../agents.md) and ask it to use the Shuttle skill's **setup** reference.
The agent can inspect your machine, explain the choices, and check each step with you.
This page is the same route for doing it yourself.

## Choose where work runs

Start on the machine where your agent already works: the CLI is installed, you're signed in, and it can read your project.
For a first setup, use a terminal worker with Claude Code or Codex.
A Codex worker that runs in the desktop app has an additional [backend setup](codex-desktop.md).

A terminal worker runs inside **tmux**, which keeps a terminal session alive when you disconnect.
Closing a terminal window or an SSH connection doesn't end that worker.
The machine still has to stay awake and running: tmux cannot keep a sleeping laptop computing.
To close your laptop while work continues, run the worker on an awake remote machine.

Shuttle has two separate choices:

- **Execution:** the machine and harness that run the agent, with a terminal or Codex app conversation as its execution surface.
- **Opening a conversation:** the terminal, desktop app, or browser you use to return to that worker.

[Opening conversations](conversations.md) explains the supported combinations, Kitty, and Remote Control.
You can get your first terminal worker running before configuring a board button to open it.

## Install on the first machine

Install `tmux` with your package manager (`brew install tmux` on macOS), and confirm that your chosen agent starts and is signed in.
Then install felt, Shuttle, and the prebuilt daemon:

```sh
curl -fsSL https://raw.githubusercontent.com/cailmdaley/felt/main/install.sh \
  | SHUTTLE_DAEMON=1 sh
felt --version
shuttle --help
tmux -V
```

The environment variable belongs after the pipe.
The installer prints where it put the binaries; add that directory to `PATH` if your shell cannot find them.
It also installs felt's integration for Claude Code or Codex when it finds that CLI.
If you installed the agent afterward, run `felt setup claude` or `felt setup codex`.

The prebuilt daemon includes its runtime and board, so you don't need Go, Elixir, or Node.
Use the [source installation](installation.md#build-from-a-checkout) if you want to develop Shuttle.
For a specific release, use the [version-pinning instructions](installation.md#pin-a-release).

## Register your work

A **store** is a directory containing `.felt/`, where the task documents live.
Use an existing store if you have one.
Otherwise, create one in your project:

```sh
cd ~/dev/my-project
felt init
```

Replace `~/dev/my-project` with your actual project directory.
On macOS, keep the project and store outside Documents, Desktop, and Downloads so the background service can read them.

Keep that directory path handy: you'll add it in **Settings → Stores** once the board is running.
**Settings → Projects** separately controls which working directories appear in Capture and Stash.
For a machine without browser access, the [stores registry](installation.md#configuring-stores) provides the same configuration as a JSON file.

A single [cross-project store](../concepts/cross-project.md) can hold tasks for several projects; you don't need to reorganize your notes to try Shuttle.

## Start the background service

Declare whether other people have accounts on this machine before starting the daemon:

```sh
shuttle host seed
shuttle host class single-user
shuttle daemon install
shuttle doctor
```

Use `single-user` for your own laptop or workstation.
For a shared server or cluster, use `shared-multi-user` instead and follow [the shared-host route](remotes.md#shared-servers-and-clusters); its listener is a private Unix socket, so the localhost browser URL below doesn't apply there.

On macOS, the installer starts a login service.
For terminal workers, open your terminal normally (from the Dock or Finder) and run this once if you have no tmux server:

```sh
tmux new-session -d -s shuttle-anchor
```

This gives terminal workers a terminal-owned tmux server with usable macOS privacy permissions.
See [Kitty setup](conversations.md#kitty) for automatic startup and opening workers from the board.
Don't replace or kill an existing tmux server that holds work.

On Linux with a systemd user service, the installer prints the command for enabling **lingering**, which keeps the service alive after your last logout.
Follow your machine's policy before enabling it.
On Linux without a systemd user session, use the [tmux supervisor](installation.md#linux-without-systemd-tmux-respawn-loop) instead.

On your single-user machine, open <http://127.0.0.1:4000/>.
In **Settings → Stores**, add the project directory containing `.felt/`, preserving any entries already there.
`shuttle doctor` checks the daemon and CLI contract; Settings shows the effective store list.
The board may be empty until you add a task.

## Run one small task

From your registered project directory, create a task document, called a **fiber**:

```sh
felt add first-task "Describe this project" -s open
```

Open `.felt/first-task/first-task.md` and add this below its frontmatter:

```markdown
Describe the project so I can check that Shuttle is running in the right directory.

## Desired State

- The outcome names the project and its main entry point.
- No project files are changed.
```

Choose an installed agent from `shuttle agents`.
For Claude Code, install the task as a draft, then arm it:

```sh
shuttle install first-task --disabled --project-dir "$PWD" \
  --model claude-opus --surface cli
shuttle resume first-task
shuttle daemon release
```

For Codex in a terminal, replace `claude-opus` with a Codex agent listed by `shuttle agents`, keeping `--surface cli`.
Codex otherwise defaults to the app surface, which needs a working App Server connection.

Every deliberate daemon restart holds fresh dispatches until `shuttle daemon release`.
Release applies to all eligible tasks on that host, so inspect existing tasks before releasing a host that already has work.

Within a polling cycle, the card should show a worker **In flight**.
Check it and join from any terminal:

```sh
shuttle ps
shuttle attach first-task
```

Press `Ctrl-b`, then `d` to detach from tmux without ending the worker.
When the worker closes the task, its card moves to **Awaiting review**.
A worker that hands off keeps the task active so another worker can continue it.

## Add the parts you need

- [Opening conversations](conversations.md): configure Kitty, use a quick-access terminal, and return through desktop apps or Remote Control.
- [Connect your machines](remotes.md): add an awake remote over Tailscale or SSH and verify the path in both directions when needed.
- [Codex desktop setup](codex-desktop.md): share the native desktop backend with Shuttle.
- [Installation reference](installation.md): service management, configuration files, host classes, and recovery.

If a card doesn't start, read its reason and run `shuttle doctor` before reinstalling anything.
Common first-run causes are a held daemon, an unregistered store, a missing agent login, or an unavailable tmux server.
