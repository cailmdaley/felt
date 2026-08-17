# felt — unified CLI + Shuttle daemon
#
# Two artifacts live in this one repo:
#   - felt         (Go binary)      — the CLI (`felt …`, incl. `felt shuttle <verb>`).
#                                     `make cli` builds it; `make cli-install` installs
#                                     it to ~/.local/bin.
#   - bin/shuttle  (Elixir escript) — the dispatcher daemon. Loads BEAMs at boot, so
#                                     `make restart` rebuilds + bounces it (the
#                                     load-bearing daemon dev target).
#
# `make build` builds both. `make install` runs the full from-source bootstrap
# (bootstrap.sh): build+install the CLI, build the daemon escript, place ui/dist,
# register the loom hook, install the keep-alive. The Elixir daemon embeds no
# agent registry — it reads the already-resolved record off felt's
# `shuttle.resolved.agent` JSON and shells `felt shuttle agents [resolve]`.
#
# macOS and Linux both serve as a single-host home for the daemon and the
# board. Where they differ the target branches on `uname -s`: the durable
# keep-alive is a launchd LaunchAgent on macOS and a systemd user unit on
# Linux, and the daemon log lands in ~/Library/Logs on macOS, ~/.shuttle on
# Linux. Multi-host tunnel management (`felt shuttle tunnels`) splits the same
# way: the autossh jobs it installs are launchd LaunchAgents on macOS and
# systemd --user units on Linux, so either platform can be the fleet's hub.
#
# On Linux hosts without a Go toolchain, `make all` / `make daemon`
# build only the escript automatically (no Go on PATH -> no CLI rebuild). On a
# host that DOES have Go, daemon rebuilds the CLI first to keep the two in
# lockstep; pass SKIP_CLI=1 to force-skip that and build against whatever felt
# is already on PATH (this is what bootstrap.sh --skip-cli does). `make build`
# (both) is a Mac/dev convenience and needs `go` on PATH.

# SKIP_CLI=1 makes `daemon` skip the felt-CLI rebuild step (see daemon: below).
SKIP_CLI ?=
INSTALL_DIR := $(HOME)/.local/bin
UNAME_S := $(shell uname -s)
# The daemon log. macOS has a conventional home for it; Linux does not, so the
# log joins the daemon's other state under ~/.shuttle (events.jsonl, tmux.sock,
# repo) — and that is already where bin/shuttle-launch's respawn loop writes.
# So on Linux every launch path (make start, the respawn loop, the systemd
# unit) lands on ONE file, and `make logs` tails it whichever one is running.
ifeq ($(UNAME_S),Darwin)
LOG := $(HOME)/Library/Logs/shuttle.log
else
LOG := $(HOME)/.shuttle/shuttle.log
endif
# Match both the local `bin/shuttle ... -extra bin/shuttle start` shape and
# remote respawn-loop `./bin/shuttle ... -extra ./bin/shuttle start` shape.
# `[b]in` prevents pgrep from matching its own shell command.
# `[^ ]*` (not `\S`) — macOS pgrep uses basic regex and treats `\S` as a
# literal, so it never matches and stop/start/status all silently miss the
# daemon.
PIDPATTERN := [b]in/shuttle -B .* -extra [^ ]*bin/shuttle start
AGENT_LABEL := io.shuttle.daemon
AGENT_PLIST := $(HOME)/Library/LaunchAgents/$(AGENT_LABEL).plist
# The Linux analog: a systemd *user* unit. Named for the tmux session the
# respawn loop uses, so one name means "the supervised daemon" on either path.
AGENT_UNIT_NAME := shuttle-daemon.service
AGENT_UNIT_DIR := $(HOME)/.config/systemd/user
AGENT_UNIT := $(AGENT_UNIT_DIR)/$(AGENT_UNIT_NAME)
# Felt stores the supervised daemon polls. No default: pass your own, e.g.
#   make install-agent AGENT_FELT_STORES=~/my-store,/some/other
# Prefer stores outside ~/Documents / ~/Desktop / ~/Downloads so the agent
# touches no TCC-protected path and needs no Full Disk Access.
AGENT_FELT_STORES ?=
# The daemon's PATH, captured from a login shell at install time so it carries
# Homebrew (escript/erl) and ~/.local/bin (felt), etc. — launchd's own env is
# too bare, and sourcing the profile at runtime under launchd doesn't
# reconstruct it. This is the user's real PATH, frozen.
AGENT_PATH ?= $(shell /bin/bash -lc 'echo $$PATH')
# The user's PERSISTENT ssh-agent socket. launchd hands the daemon a bare
# per-session Keychain agent that only holds the default key, so remote creds
# added to the real agent — e.g. a remote host's step-ca SSH cert — are invisible
# and fresh ssh to that host fails (dead remote feed; Attach tabs that open and die).
# ~/.ssh/agent.sock is the stable login-agent path on macOS; override if yours
# differs. Linux has no canonical path, and the ambient $SSH_AUTH_SOCK isn't a
# usable default either — it's a per-session socket under /tmp/ssh-*/, dead
# the moment this login session ends, which defeats enable-linger (the daemon
# would outlive the socket it was pointed at). So Linux defaults to empty,
# which drops the setting from the rendered unit rather than baking in a
# socket that's already dead by the time it matters. Set AGENT_SSH_AUTH_SOCK
# explicitly for a persistent socket — e.g. gpg-agent's ssh support, or a
# systemd ssh-agent unit.
ifeq ($(UNAME_S),Darwin)
AGENT_SSH_AUTH_SOCK ?= $(HOME)/.ssh/agent.sock
else
AGENT_SSH_AUTH_SOCK ?=
endif

.PHONY: build cli cli-install daemon test go-test mix-test js-test plugin-hooks-test \
        all start stop restart \
        logs status clean help install install-agent uninstall-agent lint-personal

help:
	@echo "felt + shuttle (one repo, two artifacts):"
	@echo "  make build       — build BOTH: felt CLI + daemon escript"
	@echo "  make cli         — build the felt CLI (go build .)"
	@echo "  make cli-install — install felt CLI → $(INSTALL_DIR)"
	@echo "  make daemon      — build the daemon escript → bin/shuttle (MIX_ENV=dev)"
	@echo "  make test        — go test ./...  AND  mix test  AND  the ui suite  AND  the plugin hooks"
	@echo "  make plugin-hooks-test — exercise claude-plugin/hooks/* with HOME and PATH sandboxed"
	@echo "  make lint-personal — fail on maintainer host/account names in tracked source"
	@echo "  make install     — full from-source bootstrap (CLI + daemon + ui + hook + keep-alive)"
	@echo ""
	@echo "daemon lifecycle:"
	@echo "  make restart     — daemon (rebuild escript) + stop + start  [load-bearing]"
	@echo "  make all         — restart"
	@echo "  make start       — start daemon detached (logs → $(LOG))"
	@echo "  make stop        — SIGTERM the running daemon"
	@echo "  make install-agent   — durable keep-alive: launchd (macOS) / systemd user unit (Linux)"
	@echo "  make uninstall-agent — remove it"
	@echo "  make logs        — tail -f the daemon log"
	@echo "  make status      — felt shuttle ps + snapshot summary"
	@echo "  make clean       — remove _build, stray .beam files, built binaries"

# ── build ──────────────────────────────────────────────────────────────────
# `build` is the everything-target; `cli` and `daemon` are the per-artifact ones.
build: cli daemon

cli:
	go build .

cli-install:
	GOBIN=$(INSTALL_DIR) go install .

# daemon refreshes the felt CLI first when Go is on PATH: the escript shells
# the felt CLI for its writes (reopen --host, mark-runtime, …), so the two
# artifacts must never skew — a daemon built against an older installed CLI
# silently breaks daemon-shelled commands (unknown flags exit 1 mid-dispatch).
# SKIP_CLI=1 forces that rebuild off (bootstrap.sh --skip-cli passes it) so
# daemon builds only the escript, trusting whatever felt is already on PATH.
# With no Go toolchain the rebuild is skipped automatically either way.
daemon:
ifeq ($(SKIP_CLI),1)
	@:
else ifneq ($(shell command -v go 2>/dev/null),)
	$(MAKE) cli-install
else
	@command -v felt >/dev/null 2>&1 || { echo "felt not found on PATH and no Go toolchain to build it — install felt first."; exit 1; }
endif
	mix shuttle.gen_version
	mix escript.build

# ── test ─────────────────────────────────────────────────────────────────
test: go-test mix-test js-test plugin-hooks-test

go-test:
	go test ./...

mix-test:
	mix test

# The board's own suite. `npm test` runs it twice, once per pinned timezone —
# the civil-day rules are only meaningful against a real UTC offset.
js-test:
	cd ui && npm test

# The shell shim layer the Go and Elixir suites cannot reach: hooks.json's
# ${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT} fallback and felt-bin.sh's PATH
# resolution for GUI-launched agents. Runs with HOME and PATH sandboxed.
plugin-hooks-test:
	bash scripts/test-plugin-hooks.sh

# Fail if a maintainer's own host or account name has crept back into tracked
# source. Fleet members belong in ~/.config/felt/remotes.json, not in the repo.
# Runs as part of `make go-test` too; this target is for a quick standalone check.
lint-personal:
	go test ./cmd/ -run TestNoPersonalIdentifiersInSource

# ── daemon lifecycle ──────────────────────────────────────────────────────
all: restart

start:
	@# Readiness is binding :4000, not a fixed wait. Two boot paths converge here:
	@#   - nohup dev launch: we spawn bin/shuttle ourselves.
	@#   - launchd KeepAlive: `make stop` killed the daemon and launchd is already
	@#     respawning the freshly-built escript, so a daemon is (re)appearing on
	@#     its own — launching our own would just collide on :4000.
	@# So: if one's already running (launchd respawn / never down), adopt it and
	@# wait for :4000; otherwise nohup-launch. Either way poll /api/v1/version up
	@# to ~120s (launchd / slow remote boots adopt orphans before binding), and
	@# fail fast the moment the daemon process dies — a real boot crash surfaces
	@# immediately instead of after the full timeout.
	@mkdir -p $(dir $(LOG))
	@if pgrep -f '$(PIDPATTERN)' >/dev/null; then \
	  pid=$$(pgrep -f '$(PIDPATTERN)' | head -1); \
	  echo "shuttle already running (pid $$pid); waiting for :4000"; \
	else \
	  echo "=== shuttle start $$(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> $(LOG); \
	  nohup bin/shuttle start >> $(LOG) 2>&1 & \
	  pid=$$!; \
	fi; \
	deadline=$$(( $$(date +%s) + 120 )); \
	while :; do \
	  if curl -fsS -o /dev/null http://127.0.0.1:4000/api/v1/version 2>/dev/null; then \
	    echo "shuttle up (pid $$(pgrep -f '$(PIDPATTERN)' | head -1)); answering :4000; logs → $(LOG)"; exit 0; \
	  fi; \
	  if ! kill -0 $$pid 2>/dev/null; then \
	    echo "shuttle failed to start (process $$pid exited during boot); check $(LOG)"; exit 1; \
	  fi; \
	  if [ $$(date +%s) -ge $$deadline ]; then \
	    echo "shuttle failed to start (no :4000 response within 120s); check $(LOG)"; exit 1; \
	  fi; \
	  sleep 1; \
	done

stop:
	@pid=$$(pgrep -f '$(PIDPATTERN)'); \
	if [ -n "$$pid" ]; then \
	  echo "stopping shuttle (pid $$pid)"; \
	  kill -TERM $$pid; \
	  for i in 1 2 3 4 5; do sleep 1; pgrep -f '$(PIDPATTERN)' >/dev/null || break; done; \
	  pgrep -f '$(PIDPATTERN)' >/dev/null && (echo "force-killing"; kill -9 $$pid) || echo "stopped"; \
	else \
	  echo "shuttle not running"; \
	fi

# Rebuild the escript (NOT the Go CLI) then bounce — the fast daemon dev loop,
# safe on a host with no Go toolchain.
restart: daemon stop start

# ── One-command bootstrap ─────────────────────────────────────────────────
# The full fresh-machine install: prerequisites → felt CLI → daemon escript →
# ui/dist → loom hook → keep-alive (launchd on macOS / systemd user unit on
# Linux). bootstrap.sh holds the host-branching logic; this is
# the entry point. Pass flags through:  make install ARGS="--dry-run"
install:
	@bash bootstrap.sh $(ARGS)

# ── Durable launch (launchd on macOS / systemd user unit on Linux) ────────
# Shuttle's own keep-alive, independent of any other process: restart the
# daemon on crash, start it at login/boot. One target, two supervisors —
# `uname -s` picks the branch, and the two templates in share/ carry the same
# environment capture (PATH, FELT_STORES, SSH_AUTH_SOCK) for the same reasons.
# The escript is built first so the supervisor has a binary to run. On Linux
# the systemd-availability probe runs BEFORE anything is stopped — `make stop`
# is invoked from inside the recipe only after the probe passes, so a
# no-systemd host fails loudly without having killed a daemon it can no
# longer hand off to a supervisor (`stop` is deliberately NOT a prerequisite;
# prerequisites run before the recipe body, which would stop the daemon even
# when the probe is about to reject the host). On macOS `stop` stays a
# prerequisite — always safe there, since a launchd keep-alive is what handles
# the "no durable supervisor" case.
ifeq ($(UNAME_S),Darwin)
install-agent: daemon stop
else
install-agent: daemon
endif
	@test -n "$(AGENT_FELT_STORES)" || { \
	  echo "AGENT_FELT_STORES is required (comma-separated felt stores the daemon polls):"; \
	  echo "  make install-agent AGENT_FELT_STORES=~/my-store"; \
	  exit 1; }
	@mkdir -p $(dir $(LOG))
ifneq ($(UNAME_S),Darwin)
	@# systemd --user is the Linux durable surface, but plenty of Linux hosts
	@# don't have one — an HPC login node often has no user manager reachable
	@# over ssh, and a container may have no systemd at all. Probe BEFORE
	@# stopping anything: say so and point at the two working alternatives
	@# rather than writing a unit nothing will read, or killing a daemon the
	@# host has no supervisor to bring back.
	@systemctl --user show-environment >/dev/null 2>&1 || { \
	  echo "no systemd user session here (systemctl --user is unavailable or not reachable)."; \
	  echo "Durable alternative — the tmux respawn loop bootstrap.sh installs:"; \
	  echo "  SHUTTLE_DIR=$(CURDIR) bin/shuttle-launch"; \
	  echo "Or run the daemon without a supervisor:"; \
	  echo "  make start        # nohup, logs → $(LOG)"; \
	  exit 1; }
	@# The respawn loop and the unit would both bind :4000. The loop wins any
	@# race (it restarts what `make stop` killed), so retire it before handing
	@# the daemon to systemd. Sequential, matching bin/shuttle-launch's own
	@# legacy-socket sweep. `make stop` runs here, after the probe passed, so
	@# the daemon is only ever killed once we know systemd can take it back.
	@tmux -S $(HOME)/.shuttle/tmux.sock kill-session -t shuttle-daemon 2>/dev/null || true
	@tmux kill-session -t shuttle-daemon 2>/dev/null || true
	@$(MAKE) --no-print-directory stop
	@mkdir -p $(AGENT_UNIT_DIR)
	@sed -e 's#__SHUTTLE_DIR__#$(CURDIR)#g' -e 's#__LOG__#$(LOG)#g' \
	  -e 's#__FELT_STORES__#$(AGENT_FELT_STORES)#g' -e 's#__PATH__#$(AGENT_PATH)#g' \
	  -e 's#__SSH_AUTH_SOCK__#$(AGENT_SSH_AUTH_SOCK)#g' \
	  share/io.shuttle.daemon.service.template \
	  | sed -e '/^Environment=SSH_AUTH_SOCK=$$/d' > $(AGENT_UNIT)
	@systemctl --user daemon-reload
	@systemctl --user enable --now $(AGENT_UNIT_NAME)
	@echo "enabled $(AGENT_UNIT_NAME) → daemon restarts on crash + starts at login"
	@echo "logs → $(LOG)   (systemctl --user status $(AGENT_UNIT_NAME)  to inspect)"
	@echo "run 'loginctl enable-linger $$(id -un)' so it survives logout and starts at boot"
else
	@case "$(CURDIR)" in \
	  $(HOME)/Documents/*|$(HOME)/Desktop/*|$(HOME)/Downloads/*) \
	    echo "⚠️  $(CURDIR) is under a TCC-protected folder (~/Documents, ~/Desktop,"; \
	    echo "    ~/Downloads). launchd-spawned processes are blocked from these, and"; \
	    echo "    Full Disk Access does NOT inherit across the launchd process tree —"; \
	    echo "    so the daemon will crash-loop or silently fail its felt-store walks."; \
	    echo "    Fix: run from a checkout OUTSIDE these folders (e.g. ~/src/felt)."; \
	    echo "    Installing the agent anyway, but it will not work from here." ;; \
	esac
	@mkdir -p $(HOME)/Library/LaunchAgents
	@sed -e 's#__SHUTTLE_DIR__#$(CURDIR)#g' -e 's#__LOG__#$(LOG)#g' \
	  -e 's#__FELT_STORES__#$(AGENT_FELT_STORES)#g' -e 's#__PATH__#$(AGENT_PATH)#g' \
	  -e 's#__SSH_AUTH_SOCK__#$(AGENT_SSH_AUTH_SOCK)#g' \
	  share/io.shuttle.daemon.plist.template > $(AGENT_PLIST)
	@launchctl unload $(AGENT_PLIST) 2>/dev/null || true
	@launchctl load $(AGENT_PLIST)
	@echo "loaded $(AGENT_LABEL) → daemon will keep-alive + start at login"
	@echo "logs → $(LOG)   (launchctl list | grep shuttle  to inspect)"
endif

uninstall-agent:
ifneq ($(UNAME_S),Darwin)
	@systemctl --user disable --now $(AGENT_UNIT_NAME) 2>/dev/null || true
	@rm -f $(AGENT_UNIT)
	@systemctl --user daemon-reload 2>/dev/null || true
	@echo "disabled + removed $(AGENT_UNIT_NAME)"
else
	@launchctl unload $(AGENT_PLIST) 2>/dev/null || true
	@rm -f $(AGENT_PLIST)
	@echo "unloaded + removed $(AGENT_LABEL)"
endif

logs:
	@tail -f $(LOG)

status:
	@felt shuttle ps 2>/dev/null || echo "(felt shuttle ps unavailable)"
	@echo
	@bin/shuttle snapshot 2>/dev/null | python3 -c "import json,sys; o=json.load(sys.stdin); \
	  print('felt_hosts:', o.get('felt_hosts','MISSING (binary pre-297a24d)')); \
	  print('running:', [e.get('fiber_id') for e in o.get('eligible',[])]); \
	  print('claimed:', o.get('claimed_count'),'/',o.get('max_concurrent'))" \
	  2>/dev/null || echo "(daemon not responding)"

clean:
	rm -rf _build
	rm -f Elixir.*.beam bin/shuttle felt felt-linux
