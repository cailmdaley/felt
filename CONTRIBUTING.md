# Contributing to felt

Thank you for your interest in felt.

felt is one repo with two code artifacts — the **felt CLI** (Go; the data layer,
including the `felt shuttle <verb>` subcommands) and the **Shuttle daemon**
(Elixir/OTP escript; the dispatcher) — plus the served kanban board **UI**
(TypeScript). See `AGENTS.md` for the full architecture and operator guide.

## Getting started

```bash
git clone https://github.com/cailmdaley/felt
cd felt
go build .                    # the felt CLI
mix deps.get && mix compile   # the daemon
make build                    # both (CLI + daemon escript)
```

Requirements: Go 1.23+, Erlang/OTP 26+, Elixir 1.16+, and `tmux` (the daemon
launches each worker in a tmux session). Node 22+ is needed only to build the UI
bundle (`cd ui && npm run build`).

## Running tests

```bash
go test ./...   # Go (felt CLI)
mix test        # Elixir (daemon)
make test       # both
```

CI runs `go build`/`go test ./...`, `mix compile --warnings-as-errors` +
`mix test`, and a `vite build` of the board on every PR.

## Invariants

Before opening a PR, verify:

- `go test ./...` passes
- `mix compile --warnings-as-errors` passes
- `mix test` passes
- No personal paths (`~/loom`, `/Users/...`) in tracked files
- Felt owns the agent registry — the daemon reads the already-resolved record
  off felt's `shuttle.resolved.agent` JSON and shells `felt shuttle agents`; do
  not add a parallel registry in Elixir config or Go source.

## Scope

felt is deliberately personal-scale: no auth model, no team conventions, the
felt tree as the only work source. Contributions that add general-purpose
infrastructure are welcome; contributions that add a specific integration layer
belong in a fork or a `Shuttle.WorkSource` adapter once that abstraction lands.

## Opening issues

- **Bugs:** include steps to reproduce and the output of `bin/shuttle snapshot`.
- **Features:** describe the problem, not just the solution. A concrete
  use-case helps.

## License

By contributing, you agree that your contributions are licensed under the
repository's MIT license. Note that the Shuttle daemon (`lib/`) contains code
derived from OpenAI's Symphony under the Apache License 2.0, preserved in
`NOTICE` and `LICENSE-APACHE`.
