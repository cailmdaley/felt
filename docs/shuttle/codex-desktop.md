# Share the Mac Desktop backend

`felt shuttle codex-desktop-bridge` lets the Desktop app and Shuttle use one
native local App Server. Desktop launches the bridge through its
`CODEX_CLI_PATH` executable override. The bridge preserves Desktop's native
arguments and app-tools environment, execs the bundled App Server in the
original desktop-child process, and gives it a private Unix socket. A separate
relay translates Desktop's JSONL connection to that socket's WebSocket protocol.
Keeping native Codex in the original process preserves the signed ancestry
required by native app-tools authorization. Shuttle connects to the same server through
`SHUTTLE_CODEX_SOCKET`.

This is an explicit installation. An ordinary private Desktop stdio server has
no shared endpoint; finding its thread files does not establish live ownership.
The bridge follows Desktop's lifetime. Quitting Desktop closes the backend and
terminates its private process group, including surviving MCP descendants. The
relay stays in that group so its identity cannot be reused during cleanup.
Reopening Desktop supplies the fresh app-tools environment. Shuttle must report the
endpoint unavailable while Desktop is closed.

## Installation

Use the native executable bundled with the installed Desktop app. A wrapper at
`~/.local/bin/codex-shuttle-desktop` can contain:

```sh
#!/bin/sh
exec "$HOME/.local/bin/felt" shuttle codex-desktop-bridge \
  --codex /Applications/ChatGPT.app/Contents/Resources/codex \
  --socket "${CODEX_HOME:-$HOME/.codex}/shuttle-desktop/app-server.sock" \
  -- "$@"
```

Make the wrapper executable. Configure the existing Shuttle service and
messaging shell with the same absolute `SHUTTLE_CODEX_SOCKET` path. The dedicated
socket avoids collision with the native managed daemon's control socket.

A reversible first launch, after quitting Desktop, is:

```sh
open -a /Applications/ChatGPT.app \
  --env "CODEX_CLI_PATH=$HOME/.local/bin/codex-shuttle-desktop"
```

Desktop builds that hydrate an interactive login-shell environment with
`CODEX_SHELL=1` can import the override through a guarded shell startup block.
Verify that behavior in the installed build before adding this to `.zshrc`:

```sh
if [[ ${CODEX_SHELL:-} == 1 && -z ${CODEX_CLI_PATH:-} ]]; then
  export CODEX_CLI_PATH="$HOME/.local/bin/codex-shuttle-desktop"
fi
```

The guard leaves ordinary shells and explicit launch overrides alone. The
bridge resets native Codex's `CODEX_CLI_PATH` to the native executable so nested
launchers use the real runtime. Verify an ordinary quit/reopen without `--env`
before treating the installation as durable.

## Acceptance and recovery

Create a disposable task through Shuttle and verify that Desktop reads and
continues the exact same native thread. Check its project assignment after the
first persisted input. A successful `thread/start` response or a thread file
alone is insufficient. Check native app tools in that task as well.

Phone availability additionally requires the native remote-control connection
to be connected and the task to be visible and continuable on the phone. Local
socket connectivity does not prove phone availability.

Only one bridge can own an endpoint. Existing endpoints are refused, and an
unconfirmed backend exit leaves the socket in place to prevent unsafe reuse.
After a crash, inspect the owner lock metadata and native processes before
removing a stale socket. Never remove an endpoint still owned by a live server.

To roll back, quit Desktop, remove the installed shell guard and Shuttle endpoint
override, then reopen Desktop normally. A per-launch `CODEX_CLI_PATH` pointing
directly at the native executable also bypasses the guarded wrapper. Remove the
wrapper only after Desktop no longer uses it. Thread storage and authentication
remain in the existing Codex home throughout.
