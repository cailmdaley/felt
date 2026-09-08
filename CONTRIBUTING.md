# Contributing to felt

Thank you for your interest in felt.

felt is one repo with three shipped artifacts — the **felt CLI** (Go; the data
layer, including the `felt shuttle <verb>` subcommands), the **shuttle daemon**
(Elixir/OTP Mix release; the dispatcher), and the served board **UI**
(TypeScript; a kanban desk, three temporal views, and a file canvas). See
`AGENTS.md` for the full architecture and operator guide.

## Getting started

```bash
git clone https://github.com/cailmdaley/felt
cd felt
go build .                    # the felt CLI
(cd daemon && mix deps.get && mix compile)  # the daemon
make build                    # CLI + UI + daemon release
```

Requirements: Go 1.23+, Erlang/OTP 28+, Elixir 1.19+, Node 22+ and npm. Working on the felt CLI
alone needs only Go. `tmux` matters once you touch the shuttle daemon or its
dispatch path — it launches each worker in a tmux session. Node 22+ is needed to
build the UI bundle (`cd ui && npm run build`) and to run the board's test
suite, so `make test` needs it too.

## Running tests

```bash
go test ./...                       # Go (felt CLI)
make mix-test                       # Elixir (daemon)
(cd ui && npm test)                 # TypeScript (board) — runs twice, once per pinned timezone
bash scripts/test-plugin-hooks.sh   # shell hook shims (claude-plugin/hooks/*)
make test                           # all four
```

CI runs `go build`/`go test ./...`, `scripts/test-plugin-hooks.sh`, a check
that the two plugin manifests agree on version, `mix compile
--warnings-as-errors` + `mix test`, and both `npm test` (under the two
pinned time zones) and `npm run build` for the board on every PR.
Mix commands run inside `daemon/`.

## Invariants

Before opening a PR, verify:

- `go test ./...` passes
- `(cd daemon && mix compile --warnings-as-errors)` passes
- `make mix-test` passes
- `cd ui && npm test` passes
- `bash scripts/test-plugin-hooks.sh` passes
- No personal hostnames, usernames, or absolute home paths (`/Users/...`) in
  tracked source, docs, or skills — `go test ./cmd -run
  TestNoPersonalIdentifiersInSource` enforces the list. Fleet data belongs in
  `~/.config/felt/remotes.json`; test files and `testdata/` are exempt.
- `~/loom` is not a personal path here: it is the deliberate running example for
  a cross-project store (see the docs site). Leave it in place; substitute your
  own store path when following the docs.
- felt owns the agent registry — the daemon reads the already-resolved record
  off felt's `shuttle.resolved.agent` JSON and shells `felt shuttle agents`; do
  not add a parallel registry in Elixir config or Go source.

## Scope

felt is deliberately personal-scale: no auth model, no team conventions, the
felt tree as the only work source. Contributions that add general-purpose
infrastructure are welcome; contributions that add a specific integration layer
belong in a fork or a `Shuttle.WorkSource` adapter once that abstraction lands.

## Opening issues

- **Bugs:** include steps to reproduce. For a shuttle/daemon bug, also include
  the output of `bin/shuttle snapshot`; a felt-CLI-only bug report doesn't need
  it.
- **Features:** describe the problem, not just the solution. A concrete
  use-case helps.

## License

By contributing, you agree that your contributions are licensed under the
repository's MIT license. Note that the shuttle daemon (`daemon/lib/`) contains code
derived from OpenAI's Symphony under the Apache License 2.0, preserved in
`NOTICE` and `LICENSE-APACHE`.
