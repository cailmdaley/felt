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
# On the clusters (candide/cineca) use `make all` / `make daemon` — they build
# only the escript and need no Go toolchain. `make build` (both) is a Mac/dev
# convenience and needs `go` on PATH.

INSTALL_DIR := $(HOME)/.local/bin
LOG := $(HOME)/Library/Logs/shuttle.log
# Match both the local `bin/shuttle ... -extra bin/shuttle start` shape and
# remote respawn-loop `./bin/shuttle ... -extra ./bin/shuttle start` shape.
# `[b]in` prevents pgrep from matching its own shell command.
PIDPATTERN := [b]in/shuttle -B .* -extra \.?/?bin/shuttle start
AGENT_LABEL := io.shuttle.daemon
AGENT_PLIST := $(HOME)/Library/LaunchAgents/$(AGENT_LABEL).plist
# Felt stores the launchd daemon polls. Defaults to the aggregate store (~/loom,
# outside ~/Documents) so the agent touches no TCC-protected path and needs no
# Full Disk Access. Override to add stores: make install-agent AGENT_FELT_STORES=~/loom,/some/other
AGENT_FELT_STORES ?= $(HOME)/loom
# The daemon's PATH, captured from a login shell at install time so it carries
# Homebrew (escript/erl) and ~/.local/bin (felt), etc. — launchd's own env is
# too bare, and sourcing the profile at runtime under launchd doesn't
# reconstruct it. This is the user's real PATH, frozen.
AGENT_PATH ?= $(shell /bin/bash -lc 'echo $$PATH')
# The user's PERSISTENT ssh-agent socket. launchd hands the daemon a bare
# per-session Keychain agent that only holds the default key, so remote creds
# added to the real agent — e.g. cineca's step-ca SSH cert — are invisible and
# fresh ssh to cineca fails (dead remote feed; Attach tabs that open and die).
# ~/.ssh/agent.sock is the stable login-agent path; override if yours differs.
AGENT_SSH_AUTH_SOCK ?= $(HOME)/.ssh/agent.sock

.PHONY: build cli cli-install daemon test go-test mix-test all start stop restart \
        logs status clean help install install-agent uninstall-agent

help:
	@echo "felt + shuttle (one repo, two artifacts):"
	@echo "  make build       — build BOTH: felt CLI + daemon escript"
	@echo "  make cli         — build the felt CLI (go build .)"
	@echo "  make cli-install — install felt CLI → $(INSTALL_DIR)"
	@echo "  make daemon      — build the daemon escript → bin/shuttle (MIX_ENV=dev)"
	@echo "  make test        — go test ./...  AND  mix test"
	@echo "  make install     — full from-source bootstrap (CLI + daemon + ui + hook + keep-alive)"
	@echo ""
	@echo "daemon lifecycle:"
	@echo "  make restart     — daemon (rebuild escript) + stop + start  [load-bearing]"
	@echo "  make all         — restart"
	@echo "  make start       — start daemon detached (logs → $(LOG))"
	@echo "  make stop        — SIGTERM the running daemon"
	@echo "  make install-agent   — durable launchd keep-alive (crash + login restart)"
	@echo "  make uninstall-agent — remove the launchd agent"
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

daemon:
	mix shuttle.gen_version
	mix escript.build

# ── test ─────────────────────────────────────────────────────────────────
test: go-test mix-test

go-test:
	go test ./...

mix-test:
	mix test

# ── daemon lifecycle ──────────────────────────────────────────────────────
all: restart

start:
	@if pgrep -f '$(PIDPATTERN)' >/dev/null; then \
	  echo "shuttle already running (pid $$(pgrep -f '$(PIDPATTERN)'))"; exit 1; \
	fi
	@echo "=== shuttle start $$(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> $(LOG)
	@nohup bin/shuttle start >> $(LOG) 2>&1 &
	@sleep 1
	@if pgrep -f '$(PIDPATTERN)' >/dev/null; then \
	  echo "shuttle started (pid $$(pgrep -f '$(PIDPATTERN)')); logs → $(LOG)"; \
	else \
	  echo "shuttle failed to start; check $(LOG)"; exit 1; \
	fi

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
# safe on the clusters (no Go toolchain needed).
restart: daemon stop start

# ── One-command bootstrap ─────────────────────────────────────────────────
# The full fresh-machine install: prerequisites → felt CLI → daemon escript →
# ui/dist → loom hook → keep-alive (launchd on macOS / shuttle-daemon respawn
# loop on the clusters). bootstrap.sh holds the host-branching logic; this is
# the entry point. Pass flags through:  make install ARGS="--dry-run"
install:
	@bash bootstrap.sh $(ARGS)

# ── Durable launch (macOS LaunchAgent) ──────────────────────────────────
# Shuttle's own keep-alive, independent of any other process. Installs a
# launchd agent that restarts the daemon on crash (KeepAlive) and starts it at
# login (RunAtLoad). The escript is built first so the agent has a binary to
# run; `make stop` clears any nohup-spawned daemon so launchd owns the single
# live instance.
install-agent: daemon stop
	@case "$(CURDIR)" in \
	  $(HOME)/Documents/*|$(HOME)/Desktop/*|$(HOME)/Downloads/*) \
	    echo "⚠️  $(CURDIR) is under a TCC-protected folder (~/Documents, ~/Desktop,"; \
	    echo "    ~/Downloads). launchd-spawned processes are blocked from these, and"; \
	    echo "    Full Disk Access does NOT inherit across the launchd process tree —"; \
	    echo "    so the daemon will crash-loop or silently fail its felt-store walks."; \
	    echo "    Fix: run from a checkout OUTSIDE these folders (canonical: ~/dev/felt)."; \
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

uninstall-agent:
	@launchctl unload $(AGENT_PLIST) 2>/dev/null || true
	@rm -f $(AGENT_PLIST)
	@echo "unloaded + removed $(AGENT_LABEL)"

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
