---
name: verify
description: Run a felt or Shuttle change and look at it before reporting it works — the board in its file:// harness under a headless browser, the daemon as a private scratch release, the felt and shuttle CLIs as built binaries against a scratch store. Use after changing ui/, daemon/, cmd/ or internal/, alongside the tests, and from a worktree without touching the host's daemon.
---

# Verify a change by running it

Tests say the checks still hold; running the change says it does what was
meant ([testing.md](../../../docs/dev/testing.md#what-a-test-is-for)). Each
recipe below works from the main checkout or a linked worktree and leaves the
host's running daemon, its stores and its operator files alone. Times are from
a laptop; a fresh worktree first pays `npm ci` (~15 s) and a cold Mix compile.

## The board

```bash
cd ui && npm run harness:board  # ~18 s; the mocked-daemon bundle in harness-board-dist/
agent-browser --session verify-<fiber> open "file://$PWD/harness-board-dist/index.html?example=channels"
agent-browser --session verify-<fiber> press 3                   # 1 Desk, 2 Chronicle, 3 Channels, 4 Globe
agent-browser --session verify-<fiber> snapshot -i               # refs for what you can click
agent-browser --session verify-<fiber> click @e57 && agent-browser --session verify-<fiber> screenshot /path/in/scratchpad/after.png   # a ref from the snapshot
agent-browser --session verify-<fiber> eval 'JSON.stringify(window.__harness.requests.filter(r => r.method !== "GET").slice(-3))'  # what it wrote to the mocked daemon
agent-browser --session verify-<fiber> --json errors             # uncaught page errors (plain `errors` prints them blank)
agent-browser --session verify-<fiber> set viewport 390 844      # phone width, then screenshot again
agent-browser --session verify-<fiber> close
```

A session name of your own gets a headless Chrome of its own, launched on
first use; repeat it on every call, since shell state does not survive between
tool calls. Then read the screenshot. The query strings that stage a state (`?example=`,
`?transcript=`, `?voice=`, …) are listed at the top of
`ui/harness/harness-board.ts`; add a fixture there when the state you need is
missing. Never open the live board at `:4000`: it takes the human's voice
target and Rex focus. A lane on `bin/shared-browser`
([layout.md](../../../docs/dev/layout.md#browser-checks)) saves memory when
that browser answers.

## The CLIs

```bash
tmp=$(mktemp -d) && go build -o "$tmp/bin/" ./cmd/felt ./cmd/shuttle  # ~1 s warm; never make cli-install, which replaces the host's
mkdir "$tmp/store" && cd "$tmp/store" && git init -q && "$tmp/bin/felt" init
"$tmp/bin/felt" add demo "A fiber" -o "the case your change is about"
"$tmp/bin/shuttle" install demo --disabled && "$tmp/bin/shuttle" channel demo cmbx --local
cat .felt/demo/demo.md
```

Run the verb your change touches from the built binary and read the file it
wrote. Stamped hosts are this host's, so keep constitutions `--disabled` and
pass `--local` where a verb has it. Verbs that ask a daemon (`snapshot`,
`dispatch`, `message`, `sessions`) and verbs that write operator files under
`~/.config/shuttle` belong in the scratch daemon's world below.

## The daemon

```bash
make daemon                       # ~9 s warm, ~32 s in a fresh worktree; builds bin/rel-built and ./felt ./shuttle
scripts/scratch-daemon.sh         # 5-20 s (it copies the release); prints url (127.0.0.1:4190), root, env file and stop command
root=<the printed root>
curl -s -X POST -H 'content-type: application/json' \
  -d '{"action":"channel","fiber":"demo","channel":"-bad"}' 127.0.0.1:4190/api/v1/lifecycle
. "$root/env" && cd "$root/store" && shuttle snapshot   # the CLIs, pointed at the scratch daemon
kill <pid> && rm -rf "$root"      # as printed
```

The scratch daemon starts from an empty environment with its own home, host
id (`verify-scratch`), stores, ledgers and operator files, and stub `tmux`,
`rex`, `codex`, `tailscale`, `hark`, `ps`, `open`, `osascript`, `afplay` and
`kitty`, so it cannot see or launch a real worker. It boots under the boot
quarantine like any daemon. It does not replace the deploy: a daemon change
still runs for the first time on the host in `bin/shuttle-deploy`
([build-and-deploy.md](../../../docs/dev/build-and-deploy.md)), and you read the
fresh daemon's answer there before reporting it landed. The HTTP routes are in
[api.md](../../../docs/reference/api.md).
