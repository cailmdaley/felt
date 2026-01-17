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
- **spec** — design document, reference material
- **decision** — a choice to make, closes with reasoning
- **question** — something to answer

## Development

```bash
go build .        # build
go test ./...     # test
./felt ls         # run locally
```
