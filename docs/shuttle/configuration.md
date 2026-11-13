# Configuration reference

Stores, agents, host trust, remotes and the tailnet transport are configured per host.
[Installation](installation.md) gets the daemon running first; [Sharp edges](troubleshooting.md) collects what tends to go wrong.

## Personal UIs

Put a UI in `~/.config/shuttle/ui/<name>/`, with an `index.html` at its root.
The daemon serves it at `/ui/<name>/` and reads its files on each request, so
edits need no restart. The UI shares the daemon's origin and can write through
its API. Its files are served to whoever can reach the daemon; see
[Host classes and trust boundaries](#host-classes-and-trust-boundaries).

## Configuring stores

The daemon polls felt stores. It resolves them in this order:

1. `SHUTTLE_STORES` — a comma-separated list of store paths.
2. `~/.config/shuttle/stores.json` — the persisted registry (override the path with
   `SHUTTLE_STORES_FILE`).

`shuttle daemon install` prepares a default collection when no registry or fixed store list exists.
It reuses the current project's felt store if it finds one; otherwise it creates `~/felt/.felt` and registers `~/felt` before starting the service.
Existing registries—including empty ones—and explicit store lists are preserved.
An explicit `-C` or `--store` selects the store to register; an invalid selection fails rather than creating a different store.
Reinstalling also preserves a fixed store list saved in the supervisor unless a flag or environment override replaces it.
`--print` previews the service without creating notes or registry files.

Starting the daemon directly doesn't create a store: with no variable or registry it serves an empty board and polls nothing.
Use **Settings → Notes & tasks** to add collections, or edit the registry before startup.

### Switching a supervisor to the registry

If a supervisor was installed with `--stores`, its pinned list takes precedence
over the editable registry. To switch, back up the job and `stores.json`, then
write the daemon's **currently effective** store list into the registry. Do
not activate a stale registry list blindly: it may contain additional stores
you did not intend to poll. Reinstall with `shuttle daemon install --stores=` to explicitly clear the saved fixed list and use the registry.
Keep any existing PATH,
socket, label, port, or log overrides when reinstalling. A custom
`SHUTTLE_STORES_FILE` must be present in the installation environment too.

Installation replaces and reloads the supervisor. Check Settings → Notes & tasks:
the source should be the registry, the effective stores should be unchanged,
and editing should be enabled. Verify the board still contains the expected
fibers, then release the restart quarantine with `shuttle daemon release`.

The registry file takes this canonical shape. A bare JSON array also works.

```json
{
  "version": 1,
  "felt_stores": ["/home/you/dev/myproject"]
}
```

`POST /api/v1/felt-stores` rewrites the file, and the board's store picker uses
that endpoint. A store is a directory with a `.felt/` inside it; nothing
validates that when you register one, and nothing needs to — a directory
without one is a store with no fibers, which the poller reads as empty rather
than as an error.

Everything in this section and the two below it is also reachable from the
board's [settings sheet](board.md#settings)
(`⌘,`), for any host in the fleet — which is how you configure a machine you
have no shell on.

## Configuring agents

`shuttle agents` prints the effective registry. It layers your own file
over the shipped default fleet (enumerated in
[Constitutions](constitutions.md#agent-selection)). Set `$SHUTTLE_AGENTS_FILE` to
choose the path; otherwise the shuttle CLI and daemon read
`~/.config/shuttle/agents.json`.

```bash
shuttle agents init      # seed the user file from the built-ins
shuttle agents           # the merged table, with a source footer
shuttle agents --source user
```

Each record names a CLI, a model, and its axis metadata (`effort_levels`,
`default_effort`, `chrome_capable`). `shuttle agents init` seeds the file
from the built-ins, working every field across several harnesses — edit that. A
missing file is silent. A malformed file fails loudly and names the path.

An optional `env` map sets worker process environment variables on the CLI/tmux surface, for both fresh launches and resumes.
Keys must match `[A-Za-z_][A-Za-z0-9_]*`; values must be strings without NUL characters.
Empty strings are allowed, and values are passed literally without shell expansion.
For example, copy the complete `claude-opus` record, change its `id` to `claude-opus-5m`, and add:

```json
"env": { "CLAUDE_CODE_PROMPT_CACHE_TTL": "5m" }
```

Alias records inherit their base agent's environment and can override individual variables with their own `env` map.
Resolved aliases retain their own id, so capture and resume reapply their environment and axis overlays.
Interactive Chronicle resumes explicitly clear `headless` because a human is at the terminal.
This alias overlay does not change the wholesale record replacement rule between registry layers.
If a resume cannot resolve a registry record and falls back to a bare agent, that agent carries no `env` overrides.
Codex workers run through the selected terminal backend using the Codex CLI.

The file's `builtins` key controls the merge. `"merge"` (the default) folds your
records over the built-ins by id, last one wins — wholesale, never field by
field. `"restrict"` drops the built-in layer entirely, so the file becomes the
complete registry for that host.

To change one agent's default effort without copying its whole record, use the
`overrides` block. It applies after the merge, to built-in and user records
alike:

```json
{
  "version": 1,
  "builtins": "merge",
  "agents": [],
  "overrides": { "claude-opus": { "default_effort": "high" } }
}
```

```bash
shuttle agents effort claude-opus high     # write the override
shuttle agents effort claude-opus --reset  # remove it
```

An alias key lands on its base agent; the CLI keys the entry by that base id.
`default_effort` is the only field an override sets. An unknown field, an
unknown agent, or a level outside the agent's `effort_levels` fails the load
and names the file. `shuttle agents` marks an overridden default as
`default=<level>(override)`, and `--json` carries
`"default_effort_source": "override"`. The board's settings sheet sets the same
override from a select on each agent row.
There is no reserved `human` record.

## Host classes and trust boundaries

The daemon's control plane has no authentication: anything that reaches its
listener can read and write every registered fiber, read transcripts, and
launch or kill workers as the user running it. The design makes the
*listener* the boundary, so the boundary has to match the host it runs on.

Every host declares a class in `~/.config/shuttle/host.json`:

```json
{"class": "single-user"}
```

Set it with `shuttle host class <class>`; read it back with `shuttle host
--json` or the board's settings sheet. Three classes exist.
`single-user` is a laptop, a workstation, a single-user VM — loopback is
yours alone. `shared-multi-user` is an HPC login node: loopback is shared
with every logged-in user, `/proc/net/tcp` is world-readable, and any
`127.0.0.1` listener is theirs to connect to. `exposed` is reachable beyond
your tailnet; the daemon serves only on its Unix socket, and the front proxy
must dial that socket.

The class changes where the daemon listens. `single-user` listens on
`tcp://127.0.0.1:4000` (override the port with `SHUTTLE_PORT`).
`shared-multi-user` and `exposed` listen on a Unix socket instead,
`~/.shuttle/sock/daemon.sock`, inside a `0700` directory the daemon creates
and verifies before it binds — it refuses to bind if the directory is missing
that mode. `host.json`'s `listen` key, or `SHUTTLE_LISTEN`, overrides either
default, and the CLI resolves the same address to reach it. A shared host can
use an explicit loopback TCP listener only when `/proc/net/tcp` is readable;
an exposed host refuses every TCP override at boot. A remote entry's
`remote_socket` key points an SSH tunnel's far end at the socket instead of a
port — verified end to end as `ssh -L 127.0.0.1:<port>:~/.shuttle/sock/daemon.sock
<host>` against an OpenSSH 8.0 login node — and the local `felt` CLI on that
host dials the same socket directly. A host whose only inbound is SSH
tunnels can run entirely off the socket, with no TCP listener at all.

An unprivileged userspace `tailscaled` cannot target a Unix socket with
`tailscale serve`; the command refuses with "must be root, or be an operator
and able to run sudo tailscale to serve a path or Unix socket." The macOS
system `tailscaled` cannot reach a filesystem socket and answers 502. A shared host fronted by either arrangement therefore needs a loopback TCP
listener. An exposed host must put a front proxy in front of the daemon; the
proxy connects to the Unix socket, while the published proxy endpoint handles
external traffic. "The board on your phone" and "Tailscale as fleet
transport" describe direct TCP access for classes that permit it.

On a `shared-multi-user` host that uses TCP, `PeerGatePlug` protects the
listener before static assets or request-body parsing. It resolves the
client-side connection row in `/proc/net/tcp` or `/proc/net/tcp6` by
matching the peer address and ephemeral port as the local endpoint and the
daemon's address and port as the remote endpoint. A row counts only when an
owning socket backs it (nonzero inode): a client that has already closed its
socket leaves an orphaned row the kernel prints as uid 0, and the gate reports
that as a closed peer, never as root. A peer is admitted only when the row's
uid is the daemon's effective uid. A foreign uid, a closed peer or an
unresolved row receives HTTP 403 with `error: "peer_refused"`; request headers
cannot bypass the gate. This admits a same-user userspace `tailscaled` and
refuses a co-tenant connecting directly. The `tailscale_login` header is
retained on TCP only after uid admission; the header itself is still an
assertion. `PeerGatePlug` also refuses exposed TCP requests that reach it, but
the daemon refuses to boot an exposed TCP listener.

The gate admits the daemon's effective uid by default. `SHUTTLE_PEER_UID` is
an explicit override; the daemon logs a warning when it is set, and
`GET /api/v1/version` reports the admitted uid and whether it came from the
environment. `shuttle doctor` flags an environment override or a uid that
differs from the CLI user's uid. Leave the variable unset for normal use.

The gate identifies the last local process, not the original client. A relay
running as the daemon's owner can pass a co-tenant's traffic with that owner's
uid. Examples include a userspace Tailscale SOCKS/HTTP proxy, `ssh -D` or
`ssh -L`, socat, and code-server or Jupyter `/proxy/` routes. Operators must
not run relays as themselves. Root has no separate admission exception; it is
denied unless the daemon itself runs as uid 0, and root can already inspect or
control that daemon process.

The TCP uid gate does not cover port squatting on a shared host: the port is a shared resource, and another user can bind it while the daemon is down.
Because that listener runs as the other user, its HTTP response could claim `peer_gate: "uid"` and imitate the daemon.
On Linux, each `shuttle` CLI connection to the local TCP daemon checks the server-side established row in `/proc/net/tcp{,6}` after connecting and refuses a foreign or unverified owner.
The `shuttle daemon` client uses `shuttle host check-owner` on its own connection before sending a TCP request; the ownership check and request are separate connections.
`shuttle doctor` reports the uid from matching LISTEN rows when available.
These checks do not protect a browser request that `tailscale serve` forwards while the daemon is down: Serve does not check the listener owner, and the browser cannot distinguish a squat listener from the daemon.
A Unix socket in the protected `0700` directory has no equivalent TCP-port squatting window: a co-tenant cannot claim the path or connect through it.

`namei -m ~/.shuttle/sock/daemon.sock` shows the Unix socket's permissions
along the whole path. A shared host refuses to boot TCP when
`/proc/net/tcp` is unreadable, as on macOS; an exposed host refuses TCP
regardless. Use the class's Unix socket, or declare `single-user` when
loopback is private to the operator. `shuttle doctor` reports
`peer_gate: uid` when the daemon gates its shared-class TCP listener and
treats an ungated TCP listener as a mismatch.

The same class gates dial-out. The daemon refuses `defaults.https_proxy` on
`shared-multi-user` and `exposed` hosts because
`tailscaled --outbound-http-proxy-listen` is an unauthenticated loopback
gateway into the whole tailnet. A co-tenant who finds it can reach every
tailnet service as your node.

For private HTTPS remotes, set `defaults.tailscale_socket` below. Shuttle uses
tailscaled's LocalAPI to establish verified per-remote bridges without
exposing the loopback proxy. Tunnel *local* ends remain plain TCP loopback and
are flagged, not fixed, on a shared host.

`shuttle doctor` checks this. It reports the declared class, the resolved
listen address, the set of distinct logged-in users, the socket directory's
mode and owner, and every listening TCP socket owned by a fleet process (the
daemon, tunnels, `tailscaled`); it reports `mismatch` with a repair line when
the host contradicts its declared class. Four
checks worth watching turn the receipt red on purpose: declaring
`single-user` on a login node, `chmod 755`-ing the socket directory, setting
`SHUTTLE_LISTEN=tcp` on a shared host, and setting `defaults.https_proxy` on
a shared host.
The receipt also reports the configured Tailscale LocalAPI socket and the
live state of each private remote bridge.

## Configuring remotes

One daemon aggregates the others. On a tailnet it needs no configuration: every
daemon served with `tailscale serve` (see [Tailscale as fleet
transport](#tailscale-as-fleet-transport)) is discovered and named by its host
id. The fleet file lists what discovery cannot find or should not decide: hosts
reached over SSH tunnels, non-default URLs, and overrides. Both the Go CLI and
the daemon read it at runtime.

```bash
shuttle remotes path                          # ~/.config/shuttle/remotes.json
shuttle remotes add hub-a --port 4001         # --ssh, --remote-port, --display, --checkout
shuttle remotes add hub-b --port 4004 --multiplex
shuttle remotes list                          # every peer and its SOURCE; also the validator
shuttle remotes list --configured             # the file alone, without asking the daemon
shuttle remotes rm hub-a
```

`list` reports parse errors, duplicate names, and port collisions, and shows
each remote's source: `configured` for a file entry, `discovered` for a tailnet
peer the local daemon found. When the daemon cannot be reached, it lists the
file alone and says so. `add` and `rm` edit only the file. `--multiplex`
rides an existing `ControlMaster` socket — SSH's connection-sharing feature,
which keeps one authenticated connection open for later commands to reuse —
which is what a 2FA host needs. A `launchd_label_prefix` key in the file names
the launchd labels `shuttle tunnels install` writes. Single-machine use
needs none of this: an absent file on a host off the tailnet means no remotes.

`bin/shuttle-deploy` reads the same file, so the fleet is described once. Give
a remote a `checkout` (its repo path) to make it a deploy target — a remote
without one is skipped. Three more optional keys serve deploy only: `ssh_flags`,
a list of extra ssh arguments; `build_ui`, which is true unless you write
`false` to mark a host that should take the board bundle from the deploy host
rather than build it (see
[Building and deploying](../dev/build-and-deploy.md#the-bundle-on-a-host-that-does-not-build-it));
and `auth`, which the deploy script reads as
`"pubkey"` (the default) or `"interactive"`. Mark a host `"interactive"` when
its ssh needs a live human credential — push-2FA or a short-lived certificate —
and `bin/shuttle-deploy --handshake` will bootstrap a `ControlMaster` for it
instead of failing.

## Tailscale as fleet transport

Tailscale discovery and explicit SSH tunnels are supported fleet transports —
see [Connect your machines](remotes.md) for a first setup.
For a configured Tailscale remote, a remote entry names a Tailscale URL instead
of an SSH port, and the composite board reaches it over the tailnet with no
tunnel process, no `autossh`, and no SSH key or MFA-cert juggling to keep
alive. It earns its place on two hosts a tunnel struggles with: a hub behind a
laptop that closes its lid (connectivity pauses while the laptop sleeps, but its tailnet membership persists), and a cluster login node behind 2FA whose only
"always-on" SSH story today is `--multiplex`'s `ControlMaster` babysitting.
Tailscale avoids maintaining a separate SSH tunnel for API access.
It does not keep a sleeping host awake or replace institution-required authentication.

**Read the policy caveat below before you join a node.**

### The unprivileged recipe

For Linux hosts where policy permits a user-owned Tailscale process, this recipe needs no root or TUN device.
Use a standard system Tailscale installation on a personal desktop when available.
Every host in this advanced recipe runs
`tailscaled` in **userspace-networking** mode, which is what makes it viable
on a login node where you cannot install a kernel module or a system service:

1. Drop the static `tailscale` and `tailscaled` binaries into `~/.local/bin`
   (Tailscale ships them as a plain tarball; no package manager or root
   needed).
2. Keep `tailscaled` alive under tmux with `bin/tailscaled-launch`
   (`scripts/bootstrap.sh` installs it to `~/.local/bin` next to
   `shuttle-launch`, whether or not you use it).
   Fetched releases do not include this helper: obtain `bin/tailscaled-launch` from the matching source tag and install it explicitly, or arrange your own supervisor.
   It starts `tailscaled
   --tun=userspace-networking` against a per-host state directory and
   respawns it if it dies, the same role `shuttle-launch` plays for the
   daemon.
3. Export `TS_SOCKET` so the `tailscale` CLI talks to *this* userspace
   instance rather than a system one:
   ```bash
   export TS_SOCKET=$HOME/.local/state/tailscale/tailscaled.sock
   tailscale up          # one-time device auth
   # Only when this host has a permitted TCP daemon listener on port 4000:
   tailscale serve --bg 4000
   ```
   `tailscale up` prints a login URL the first time; approve it from any
   already-authenticated device or browser. `serve --bg` is what actually
   exposes the daemon when a TCP listener is configured.
   A shared host defaults to a Unix socket, so stop here and choose the [shared-host route](remotes.md#shared-servers-and-clusters) unless you have deliberately configured and assessed a permitted TCP listener: an unprivileged userspace `tailscaled` refuses to serve a
   Unix socket ("must be root, or be an operator and able to run sudo
   tailscale to serve a path or Unix socket"), and the macOS system
   `tailscaled` cannot reach a filesystem socket at all. See [Host classes
   and trust boundaries](#host-classes-and-trust-boundaries) for what that
   means for a `shared-multi-user` host, and the policy caveat before you run
   it.

   `tailscale up` is not optional. A `tailscaled` running under
   `tailscaled-launch` with `up` never approved looks, from the hub's side,
   identical to a healthy node: the process is alive, the socket answers, and
   the daemon's recovery cascade still considers this host joined. But it has
   no tailnet identity and no address, so the hub sees only a remote that
   never comes back — a stale card, not an error. Check with
   `TS_SOCKET=$HOME/.local/state/tailscale/tailscaled.sock tailscale status`
   after joining: it lists this node and its peers when `up` succeeded, and
   refuses or reports "Logged out" when it has not.

### Discovery

A daemon finds the other daemons on its tailnet by itself. Every minute it
reads the tailnet status, from the LocalAPI when a socket is in effect (see
[`defaults.tailscale_socket`](#defaultstailscale_socket), including its default),
and otherwise from the `tailscale` CLI. It keeps the nodes owned by your own
Tailscale user and probes each online one at
`https://<node>.<tailnet>.ts.net/api/v1/version`. A daemon that answers is
added to the fleet under the `host` id it reports, which is the name its
fibers carry in `shuttle.host`. Nodes shared into your tailnet from another
user are never probed. A phone, or any node without a daemon, drops out
because it does not answer. A node that answered once stays for ten minutes
while its probes fail, so a daemon restarting for a deploy shows as stale
rather than disappearing.

A newly joined host is reachable from every other daemon within a minute of
its daemon answering, with no `remotes.json` anywhere. The file still wins
where it speaks:

- an entry with the same name, or the same `https` URL under another name,
  replaces the discovered peer wholesale (give it an `ssh` name for the
  recovery cascade, a longer timeout, or a `checkout` for `bin/shuttle-deploy`);
- an entry with `"enabled": false` keeps a discovered host out of the fleet;
- `"defaults": {"discover": false}` turns discovery off for this host.

When Tailscale is absent, stopped, or failing, the daemon retains verified peers for up to ten minutes after their last successful probe, alongside configured entries.
After that window it uses `remotes.json` alone.
`/api/v1/version` reports the discovery state (`discovery`), and `shuttle doctor` prints the reason and retained-peer count. A peer whose daemon is too old to report
its host id is not discovered; configure it by hand or upgrade it.

### The remotes.json entry

Discovery covers the ordinary Tailscale-fronted remote. Write an entry when
you need to override one. A Tailscale-fronted remote skips SSH entirely — no
`--ssh`, no port, no `ControlMaster`:

```json
{"name": "hub-a", "url": "https://hub-a.example.ts.net", "tunnel": {"manager": "none"}}
```

`tunnel: {"manager": "none"}` is what tells the daemon there is no local
tunnel process to manage or revive for this remote; it dials `url` directly.

The general rule, not specific to Tailscale: a remote with no `port` has no
tunnel for the hub to supervise, full stop. `manager: none` is the default for
such an entry — you may omit it, as the entries above do implicitly, and
`shuttle remotes add --url` writes it for you. What is an error is naming
an actual supervisor (`launchd`, `systemd`, `autossh`) on a portless entry:
there is no local port for that supervisor to forward to, so `shuttle
tunnels install` rejects it rather than writing a job that starts and
immediately has nothing to do.

### `defaults.tailscale_socket`

A hub whose `tailscaled` runs in userspace-networking mode can dial private
`https://` remotes through its LocalAPI Unix socket instead of exposing the
unauthenticated loopback HTTP proxy.
Set `defaults.tailscale_socket` to the socket path used by that `tailscaled`
instance; the Shuttle daemon's account must be allowed to connect to it.
For example, a per-user userspace instance might use:

```json
{
  "defaults": {"tailscale_socket": "/path/to/tailscaled.sock"},
  "remotes": [
    {"name": "hub-a", "url": "https://hub-a.example.ts.net"}
  ]
}
```

The daemon reads the tailnet status for discovery through the same socket
and dials each probe through it. It creates one owner-only client socket per
enabled HTTPS remote, discovered or configured, immediately under `$SHUTTLE_DATA_DIR/sock/`, named `dial-<component>.sock`. On
shared/exposed hosts using the default Unix listener, bridge sockets sit beside
`daemon.sock` and share its `0700` owner-only directory guard. Each bridge
carries local HTTP over its socket, then performs verified TLS to the configured
hostname through tailscaled's LocalAPI dial endpoint.
The `/api/v1/version` response reports whether the transport is configured and
which bridges are ready; `shuttle doctor` shows the same live state and
flags missing or unhealthy bridges. `ready` means the private listener is
bound with no recorded dial/relay failure; upstream reachability is observed on
actual requests, not a synthetic probe. Once configured, HTTPS requests fail
closed without a matching bridge instead of falling back to direct or proxy
routing.
`shuttle remotes list` validates the socket path.

When `defaults.tailscale_socket` is unset and no `defaults.https_proxy` is
set, the daemon uses `bin/tailscaled-launch`'s socket,
`$HOME/.local/state/tailscale/tailscaled.sock`, on Linux only and only if it is
trustworthy. Every component below `$HOME` must be a real directory (no
symlinks) owned by your uid or root and not writable by group or others, and
the socket itself must be a Unix socket owned by your uid. Otherwise a
co-tenant could plant a fake LocalAPI there. On macOS the default is never
used: its ACLs do not show in mode bits, and a Mac runs the system
`tailscaled`, which discovery reaches through the CLI. A socket that fails the check is not used: the daemon
falls back to the `tailscale` CLI, `/api/v1/version` reports the reason as
`tailnet_dial.default_socket_refused`, and `shuttle remotes list` and
`shuttle doctor` report it too. `shuttle doctor` treats it as a mismatch.
A host running the recipe above therefore needs no `remotes.json` for either
discovery or private dialing. An explicit path always wins. Set
`"tailscale_socket": "system"` to use the system `tailscaled` (its CLI and
kernel route) even when that file exists. `shuttle remotes list` and
`shuttle doctor` print the effective socket with its source (`configured` or
`default`), and `/api/v1/version` reports it as `tailnet_dial.socket` and
`tailnet_dial.socket_source`.
`shuttle doctor` checks that it is a Unix socket and, on shared/exposed hosts,
that ownership, mode bits, and macOS ACLs prevent co-tenants from
traversing to it; it also compares the running daemon's effective socket with
the fleet file.
`defaults.tailscale_socket` and `defaults.https_proxy` are mutually exclusive.
The daemon doesn't read `$TS_SOCKET` or `$HTTPS_PROXY`; configure the fleet file
so its validator and supervised daemon agree.

### `defaults.https_proxy`

A hub whose *own* `tailscaled` also runs in userspace-networking mode has no
kernel route into the tailnet at all — the only way out to another node's
`ts.net` address is through that `tailscaled`'s local HTTP proxy
(`--outbound-http-proxy-listen`). That listener is **off by default** — see
"The proxy is a gateway" below — so a hub turns it on explicitly:

```bash
printf 'localhost:1055\n' > ~/.local/state/tailscale/http-proxy-listen
tailscaled-launch --restart
```

Then point the fleet file at the same address with a document-level default,
which the daemon feeds to `:httpc` for every remote request:

```json
{
  "defaults": {"https_proxy": "http://localhost:1055"},
  "remotes": [
    {"name": "hub-a", "url": "https://hub-a.example.ts.net", "tunnel": {"manager": "none"}}
  ]
}
```

A hub with a real TUN-mode Tailscale install (a desktop or laptop running the
official app, with a kernel route into the tailnet) needs none of this — drop
`defaults.https_proxy` and the daemon dials `ts.net` addresses directly.
`$HTTPS_PROXY` is deliberately **not** read for this: a supervised daemon's
environment is invisible to the person operating it, and `shuttle
remotes list` validates `remotes.json`, not the daemon's environment, so the
fleet file has to be the single source of truth.

The two values are independent settings in independent files and nothing
checks that they agree. A mismatch looks like every remote going stale at once
with no other symptom, so check both when that happens.

TLS is verified normally, against the system CA store — `ts.net` certificates
are publicly trusted (Let's Encrypt, via Tailscale's HTTPS certificate
feature), so there is no `verify_none` or pinned-cert escape hatch anywhere in
this path.

### The proxy is a gateway

`--outbound-http-proxy-listen` is an **unauthenticated** route into the whole
tailnet, and `tailscaled` offers no authentication option for it. See [Host
classes and trust boundaries](#host-classes-and-trust-boundaries): the daemon
refuses `defaults.https_proxy` on any host declared `shared-multi-user` or
`exposed`, because the proxy binds to `127.0.0.1`, which is a real boundary on
a laptop and none at all on a shared login node — every user logged into that
node shares its loopback, so any of them can run

```bash
curl -x http://127.0.0.1:1055 https://<any-node>.<tailnet>.ts.net/api/v1/state
```

and reach every daemon in your tailnet, including the control API that
launches and kills workers. An HPC login node routinely has a dozen other
people on it.

Only a hub needs the proxy: a node that merely runs `tailscale serve` to
expose its own daemon needs no outbound route at all, so a proxy there is pure
exposure for no function. `bin/tailscaled-launch` ships with both listeners
off. A single-user hub that composites the fleet can enable the HTTP proxy; a
shared/exposed hub can leave it off and set `defaults.tailscale_socket` for
private HTTPS remotes (see [Configuring remotes](#configuring-remotes)).
(`socks5-listen` is the same switch for `--socks5-server`; nothing in felt or
shuttle uses it.)

### Policy caveat

Joining a tailnet from a shared or institutional host is not a decision to
make unilaterally. Some facilities' acceptable-use policies explicitly forbid
"alternative access mechanisms" for compute nodes, and some have named and
banned structurally similar overlay-networking tools outright. Check the
facility's AUP before running `tailscale up` on one of its nodes, and — even
where joining is allowed — never run `tailscale serve` on a node whose policy
forbids exposing services from it. Joining a tailnet and serving a port from
it are different acts; a policy can permit one and forbid the other.

None of this is an SSH-login or 2FA bypass. Getting a shell on the node still
goes through the facility's normal login path, 2FA included — Tailscale plays
no part in that. What it changes is what happens *after* you're on the node:
`tailscaled` makes one outbound WireGuard connection to Tailscale's
coordination service, and `tailscale serve` exposes exactly one port (the
shuttle daemon's `:4000`) to a tailnet you control, typically a single-user
one. It does not open an inbound port on the facility's network, and it does
not touch the login path at all.

## The board on your phone (Tailscale)

The daemon binds `:4000` to `127.0.0.1` and never needs to change. To reach the
board from another device, front it with Tailscale Serve on the host running
the daemon:

```bash
brew install --cask tailscale        # macOS; log in from the menu-bar app
tailscale serve --bg 4000            # https://<host>.<tailnet>.ts.net → 127.0.0.1:4000
tailscale serve status
```

The first `serve` prints a one-time link to enable Serve on the tailnet;
approve it in the browser and the command completes. Any device signed into
the same tailnet (the Tailscale iOS app, say) opens the URL directly; the URL
is tailnet-only, TLS is Tailscale's. Tailnet membership therefore grants access
to the daemon's full trusted-user surface, not a read-only dashboard. The board
composites the whole fleet from that daemon's `remotes.json`, so which host
fronts it is a question of uptime, not reach — a laptop asleep is a board
offline.

For another reverse proxy, preserve the browser-facing host and scheme in
`X-Forwarded-Host` and `X-Forwarded-Proto`, replacing any client-supplied values.
The daemon accepts direct requests only under loopback hostnames and rejects
browser writes from unrelated origins. These checks protect the local browser
boundary; they do not authenticate clients or replace access controls on the proxy.
