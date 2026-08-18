# felt — unified CLI + Shuttle daemon
#
# Two artifacts live in this one repo:
#   - felt         (Go binary)      — the CLI (`felt …`, incl. `felt shuttle <verb>`).
#                                     `make cli` builds it; `make cli-install` installs
#                                     it to ~/.local/bin.
#   - bin/rel      (Elixir Mix release) — the dispatcher daemon, launched through the
#     tracked bin/shuttle shim. The release loads its BEAMs at boot, so
#                                     `make restart` rebuilds + bounces it (the
#                                     load-bearing daemon dev target).
#
# `make build` builds both. `make install` runs the full from-source bootstrap
# (bootstrap.sh): build+install the CLI, build the daemon release, place ui/dist,
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
# build only the daemon release automatically (no Go on PATH -> no CLI rebuild). On a
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
# The daemon is a Mix release: its beam process boots with an absolute
# `-boot <release>/releases/<vsn>/start` argument, and the release lives at
# bin/rel in a checkout (or a tarball root elsewhere). Matching the release's
# boot script identifies the daemon beam without matching the bin/shuttle shim
# (a short-lived /bin/sh) or pgrep's own shell command (`[r]el`).
PIDPATTERN := [b]in/rel/releases/.*/start
# Keep-alive knobs, all optional and all owned by `bin/shuttle install-agent`
# — the labels, unit/plist paths, the login-shell PATH capture and the per-OS
# ssh-agent default live there so a fetched tarball (no Makefile) installs the
# same supervisor these targets do. Set one here only to override the shim.
#
# AGENT_FELT_STORES — comma-separated felt stores the supervised daemon polls.
#   Required; the shim refuses to install a daemon that polls nothing.
#     make install-agent AGENT_FELT_STORES=~/my-store,/some/other
#   Prefer stores outside ~/Documents / ~/Desktop / ~/Downloads so the agent
#   touches no TCC-protected path and needs no Full Disk Access.
# AGENT_PATH — the PATH baked into the supervisor. Empty (the default) means
#   the shim captures the real login PATH at install time.
# AGENT_SSH_AUTH_SOCK — the persistent ssh-agent socket to bake in. Passed
#   through ONLY when you define it (even to empty), so the shim's per-OS
#   default stands otherwise: ~/.ssh/agent.sock on macOS, empty on Linux.
AGENT_FELT_STORES ?=
AGENT_PATH ?=

.PHONY: build cli cli-install daemon test go-test mix-test js-test plugin-hooks-test \
        all start stop restart \
        logs status clean help install install-agent uninstall-agent lint-personal

help:
	@echo "felt + shuttle (one repo, two artifacts):"
	@echo "  make build       — build BOTH: felt CLI + daemon release"
	@echo "  make cli         — build the felt CLI (go build .)"
	@echo "  make cli-install — install felt CLI → $(INSTALL_DIR)"
	@echo "  make daemon      — build the daemon release → bin/rel (MIX_ENV=prod)"
	@echo "  make test        — go test ./...  AND  mix test  AND  the ui suite  AND  the plugin hooks"
	@echo "  make plugin-hooks-test — exercise claude-plugin/hooks/* with HOME and PATH sandboxed"
	@echo "  make lint-personal — fail on maintainer host/account names in tracked source"
	@echo "  make install     — full from-source bootstrap (CLI + daemon + ui + hook + keep-alive)"
	@echo ""
	@echo "daemon lifecycle:"
	@echo "  make restart     — daemon (rebuild release) + stop + start  [load-bearing]"
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

# daemon refreshes the felt CLI first when Go is on PATH: the daemon shells
# the felt CLI for its writes (reopen --host, mark-runtime, …), so the two
# artifacts must never skew — a daemon built against an older installed CLI
# silently breaks daemon-shelled commands (unknown flags exit 1 mid-dispatch).
# SKIP_CLI=1 forces that rebuild off (bootstrap.sh --skip-cli passes it) so
# daemon builds only the release, trusting whatever felt is already on PATH.
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
	@# Regenerate the .app spec before assembling. Mix rewrites it only when
	@# mix.exs is NEWER than the existing spec, and mix.exs now takes its
	@# version from $$SHUTTLE_VERSION — an env change touches no mtime. So a
	@# build that once stamped a release tag would keep reporting that tag from
	@# every later plain `make daemon` (verified: it does). --force makes the
	@# local path match what release.yml does for the same reason.
	MIX_ENV=prod mix compile
	MIX_ENV=prod mix compile.app --force
	MIX_ENV=prod mix release shuttled --overwrite --path bin/rel

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
	@#     respawning the freshly-built release, so a daemon is (re)appearing on
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

# Rebuild the daemon release (NOT the Go CLI) then bounce — the fast daemon dev loop,
# safe on a host with no Go toolchain.
restart: daemon stop start

# ── One-command bootstrap ─────────────────────────────────────────────────
# The full fresh-machine install: prerequisites → felt CLI → daemon release →
# ui/dist → loom hook → keep-alive (launchd on macOS / systemd user unit on
# Linux). bootstrap.sh holds the host-branching logic; this is
# the entry point. Pass flags through:  make install ARGS="--dry-run"
install:
	@bash bootstrap.sh $(ARGS)

# ── Durable launch (launchd on macOS / systemd user unit on Linux) ────────
# Shuttle's own keep-alive, independent of any other process: restart the
# daemon on crash, start it at login/boot.
#
# The implementation lives in `bin/shuttle install-agent`, not here, because a
# fetched tarball has no Makefile and still has to be able to install a
# supervisor. The shim renders the same two templates in share/ (which ship
# inside the release too — see mix.exs's :copy_support_files), resolves
# __SHUTTLE_DIR__ from its own location rather than $(CURDIR), and owns the
# per-OS branching, the systemd probe, the tmux-loop retirement and the stop.
# These targets are a build step plus a pass-through of the AGENT_* knobs, so
# the checkout workflow (bootstrap.sh calls `make install-agent`) is unchanged
# and there is exactly one renderer.
#
# AGENT_LOG is passed rather than left to the shim's (identical) per-OS
# default, so `make logs` and the installed supervisor can never disagree.
#
# The release is built first so the supervisor has a daemon to run; `stop` is
# NOT a prerequisite, because on Linux the shim probes for systemd before
# killing anything — a no-systemd host must fail loudly with its daemon still
# running.
install-agent: daemon
	@AGENT_FELT_STORES='$(AGENT_FELT_STORES)' \
	 AGENT_PATH='$(AGENT_PATH)' \
	 AGENT_LOG='$(LOG)' \
	 $(if $(filter undefined,$(origin AGENT_SSH_AUTH_SOCK)),,AGENT_SSH_AUTH_SOCK='$(AGENT_SSH_AUTH_SOCK)') \
	 bin/shuttle install-agent

uninstall-agent:
	@bin/shuttle uninstall-agent

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
	rm -rf bin/rel
	rm -f Elixir.*.beam felt felt-linux
