# Rex terminal-backend fixtures

These are empirical CLI captures from Rex Server 0.1.0 build 1541 on macOS, API revision 7.
`rex version` and `server.version` report `0.0.1793131181-gdd9a20`, commit `dd9a201ca13b186bf36ecaedc4aad93b048eb655`, built `2026-10-27T19:59:41Z`, with `dirty: false`.
The enclosing Rex Server bundle's Info.plist reports `CFBundleShortVersionString=0.1.0`, `CFBundleVersion=1541`, and `RexSourceCommit=4b6a53cf94bf83760736dcfe7a5615026b3ef0e8`.
The CLI does not support `--version`; it supports the `version` subcommand.

All JSON fixtures come from an isolated foreground server, not the app's server.
Captures retain observed UUIDs, PIDs, timestamps, numeric user IDs, error text, and the temporary root `/tmp/rexprobe.myyg`.
`<HOME>` replaces the operator's home directory and `<USER>` replaces the operator's account name wherever they occur, including command arguments and response strings.
Those two placeholders are substitutions, not literal values sent to Rex.
No other response normalization is applied to the raw-response files.
Aggregate files contain parsed observations, as identified below.

## Capture setup

The executable and isolated server commands are:

```sh
REX="$HOME/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex"
TMP=/tmp/rexprobe.myyg # actual mktemp -d /tmp/rexprobe.XXXX result
"$REX" server run --listen "unix://$TMP/rex.sock" --state-dir "$TMP/state" --max-sessions 8
```

The server process receives only `HOME`, `PATH`, `SHELL`, `LANG`, `SSH_AUTH_SOCK`, and `TMPDIR` from the caller when present, plus `SHUTTLE_HOST=probe-isolated-sentinel`.
`environment_isolated.json` records that complete launch environment.
This controlled environment excludes harness credentials; it is not the launchd environment of an installed Rex Server.
Every subsequent command targets `-S unix:///tmp/rexprobe.myyg/rex.sock --autostart=false`.
The absent-server tests override `-S` with a missing socket or a bound-but-not-listening Unix socket in the same temporary directory.
The timeout tests send SIGSTOP to the isolated server PID 15112, run with `--timeout 1s`, and send SIGCONT in a `finally` block.
The maximum-session test creates empty sessions until the configured limit of eight is reached, then destroys those sessions.
The isolated server receives SIGTERM after its final `session.list` reports no sessions.

`captures.json` is the command manifest: each entry contains the exact ordered `argv`, `stdin` where applicable, `exit_status`, `stdout`, and `stderr`.
Entries keyed by a fixture filename produce that raw-response fixture directly.
Other entries name supporting calls used by aggregate fixtures.
The manifest is the source for exact commands; the examples below abbreviate the common connection flags as `"$REX" -S "unix://$TMP/rex.sock" --autostart=false`.
The `early_paste_modes` entry additionally includes its capture name.

## Response files and producing commands

| File | Exact command suffix after the common connection flags | Meaning |
|---|---|---|
| `session_create_request.json` | stdin of `api call session.create -` | Complete accepted create request, including all three labels, `shell:none`, `bash -l`, cwd, 160×48, and exit policy. |
| `session_create.json` | `api call session.create -` | Raw create reply; block IDs are nested under `initial_windows[0].block_ids`. |
| `session_list.json` | `api call session.list -` with stdin `{}` | One running worker session. |
| `list_blocks.json` | `api call -s SID session.list_blocks -` with stdin `{}` | One placed worker block. |
| `process_running.json` | `api call -s SID com.superlogical.terminal.process -` with stdin `{"block_id":BID,"args":{}}` | The running child and foreground process are `/usr/bin/login`, not the requested bash script. |
| `process_exited.json` | Same process command on the retained `exit_status_check` block | No child or foreground; `last_exit.exit_code` is 0 even though the requested bash command exits 23. |
| `session_create_duplicate.json` | `api call session.create -` with the same request as the first create | Explicit duplicate labels are accepted. |
| `resolve_duplicate.json` | `api call target.resolve -` with stdin `{"kinds":["session"],"queries":["probe-01JABCDEFGHJKMNPQRSTVWXYZ-shuttle"]}` | Successful call with `status:ambiguous` and two candidates. |
| `resolve_not_found.json` | `api call target.resolve -` with stdin `{"kinds":["session"],"queries":["session:00000000-0000-4000-8000-000000000001"]}` | Successful call with `status:not_found`, not an exit-3 CLI failure. |
| `set_label.json` | `api call -s SID session.set_label -` with stdin `{"label":"probe-renamed-worker"}` | Session rename returns revision 2. |
| `set_block_label.json` | `api call -s SID session.set_block_label -` with stdin `{"block_id":BID,"label":"probe-renamed-block"}` | Block rename returns revision 3. |
| `resolve_native.json` | `api call target.resolve -` with stdin `{"kinds":["block"],"queries":[BID]}` | Immutable block ID resolves after both labels change. |
| `block_event_paste.json` | `api call -s SID block.event -` | Empty-object reply to a multiline paste; exact payload is in the manifest. |
| `paste_modes.json` | `api call -s SID com.superlogical.terminal.modes -` | Full modes response with bracketed paste enabled. |
| `reflow_before.json` | `api call -s SID com.superlogical.terminal.format -` | Text at 160 columns; `args={"format":"text","trim":true,"unwrap":false}`. |
| `resize_unowned.json` | `api call -s SID com.superlogical.terminal.resize -` | Empty-object success for an unowned 80×48 resize; it does not change the actual size. |
| `size_before.json`, `size_unowned.json` | `api call -s SID com.superlogical.terminal.size -` | Both report 160×48. |
| `resize_owned.json` | `do -s SID -e CODE --json` | One connection calls `session.own_block` with `mode:take`, resizes to 80×48, then reads size; exact Lua is in the manifest. |
| `size_after.json` | `api call -s SID com.superlogical.terminal.size -` | Actual size is 80×48 after the owning connection closes. |
| `reflow_after.json`, `reflow_restored.json` | Same format call as `reflow_before.json` | The same 240-character line wraps 80/80/80, then returns to 160/80 after an owned resize to 160. |
| `whoami.json` | `whoami --json` | Isolated endpoint, instance, host, principal, and server identity. |
| `server_version.json` | `api call server.version -` with stdin `{}` | Server version and build identity. |
| `server_status.json` | `api call server.status -` with stdin `{}` | Isolated server configuration and session count at capture start. |
| `final_sessions.json` | `api call session.list -` with stdin `{}` | Empty list before isolated-server shutdown. |

`SID` and `BID` in this table stand for the exact IDs in the corresponding `captures.json` entry, not a shared session across every file.
The ordinary worker script is:

```bash
#!/bin/bash
printf "probe worker running\n"
sleep 600
```

## Aggregate observations

- `errors.json` maps each case to exactly `{argv, exit_status, stdout, stderr}`.
  It includes missing socket, stale socket, post-shutdown absence, session/block misses, JSON-flag variants, a direct RPC session miss, timeout, maximum-session conflict, and the unsupported version flag.
  Both absence forms exit 4; session/block misses exit 3; timeout and conflict exit 1.
  `--json` does not turn errors into JSON: stdout is empty and stderr contains human-readable error text with a trailing newline.
  The timeout text says the connection times out; it is not evidence about an established-connection request timeout.
- `empty_sessions.json` includes each create request and reply, the session list and block list two seconds later, and the process command result.
  Both `sleep 1; exit 17` and immediate `exit 0` with `on_completion:true, quick_exit_threshold_ms:0` leave an existing session with `blocks:[]`.
  With `on_completion:false`, the block remains and exposes `last_exit`.
- `environment_isolated.json` contains the complete isolated-server launch environment and the complete sorted env observations from `shell:none` blocks running `/bin/bash -c 'env | sort > FILE; ...'` and `/bin/bash -l -c 'env | sort > FILE; ...'`.
  The full commands, including paths, are the `isolated_direct_env` and `isolated_bash_login` entries in the manifest.
  The sentinel reaches both blocks; `REX_SESSION` and `REX_BLOCK` are set by Rex.
- `paste_observed.json` contains the supplied paste text and the unbuffered `cat -v` file contents before and after `send-key enter`.
  The receiver runs `stty raw -echo; printf '\033[?2004h'; ...; exec /bin/cat -uv > FILE`; the disabled control uses `\033[?2004l`.
  Enabled mode produces exactly one `^[[200~...^[[201~` pair, with interior LF characters, and a separate final `^M` for Enter.
  Disabled mode produces no wrappers and converts interior LF characters to CR, shown as `^M`.
  Idle controls repeat this without a capture before the first paste, after a 0.4-second readiness delay.
- `paste_readiness.json` records six additional uncaptured trials: three immediately after a ready file appears and three with another 0.4-second delay.
  All six report mode 2004 enabled before paste and receive one wrapped paste.
  An initial startup observation has mode 2004 false and no wrappers even though the program has written its enable sequence; the manifest retains that modes response as `early_paste_modes`.
  A ready file alone does not prove that terminal modes have been applied.
  These observations do not establish a need for a capture before every paste.

The format responses retain `/usr/bin/login`'s `Last login` line.
The reflow probe prints its 240-character line only once, then sleeps; the program contains no resize handler or redraw loop.
The initial running-process response and a separate response both identify `login` as child and foreground.
Two retained blocks running an explicit bash `exit 23` report `last_exit.exit_code:0`; these fixtures pin what Rex reports, not the requested program's true exit code.

## Verification

```sh
for f in daemon/test/fixtures/rex/*.json; do jq . "$f" >/dev/null; done
go test ./internal/feltcli -run Hygiene
```

Real-server environment and tmux-coalition observations belong in the companion backend probe note, not these isolated-server fixtures.
The real server's session list is identical before and after the probes, with no `probe-*` sessions remaining.
The isolated server and both private tmux servers (`probe` and `probe-env`) are stopped.
No app session is selected or raised.
