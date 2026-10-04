# Codex desktop setup

Use this route when you want Shuttle to create and continue conversations in your local Codex desktop app on macOS.
Terminal Codex workers (`--surface cli`) don't need it.
For the general opening choices, see [Opening conversations](conversations.md).

The **App Server** is the Codex process that runs conversations and tools; the desktop app is a client of that process.
Shuttle needs a connection to that same running process to steer the conversation you see in the app.
Sharing transcript files with a second server does not establish that connection.

For a local desktop launch that uses private standard-input/output pipes, `shuttle codex-desktop-bridge` gives Shuttle a private Unix socket into the same server.
It translates the desktop's newline-delimited messages to the server's WebSocket transport while keeping the native executable in the desktop's child process, with its native tools environment.

## When you can skip the bridge

- **Terminal workers:** use Codex normally with `--surface cli`.
- **An existing shared native server:** if the desktop already connects to an App Server through a Unix socket, point Shuttle at that socket and verify the same conversation. Shuttle already speaks the native protocol; it doesn't need a relay in this arrangement.
- **A remote project opened through the app's SSH connection:** if that connection uses an existing shared native App Server socket, configure Shuttle on the execution host to use that exact endpoint, as in step 3, and verify the same conversation as in step 5. No local desktop wrapper is needed for that arrangement. The [remote setup guide](remotes.md) separately connects the Shuttle daemons; it does not establish their Codex backend connection.

Codex documents [stdio and socket transports](https://learn.chatgpt.com/docs/app-server), but its `--listen` option selects one transport; it doesn't add a socket alongside a desktop's existing stdio connection.
The native `app-server proxy` forwards raw socket bytes, rather than translating the desktop's newline-delimited messages, so it is not a replacement wrapper.

Desktop builds may also contain development switches for connecting to an external server.
Treat those as unverified alternatives until you have tested the same live thread and native tools: connecting successfully alone does not establish equivalent desktop behavior.
This guide uses the bridge for the local stdio case, not as a requirement for all Codex integration.

The bridge follows the app's lifetime.
Keep the desktop app open while using these conversations through Shuttle.
Quitting it stops this backend; reopening it supplies a fresh native tools environment.
This explicit integration depends on the installed desktop build, so verify the full conversation after an app update.

## 1. Locate the native executable

Use the Codex executable bundled with the desktop app, rather than a separately installed CLI or another wrapper.
For a build using the packaged CLI layout inside `/Applications/ChatGPT.app`, it is:

```text
/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex
```

Inspect your installed app and adjust that path if it differs; some layouts put the executable directly at `Contents/Resources/codex`.
Run that executable with `--version` to confirm the path before creating the wrapper.
Also check the Shuttle CLI you'll put in the wrapper:

```sh
command -v shuttle
shuttle codex-desktop-bridge --help
shuttle daemon install --help
```

The service installer must provide `--codex-socket`, and its daemon release must include matching supervisor templates.
If your packaged release lacks them, use the [source installation](installation.md#build-from-a-checkout) for this integration or keep using terminal workers.
An agent can help inspect the paths and installed versions before changing anything.

## 2. Create the bridge wrapper

Create `~/.local/bin/codex-shuttle-desktop` with this content, replacing both executable paths with the ones you verified:

```sh
#!/bin/sh
exec "$HOME/.local/bin/shuttle" codex-desktop-bridge \
  --codex /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex \
  --socket "${CODEX_HOME:-$HOME/.codex}/shuttle-desktop/app-server.sock" \
  -- "$@"
```

Make it executable:

```sh
chmod +x ~/.local/bin/codex-shuttle-desktop
```

The dedicated socket avoids the native managed daemon's own control socket.
The wrapper passes the desktop arguments through unchanged; the bridge preserves the native tools environment and keeps the native executable in the desktop child process.

## 3. Point Shuttle at the same socket

For the default Codex home, preview the service configuration:

```sh
shuttle daemon install --print \
  --codex-socket "$HOME/.codex/shuttle-desktop/app-server.sock"
```

If you use a custom `CODEX_HOME`, set it in this shell and use that same home in the wrapper and socket path.
The installer carries `CODEX_HOME` into the service when set.

Preserve your existing service options, including any custom label, port, log path, store list, or SSH agent socket.
Then install with the same options, omitting `--print`:

```sh
shuttle daemon install \
  --codex-socket "$HOME/.codex/shuttle-desktop/app-server.sock"
```

This replaces and restarts the service, which holds fresh task dispatch until you release it.
The endpoint is allowed to be absent at this stage because the desktop app hasn't started the bridge yet.
Subsequent installs preserve the endpoint when you omit the flag; an explicit `SHUTTLE_CODEX_SOCKET` environment value overrides the saved value, and `--codex-socket=` clears it.

For CLI messaging outside the daemon, export the same path in the shell that runs Shuttle:

```sh
export SHUTTLE_CODEX_SOCKET="$HOME/.codex/shuttle-desktop/app-server.sock"
```

That export alone does not configure a supervised service; the installer step does.

## 4. Open the desktop app through the bridge

Arrange this step from an independent terminal or agent session: quitting the app can interrupt the conversation guiding the setup.
After quitting the desktop app, test one launch with the override:

```sh
open -a /Applications/ChatGPT.app \
  --env "CODEX_CLI_PATH=$HOME/.local/bin/codex-shuttle-desktop"
```

Adjust the app path to match step 1.
Test the conversation below before making this launch behavior persistent.

Some desktop builds import a login-shell environment with `CODEX_SHELL=1`.
For a build where you have verified that behavior, a guarded block in `.zshrc` can supply the override:

```sh
if [[ ${CODEX_SHELL:-} == 1 && -z ${CODEX_CLI_PATH:-} ]]; then
  export CODEX_CLI_PATH="$HOME/.local/bin/codex-shuttle-desktop"
fi
```

The guard leaves ordinary shells and explicit launch overrides alone.
Verify a normal quit/reopen without `--env` before treating the setup as persistent.
Don't add the guard on the assumption that every desktop build reads it.

## 5. Verify one conversation

Run `shuttle doctor`, review eligible tasks, and release the restart hold with `shuttle daemon release` when ready.
Create a disposable Codex app task in an existing project through Shuttle.
Open it in the desktop app and continue the exact same thread; check the project assignment after the first persisted input and test a native app tool too.

A successful `thread/start` response, a socket file, or a transcript on disk isn't enough to establish that the app can continue it.
If you want phone access, enable and connect the app's native remote access using the [official remote-connections guide](https://learn.chatgpt.com/docs/remote-connections), then continue this conversation from that device.
Local socket connectivity doesn't prove remote availability.

## Recovery and rollback

Only one bridge can own an endpoint.
An existing endpoint is refused; an unconfirmed backend exit leaves the socket in place to prevent unsafe reuse.
After a crash, inspect the owner lock metadata and native processes before removing a stale socket.
Never remove one still owned by a live server or start a second backend against it.

To roll back:

1. Quit the desktop app from an independent session and remove its installed shell guard, if any.
2. Unset `SHUTTLE_CODEX_SOCKET` in messaging shells and clear the service override with `shuttle daemon install --codex-socket=`, preserving your other service options.
3. Reopen the desktop app normally and verify it works, then remove the wrapper if you no longer need it.

Thread storage and authentication stay in the existing Codex home.
The ordinary private desktop backend is no longer shared with Shuttle after rollback; use a separately configured native endpoint or terminal surface for future Shuttle work.
