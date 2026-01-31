# felt

DAG-native fiber tracker. Markdown files with YAML frontmatter, dependencies form a directed acyclic graph.

## Structure

```
cmd/           CLI commands (cobra)
internal/felt/ Core logic (storage, parsing, graph)
docs/          Documentation
```

## Key integrations

- **Reminders sync** — Apple Reminders <-> felt (dates, completion status)
- **Claude Code hooks** — session-start context

## Kinds

Freeform, but conventional:
- **task** — default, something to do
- **spec** — design document, aspirational (can finalize)
- **decision** — a choice to make, closes with reasoning
- **question** — something to answer
- **doc** — living reference, maintained over time (architecture, how-tos, accumulated understanding)

## Development

```bash
go build .        # build
go test ./...     # test
./felt ls         # run locally
```

## Releasing

```bash
git tag -a v0.x.0 -m "Release description"
git push origin v0.x.0
```

Release workflow builds binaries for darwin/linux x amd64/arm64. Homebrew formula must be manually pushed to `cailmdaley/homebrew-tap` (goreleaser can't auto-push without PAT secret).
