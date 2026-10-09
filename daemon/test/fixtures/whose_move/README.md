# Live harness captures

These fixtures retain protocol facts from real harness runs, not invented peer responses.
Session/thread identities are renamed; filesystem paths, user messages, and host metadata are removed.

- `claude-stop.json`: Claude Code 2.1.295's emitted Shuttle hook event after a parent launched two background `Agent` tasks and ended its turn.
  `backgroundTasks: 2` comes from the hook writer's projection of the harness's `background_tasks` registry.
- `codex-hooks.jsonl`: Codex CLI 0.160.0's emitted Shuttle hook stream from a parent that spawned an agent running `sleep 120` and ended its turn without waiting.
  The child tool events share the parent's `sessionId`; `subagent_stop` follows them without a second parent stop.
- `codex-app.json`: Codex App Server 0.160.0's `thread/read` responses during an isolated stdio probe.
  The parent spawned an agent running `sleep 45`, then ended its own turn.
  `thread/loaded/list` included both threads while the parent was `idle` and the child was `active`; the child named the parent in `parentThreadId`.
  The probe also observed the child become `idle` on completion.

`waiting_tracker_test.exs` replays the real hook stream through the production projection.
`codex_app_transport_test.exs` serves the captured App Server responses through a real Unix-socket WebSocket peer to the production adapter.
The generated TypeScript protocol from `codex app-server generate-ts` defines `Thread.parentThreadId`, `Thread.status`, and `ThreadLoadedListResponse.data/nextCursor` with these shapes.
