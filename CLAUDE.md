# felt

Markdown fiber tracker. Directory-based markdown fibers with YAML frontmatter, plain markdown bodies, containment by path, wikilinks for narrative references, and a rebuildable SQLite cache at `.felt/index.db`.

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
| extra frontmatter | Any other top-level YAML keys. felt preserves them opaquely and surfaces them in JSON. |

**Status is opt-in.** `felt add <slug> "name"` creates a statusless fiber. `felt add <slug> "name" -s open` enters tracking. `felt edit <id> -s active` enters tracking. `felt ls` only shows tracked fibers.

**Relationships and index.** Containment is the directory tree. `[[wikilinks]]` are narrative references. If a project uses `inputs.from` as a data-flow convention, felt indexes reverse consumers without claiming the rest of that schema. The SQLite cache indexes links, tags, additional YAML field text, and FTS5 body text; `felt show` uses it for citations/consumers and `felt ls --body` uses it for fast body search.

**Editing.** `felt edit` owns native metadata only: name, status, tags, due, body, outcome. For non-native frontmatter, read then edit the markdown file directly.

**Progressive disclosure.** `felt show <id> -d compact` shows metadata + outcome + additional YAML field keys. Levels: name, compact, summary, full (default). Targeted views: `felt show <id> --body` prints the body plus its start line; `--citations`, `--consumers`, and `--field <key>` expose index-backed or raw-frontmatter slices directly.

## Key integrations

- **Reminders sync** — Apple Reminders <-> felt (dates, completion status)
- **Claude Code hooks** — session-start context via `felt hook session`

## Development

```bash
go build .        # build
go test ./...     # test
./felt ls         # run locally
./felt ls -s all  # include untracked fibers
./felt check
```

## Releasing

```bash
git tag -a v0.x.0 -m "Release description"
git push origin v0.x.0
```

Release workflow builds binaries for darwin/linux x amd64/arm64 and auto-pushes the Homebrew formula to `cailmdaley/homebrew-tap` via the `HOMEBREW_TAP_TOKEN` secret.
