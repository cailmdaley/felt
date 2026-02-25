# felt

DAG-native fiber tracker. Markdown files with YAML frontmatter, dependencies form a directed acyclic graph.

## Structure

```
cmd/           CLI commands (cobra)
internal/felt/ Core logic (storage, parsing, graph)
```

## Data model

Fibers are minimal by default. All fields except title are optional.

| Field | Notes |
|-------|-------|
| title | Required. The fiber. |
| body | Markdown content. |
| outcome | The conclusion — decisions, answers, results. `-o` flag. |
| status | Opt-in tracking: open/active/closed. Most fibers don't have one. |
| tags | Freeform. Use for categorization (decision, spec, question, etc). |
| depends-on | DAG edges. Supports labels: `{id, label}`. |

**Status is opt-in.** `felt add "title"` creates a statusless fiber. `felt add "title" -s open` enters tracking. `felt edit <id> -s active` enters tracking. `felt ls` only shows tracked fibers.

**Progressive disclosure.** `felt show <id> -d compact` shows metadata + outcome without body. Levels: title, compact, summary, full (default). `felt upstream/downstream <id> -d compact` renders each connected fiber at that detail level.

**Backward compat:** `close-reason` reads as `outcome`, `kind` reads as a tag. Both migrate on next write.

## Key integrations

- **Reminders sync** — Apple Reminders <-> felt (dates, completion status)
- **Claude Code hooks** — session-start context via `felt hook session`

## Development

```bash
go build .        # build
go test ./...     # test
./felt ls         # run locally
./felt ls -s all  # include untracked fibers
```

## Releasing

```bash
git tag -a v0.x.0 -m "Release description"
git push origin v0.x.0
```

Release workflow builds binaries for darwin/linux x amd64/arm64. Homebrew formula must be manually pushed to `cailmdaley/homebrew-tap` (goreleaser can't auto-push without PAT secret).
