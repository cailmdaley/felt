# felt + shuttle — two Go binaries, a daemon, and a board
#
#   - felt         (Go binary)      — fiber CLI (`felt …`).
#   - shuttle      (Go binary)      — orchestration CLI (`shuttle …`).
#                                     `make cli` builds both; `make cli-install`
#                                     installs both to ~/.local/bin.
#   - bin/rel      (Elixir Mix release) — the dispatcher daemon, launched by the
#                                     Go `shuttle daemon` command. The release
#                                     loads its BEAMs at boot, so `make restart`
#                                     rebuilds + bounces it (the load-bearing dev target).
#   - ui/dist      (TypeScript bundle) — the board UI served by the daemon. Build it
#                                     with `cd ui && npm run build`.
#
# `make build` builds both CLIs, the UI bundle, and the daemon release.
# `make install` runs the full from-source bootstrap
# (scripts/bootstrap.sh): build+install both CLIs, build the daemon release, place ui/dist,
# register the loom hook, install the keep-alive. The Elixir daemon embeds no
# agent registry — it reads the already-resolved record off `shuttle ls/show` JSON
# and shells `felt` for fiber data and `shuttle` for orchestration.
#
# macOS and Linux both serve as a single-host home for the daemon and the
# board. Where they differ the target branches on `uname -s`: the durable
# keep-alive is a launchd LaunchAgent on macOS and a systemd user unit on
# Linux, and the daemon log lands in ~/Library/Logs on macOS, ~/.shuttle on
# Linux. Multi-host tunnel management (`shuttle tunnels`) splits the same way:
# the autossh jobs it installs are launchd LaunchAgents on macOS and systemd
# --user units on Linux, so either platform can be the fleet's hub.
#
# Source builds use Go, Elixir/OTP, and Node/npm on the host's PATH.
# `make daemon SKIP_CLI=1` reuses installed `felt` and `shuttle` binaries,
# and `make build SKIP_UI=1` can reuse a ui/dist placed there by other means —
# which is how a host with no fast Node toolchain gets a board (`bin/shuttle-deploy`
# rsyncs the bundle to any remote marked `"build_ui": false` in the fleet file).

# SKIP_CLI=1 makes `daemon` skip installing both CLIs and require both on PATH.
SKIP_CLI ?=
# SKIP_UI=1 makes `build` and `restart` skip the UI bundle (see ui: below).
SKIP_UI ?=
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
# boot script identifies the daemon beam without matching the Go CLI or
# pgrep's own shell command (`[r]el`).
PIDPATTERN := [b]in/rel/releases/.*/start
# mix, run against the host's own Erlang. A shell the daemon started (a worker,
# a resumed session) can inherit the release's ERTS — bin/rel/erts-*/bin and
# bin/rel/bin at the head of PATH, plus erl's ROOTDIR/BINDIR/PROGNAME/EMU — and
# mix under that ERTS dies with "cannot get bootfile .../bin/rel/bin/start.boot".
# So every mix target drops those variables and every PATH entry under this
# checkout's bin/rel (and its rel.next / rel.prev siblings).
MIX_PATH := $(shell printf '%s' "$$PATH" | tr ':' '\n' | awk -v r='$(CURDIR)/bin/rel' 'index($$0, r) != 1' | paste -sd: -)
MIX := env -u ROOTDIR -u BINDIR -u PROGNAME -u EMU PATH='$(MIX_PATH)' mix
# Keep-alive knobs, all optional and owned by `shuttle daemon install` — labels,
# unit/plist paths, login-shell PATH capture and per-OS ssh-agent defaults live
# there, so a fetched release installs the same supervisor as these targets.
#
# AGENT_STORES — comma-separated felt stores the supervised daemon polls.
#   Optional fixed override; normally use the editable stores.json registry.
#     make install-agent AGENT_STORES=~/my-store,/some/other
#   Prefer stores outside ~/Documents / ~/Desktop / ~/Downloads so the daemon
#   touches no TCC-protected path and needs no Full Disk Access.
# AGENT_PATH — the PATH baked into the supervisor. Empty (the default) means
#   shuttle captures the real login PATH at install time.
# AGENT_SSH_AUTH_SOCK — the persistent ssh-agent socket to bake in. Passed
#   through ONLY when you define it (even to empty), so the per-OS default
#   stands otherwise: ~/.ssh/agent.sock on macOS, empty on Linux.
AGENT_STORES ?=
AGENT_PATH ?=

.PHONY: build cli cli-install ui daemon test go-test mix-test js-test plugin-hooks-test bootstrap-test \
        all start stop restart \
        logs status clean help install install-agent uninstall-agent lint-personal

help:
	@echo "felt + shuttle (two Go binaries, daemon release, UI bundle):"
	@echo "  make build       — build both CLIs + UI bundle + daemon release"
	@echo "                     SKIP_UI=1 leaves ui/dist alone (host gets its bundle elsewhere)"
	@echo "  make ui          — build the board bundle (npm ci on a lockfile change, then npm run build)"
	@echo "  make cli         — build felt and shuttle (go build ./cmd/felt ./cmd/shuttle)"
	@echo "  make cli-install — install felt and shuttle → $(INSTALL_DIR)"
	@echo "  make daemon      — build the daemon release → bin/rel (MIX_ENV=prod)"
	@echo "  make test        — go test ./...  AND  mix test  AND  the ui suite  AND  the plugin hooks"
	@echo "  make plugin-hooks-test — exercise harness hooks and the native Pi extension"
	@echo "  make lint-personal — fail on maintainer host/account names in tracked source"
	@echo "  make install     — full bootstrap (felt + shuttle + daemon + ui + hook + keep-alive)"
	@echo ""
	@echo "daemon lifecycle:"
	@echo "  make restart     — UI + daemon (rebuild release) + stop + start  [load-bearing]"
	@echo "                     honours SKIP_UI=1 the same way build does"
	@echo "  make all         — restart"
	@echo "  make start       — start daemon detached (logs → $(LOG))"
	@echo "  make stop        — SIGTERM the running daemon"
	@echo "  make install-agent   — durable keep-alive: launchd (macOS) / systemd user unit (Linux)"
	@echo "  make uninstall-agent — remove it"
	@echo "  make logs        — tail -f the daemon log"
	@echo "  make status      — shuttle ps + snapshot summary"
	@echo "  make clean       — remove daemon/_build, stray .beam files, built binaries"

# ── build ──────────────────────────────────────────────────────────────────
# `build` is the everything-target; `cli`, `ui`, and `daemon` build individual artifacts.
#
# SKIP_UI=1 leaves ui/dist alone — whatever is in the tree is what `daemon`
# embeds in the release. It is for a host that gets its bundle from elsewhere:
# on a cluster login node with a network home filesystem `npm ci` costs minutes,
# so bin/shuttle-deploy builds such a host with SKIP_UI=1 and rsyncs the deploy
# host's freshly-built ui/dist into the checkout before the release is assembled.
build: cli
ifeq ($(SKIP_UI),1)
	@echo "ui: skipped (SKIP_UI=1); the release embeds whatever ui/dist already holds"
else
	$(MAKE) ui
endif
	$(MAKE) daemon

cli:
	go build -o felt ./cmd/felt && go build -o shuttle ./cmd/shuttle

# `npm ci` is the expensive half — minutes on a network home filesystem — and its
# only input is the lockfile, so it is gated on a stamp inside node_modules that
# depends on ui/package-lock.json: it runs on a fresh checkout, after a lockfile
# change, and never otherwise. `npm run build` always runs; vite is the cheap half
# and the sources it reads change every commit. The stamp lives under
# node_modules/ so `npm ci`, which wipes and recreates that tree, cannot leave a
# stamp standing over dependencies it deleted.
UI_DEPS_STAMP := ui/node_modules/.npm-ci-stamp

$(UI_DEPS_STAMP): ui/package-lock.json
	cd ui && npm ci
	@mkdir -p $(dir $@)
	@touch $@

ui: $(UI_DEPS_STAMP)
	cd ui && npm run build

cli-install:
	GOBIN=$(INSTALL_DIR) go install ./cmd/felt ./cmd/shuttle

# The daemon calls both CLIs: felt for fiber content and shuttle for orchestration.
# Keep the installed pair in lockstep with the release. SKIP_CLI=1 skips the
# rebuild and requires both executables on PATH; without Go, the same pair is
# required rather than building only part of the daemon's interface.
# With Go available the build installs both before compiling the release.
daemon:
ifeq ($(SKIP_CLI),1)
	@command -v felt >/dev/null 2>&1 || { echo "felt not found on PATH (SKIP_CLI=1)."; exit 1; }
	@command -v shuttle >/dev/null 2>&1 || { echo "shuttle not found on PATH (SKIP_CLI=1)."; exit 1; }
else ifneq ($(shell command -v go 2>/dev/null),)
	$(MAKE) cli-install
else
	@command -v felt >/dev/null 2>&1 || { echo "felt not found on PATH and no Go toolchain to build it — install felt first."; exit 1; }
	@command -v shuttle >/dev/null 2>&1 || { echo "shuttle not found on PATH and no Go toolchain to build it — install shuttle first."; exit 1; }
endif
	cd daemon && $(MIX) deps.get
	cd daemon && $(MIX) shuttle.gen_version
	@# Regenerate the .app spec before assembling. Mix rewrites it only when
	@# mix.exs is NEWER than the existing spec, and mix.exs now takes its
	@# version from $$SHUTTLE_VERSION — an env change touches no mtime. So a
	@# build that once stamped a release tag would keep reporting that tag from
	@# every later plain `make daemon` (verified: it does). --force makes the
	@# local path match what release.yml does for the same reason.
	cd daemon && MIX_ENV=prod $(MIX) compile
	cd daemon && MIX_ENV=prod $(MIX) compile.app --force
	@# Assemble beside the live release and swap, never in place. A running
	@# daemon holds NIF .so files open under bin/rel/lib; on an NFS home that
	@# turns every unlink into a .nfs* silly-rename stub, and `--overwrite`'s
	@# rm_rf of the old lib dirs dies with "file already exists". The old tree
	@# lives on as bin/rel.prev (the running BEAM keeps its inodes). When a
	@# daemon still holds bin/rel.prev at the next build — two builds with no
	@# cycle between them — its .nfs* stubs make the tree unremovable, so it is
	@# set aside as bin/rel.retained-<epoch> and swept by a later build once
	@# nothing holds it.
	rm -rf bin/rel.next
	cd daemon && MIX_ENV=prod $(MIX) release shuttled --overwrite --path ../bin/rel.next
	@if [ -f ui/dist/index.html ]; then \
	  for app in bin/rel.next/lib/shuttle-*; do \
	    mkdir -p "$$app/priv/ui"; \
	    rm -rf "$$app/priv/ui/dist"; \
	    cp -R ui/dist "$$app/priv/ui/"; \
	  done; \
	fi
	@for d in bin/rel.retained-*; do [ -d "$$d" ] && rm -rf "$$d" 2>/dev/null; done; true
	@if [ -d bin/rel.prev ] && ! rm -rf bin/rel.prev 2>/dev/null; then \
	  mv bin/rel.prev "bin/rel.retained-$$(date +%s)"; \
	fi
	@[ -d bin/rel ] && mv bin/rel bin/rel.prev || true
	mv bin/rel.next bin/rel

# ── test ─────────────────────────────────────────────────────────────────
test: go-test mix-test js-test plugin-hooks-test bootstrap-test

go-test:
	go test ./...

mix-test:
	cd daemon && $(MIX) test

# The board's own suite. `npm test` runs it twice, once per pinned timezone —
# the civil-day rules are only meaningful against a real UTC offset.
js-test:
	cd ui && npm test

# scripts/bootstrap.sh's login-PATH handling and fail-fast boundaries, with
# every tool it would run stubbed: nothing is installed, registered, or
# touched in the caller's home or services.
bootstrap-test:
	bash scripts/test-bootstrap.sh

# The shell shim layer the Go and Elixir suites cannot reach: hooks.json's
# ${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT} fallback and felt-bin.sh's PATH
# resolution for GUI-launched agents. Runs with HOME and PATH sandboxed.
plugin-hooks-test:
	bash scripts/test-plugin-hooks.sh
	node --experimental-strip-types extensions/pi/test.mjs

# Fail if a maintainer's own host or account name has crept back into tracked
# source. Fleet members belong in ~/.config/felt/remotes.json, not in the repo.
# Runs as part of `make go-test` too; this target is for a quick standalone check.
lint-personal:
	go test ./cmd/ -run TestNoPersonalIdentifiersInSource

# ── daemon lifecycle ──────────────────────────────────────────────────────
all: restart

start:
	@# Readiness is binding :4000, not a fixed wait. Two boot paths converge here:
	@#   - nohup dev launch: we spawn the Go shuttle CLI ourselves.
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
	  nohup env PATH="$(INSTALL_DIR):$$PATH" SHUTTLE_RELEASE='$(CURDIR)/bin/rel' shuttle daemon start >> $(LOG) 2>&1 & \
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

# The Go lifecycle command marks a requested stop before signaling the daemon,
# preserving the boot-quarantine boundary in one place.
stop:
	@PATH="$(INSTALL_DIR):$$PATH" SHUTTLE_RELEASE='$(CURDIR)/bin/rel' shuttle daemon stop

# Rebuild the UI and daemon together before restarting the service.
restart:
ifeq ($(SKIP_UI),1)
	@echo "ui: skipped (SKIP_UI=1); the release embeds whatever ui/dist already holds"
else
	$(MAKE) ui
endif
	$(MAKE) daemon
	$(MAKE) stop
	$(MAKE) start

# ── One-command bootstrap ─────────────────────────────────────────────────
# The full fresh-machine install: prerequisites → felt/shuttle CLIs → daemon
# release → ui/dist → loom hook → keep-alive (launchd on macOS / systemd user
# unit on Linux). scripts/bootstrap.sh holds the host-branching logic; this is
# the entry point. Pass flags through:  make install ARGS="--dry-run"
install:
	@bash scripts/bootstrap.sh $(ARGS)

# ── Durable launch (launchd on macOS / systemd user unit on Linux) ────────
# Shuttle's own keep-alive, independent of any other process: restart the
# daemon on crash, start it at login/boot.
#
# `shuttle daemon install` owns the templates in daemon/share/ (also copied
# into the release by daemon/mix.exs). This target passes bin/rel through
# SHUTTLE_RELEASE; the CLI owns per-OS rendering and stop behavior. Checkout
# and fetched-release installation use the same renderer.
#
# AGENT_LOG is passed explicitly so `make logs` and the supervisor cannot disagree.
# The release is built first; install checks supervisor availability before
# stopping anything, so a host without systemd can keep its daemon running.
install-agent: daemon
	@PATH="$(INSTALL_DIR):$$PATH" SHUTTLE_RELEASE='$(CURDIR)/bin/rel' shuttle daemon install \
	 $(if $(strip $(AGENT_STORES)),--stores '$(AGENT_STORES)',) \
	 $(if $(strip $(AGENT_PATH)),--path '$(AGENT_PATH)',) \
	 --log '$(LOG)' \
	 $(if $(filter undefined,$(origin AGENT_SSH_AUTH_SOCK)),,--ssh-auth-sock '$(AGENT_SSH_AUTH_SOCK)')

uninstall-agent:
	@PATH="$(INSTALL_DIR):$$PATH" SHUTTLE_RELEASE='$(CURDIR)/bin/rel' shuttle daemon uninstall

logs:
	@tail -f $(LOG)

status:
	@PATH="$(INSTALL_DIR):$$PATH" shuttle ps 2>/dev/null || echo "(shuttle ps unavailable)"
	@echo
	@PATH="$(INSTALL_DIR):$$PATH" shuttle snapshot 2>/dev/null | python3 -c "import json,sys; o=json.load(sys.stdin); \
	  print('felt_stores:', o.get('felt_stores','MISSING')); \
	  print('running:', [e.get('fiber_id') for e in o.get('eligible',[])]); \
	  print('claimed:', o.get('claimed_count'),'/',o.get('max_concurrent'))" \
	  2>/dev/null || echo "(daemon not responding)"

clean:
	rm -rf daemon/_build
	rm -rf bin/rel bin/rel.next bin/rel.prev
	rm -f Elixir.*.beam felt felt-linux shuttle shuttle-linux
