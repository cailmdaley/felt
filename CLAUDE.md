# felt

Markdown fiber tracker. Directory-based markdown fibers with YAML frontmatter, plain markdown bodies, containment by path, and wikilinks for narrative references.

## Structure

```
cmd/           CLI commands (cobra)
internal/felt/ Core logic (storage, parsing, graph)
```

## Data model

Fibers are minimal by default. All fields except `name` are optional.

| Field | Notes |
|-------|-------|
| name | Required. The fiber. |
| body | Markdown content. |
| outcome | The conclusion — decisions, answers, results. `-o` flag. |
| status | Opt-in tracking: open/active/closed. Most fibers don't have one. |
| tags | Freeform. Use for categorization (decision, spec, question, etc). |
| inputs / outputs / decisions / insights | Optional ASTRA structure when the work becomes computationally explicit. |

**Status is opt-in.** `felt add <slug> "name"` creates a statusless fiber. `felt add <slug> "name" -s open` enters tracking. `felt edit <id> -s active` enters tracking. `felt ls` only shows tracked fibers.

**Progressive disclosure.** `felt show <id> -d compact` shows metadata + outcome + ASTRA counts. Levels: title, compact, summary, full (default). `felt tree` is the containment hierarchy.

## Key integrations

- **Reminders sync** — Apple Reminders <-> felt (dates, completion status)
- **Claude Code hooks** — session-start context via `felt hook session`

## Development

```bash
go build .        # build
go test ./...     # test
./felt ls         # run locally
./felt ls -s all  # include untracked fibers
./felt tree
```

## Releasing

```bash
git tag -a v0.x.0 -m "Release description"
git push origin v0.x.0
```

Release workflow builds binaries for darwin/linux x amd64/arm64. Homebrew formula must be manually pushed to `cailmdaley/homebrew-tap` (goreleaser can't auto-push without PAT secret).
