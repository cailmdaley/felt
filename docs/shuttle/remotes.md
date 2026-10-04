# Connect your machines

Each machine that runs workers needs its own Shuttle daemon, agent login, and project files.
The board on one machine can show and control work on the others.
Start with [one working installation](setup.md), then repeat that setup on the remote before connecting them.

Call the machine whose board you open the **hub**.
The hub can be your laptop; a worker on an awake remote keeps running when that laptop disconnects.
A sleeping hub's board is unavailable until it wakes, so use an always-on hub if you want the board available from your phone too.

## Choose a connection

| Connection | A good fit when | What you maintain |
|---|---|---|
| **Tailscale** | You control personal machines and can join them to the same private network. | Tailscale login and Serve on each host; Shuttle discovers eligible peers. |
| **SSH** | You already have SSH access, cannot install Tailscale, or use a shared server. | An SSH destination, a configured remote, and a supervised tunnel on the hub. |

Tailscale carries the board and daemon API without an SSH tunnel.
Opening a remote **terminal** still needs SSH, even when the board reaches that host over Tailscale.
Claude Remote Control and Codex remote access are separate ways to open the agent conversation; see [Opening conversations](conversations.md).

A reachable Shuttle endpoint grants control of agents and files as its owner.
Use a private tailnet with access restricted to you, or a loopback-bound SSH forward.
Do not publish Shuttle with Tailscale Funnel or an unauthenticated public proxy.
On institutional machines, follow the institution's network and authentication policy.

## Prepare the remote

On the remote, verify:

```sh
shuttle host --json
shuttle doctor
shuttle agents
```

The remote needs a distinct host ID, a running daemon, a registered store, and an agent that can start and authenticate there.
Use the ID reported by `shuttle host` as the remote's name in the commands below.
The SSH alias and the Shuttle host ID can be different.

The project's working directory must exist on that machine.
Tasks select it through `shuttle.project_dir`; the daemon doesn't copy code or install dependencies for you.

## Personal machines with Tailscale

Use a standard [Tailscale installation](https://tailscale.com/download) on both machines and sign in as the same Tailscale user.
On each single-user machine whose daemon should be reachable, run:

```sh
tailscale status
tailscale serve --bg 4000
tailscale serve status
```

Approve the HTTPS setup if Tailscale prompts you.
[Serve](https://tailscale.com/docs/features/tailscale-serve) forwards a private tailnet HTTPS address to the local daemon; it does not make the service public.
Use the daemon's actual port if you changed it from 4000.

On the hub, wait up to a minute and check:

```sh
shuttle remotes list
shuttle doctor
```

The remote should appear with source `discovered`, under its Shuttle host ID.
Discovery looks for online nodes owned by the same Tailscale user, at their default HTTPS address, that answer as Shuttle daemons.
Don't assume a tagged device or a device shared by another user will be discovered.

For an address discovery cannot find, configure it explicitly:

```sh
shuttle remotes add workstation --url https://workstation.example.ts.net
```

Replace the name and URL with those of your remote.
To use Kitty to open its terminal as well, include your SSH alias:

```sh
shuttle remotes add workstation \
  --url https://workstation.example.ts.net --ssh work-ssh
```

`remotes add` replaces the configured record for that name.
If you already have extra settings on that record, edit it in **Settings → Fleet** instead of overwriting them.
No `shuttle tunnels install` is needed for a URL-only remote.

To see both directions, Serve must be configured on both hosts and each must discover or configure the other.
A hub reaching a remote doesn't by itself establish a return route.

## Personal machines with SSH

On the hub, install `autossh` with your package manager and verify that `ssh work-ssh` reaches your remote account.
Then configure and start a tunnel:

```sh
shuttle remotes add workstation --ssh work-ssh --port 4001
shuttle tunnels install workstation
shuttle remotes list
shuttle doctor
```

Here `workstation` is the remote's Shuttle host ID, `work-ssh` is your SSH destination, and `4001` is an unused **local** port on the hub.
The remote daemon still uses port 4000.
Give each remote its own local forwarded port.

`remotes add` writes configuration; `tunnels install` installs and starts the tunnel service.
The hub needs launchd on macOS or a systemd user manager on Linux.
On Linux without one, `--write-only` renders units but does not run them; arrange a supervisor before expecting a persistent connection.

A manual diagnostic forward can confirm the underlying SSH route:

```sh
ssh -N -L 127.0.0.1:4001:127.0.0.1:4000 work-ssh
```

Keep that terminal open during the check, and stop the manual forward before installing a service on the same port.

## Shared servers and clusters

Declare a shared server before starting its daemon:

```sh
shuttle host class shared-multi-user
```

The daemon then uses a private Unix socket, normally `~/.shuttle/sock/daemon.sock`, instead of a TCP port other local users could reach.
If the daemon is already running, restart it with its supervisor so the listener changes, then check `shuttle host --json` and `shuttle doctor`.
Review eligible work before releasing the restart hold.

From a single-user hub, forward to that protected socket:

```sh
shuttle remotes add cluster --ssh cluster-ssh --port 4002 \
  --remote-socket /home/you/.shuttle/sock/daemon.sock
shuttle tunnels install cluster
```

Use the remote's actual absolute socket path from `shuttle host --json`.
The local end is still a TCP listener: this recipe assumes your hub is single-user too.

For a host requiring two-factor SSH login, use a human-authenticated shared connection.
In the hub's `~/.ssh/config`, add these options to its existing host entry:

```sshconfig
Host cluster-ssh
    ControlMaster auto
    ControlPath ~/.ssh/ctl/%C
    ControlPersist 8h
```

Then establish the connection yourself before starting the multiplexed tunnel:

```sh
mkdir -p ~/.ssh/ctl
chmod 700 ~/.ssh/ctl
ssh cluster-ssh
# Complete login, then exit the remote shell.
shuttle remotes add cluster --ssh cluster-ssh --port 4002 \
  --remote-socket /home/you/.shuttle/sock/daemon.sock --multiplex
shuttle tunnels install cluster
```

When that authenticated connection expires, log in again.
The tunnel waits for a live connection instead of trying to answer two-factor prompts unattended.

Userspace Tailscale is an advanced alternative only where policy permits it.
Read the [host boundaries](installation.md#host-classes-and-trust-boundaries) and [userspace recipe](installation.md#the-unprivileged-recipe) first: serving a shared host is not the same as forwarding a personal machine's port 4000.

## Verify work across the connection

Open the hub's **Settings → Fleet** and check that the remote answers.
Choose the remote host in Settings to inspect its registered stores and projects.
Use Capture with that host and an existing remote project for a small read-only task, then confirm the card runs there and you can return to its conversation.
For a terminal workflow, test SSH attachment as well as board visibility.

The board reads live content from the owning daemon.
Tailscale and SSH do **not** synchronize your task documents or code.
Use Git and `felt sync` for shared stores; each task's host still determines which daemon may execute it.
Distinct stores on different hosts can also appear together on the board without being merged.

If the remote disappears, check the layers in order: host awake, daemon healthy, Serve or tunnel reachable, then stores and task ownership.
[The installation reference](installation.md#configuring-remotes) covers timeouts, discovery overrides, recovery, and private userspace dialing.
