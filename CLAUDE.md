# felt

Markdown fiber tracker. Directory-based markdown fibers with YAML frontmatter, plain markdown bodies, containment by path, wikilinks for narrative references, and a rebuildable SQLite cache at `.felt/index.db`.

## Structure

```
cmd/                              CLI commands (cobra)
internal/felt/                    Core logic (storage, parsing, graph)
claude-plugin/                    Plugin payload for Claude Code + Codex
  .claude-plugin/plugin.json        Claude Code manifest
  .codex-plugin/plugin.json         Codex manifest
  hooks/{hooks.json,session.sh,
        remind.sh}                  hook shims; exec felt hook <event>
  skills/{felt,ralph}/              skill content
.claude-plugin/marketplace.json   Repo-level marketplace; both agents read it
scripts/release.sh                Bumps plugin manifests + commits + tags
```

## Data model

Fibers are minimal by default. All fields except `name` are optional.

| Field | Notes |
|-------|-------|
| id | Intrinsic ULID minted once at `felt add`. Preserved in frontmatter; surfaced as `uid` in JSON because JSON `id` remains the slug address. |
| name | Required. The fiber. |
| body | Markdown content. |
| outcome | The conclusion — decisions, answers, results. `-o` flag. |
| status | Opt-in tracking: open/active/closed. Most fibers don't have one. |
| tags | Freeform. Use for categorization (decision, spec, question, etc). |
| extra frontmatter | Any other top-level YAML keys. felt preserves them opaquely and surfaces them in JSON. |

**Identity.** The CLI still addresses fibers by slug path (`felt show project/fiber`). New fibers also carry a frontmatter ULID (`id:`) minted once at creation for federation tools. JSON keeps slug at `id` for compatibility and exposes the intrinsic value as `uid`.

**Status is opt-in.** `felt add <slug> "name"` creates a statusless fiber. `felt add <slug> "name" -s open` enters tracking. `felt edit <id> -s active` enters tracking. `felt ls` only shows tracked fibers.

**Relationships and index.** Containment is the directory tree. `[[wikilinks]]` are narrative references. If a project uses `inputs.from` as a data-flow convention, felt indexes reverse consumers without claiming the rest of that schema. The SQLite cache indexes links, tags, additional YAML field text, and FTS5 body text; `felt show` uses it for citations/consumers and `felt ls --body` uses it for fast body search.

**Editing.** `felt edit` owns native metadata only: name, status, tags, due, body, outcome. For non-native frontmatter, read then edit the markdown file directly.

**Progressive disclosure.** `felt show <id> -d compact` shows metadata + outcome + additional YAML field keys. Levels: name, compact, summary, full (default). Targeted views: `felt show <id> --body` prints the body plus its start line; `--citations`, `--consumers`, and `--field <key>` expose index-backed or raw-frontmatter slices directly.

## Agent integrations

felt ships a single plugin (`claude-plugin/`) that serves both **Claude Code**
and **Codex**. The same hook scripts and skills directory work for either
agent; only the manifest at the plugin root differs (`.claude-plugin/` and
`.codex-plugin/` siblings, same content). A single marketplace manifest at
`.claude-plugin/marketplace.json` registers the plugin for both — Codex reads
it under its legacy-compat path.

**Session text is separate from hook envelopes.** `felt session` prints the
human-readable SessionStart context. `claude-plugin/hooks/session.sh` wraps
that text in the Claude/Codex JSON envelope with `jq` when available, falling
back to `felt hook session` for compatibility. `felt hook pretool` still owns
the PreToolUse deny gate (see `cmd/hook.go`). Updating the binary updates hook
behavior — the plugin only needs refreshing when skill content changes.

**Binary and plugin update in lockstep.** `felt update` swaps the binary, then
calls `felt setup claude` / `felt setup codex` to refresh each integration.
The homebrew formula's `post_install` does the same on `brew upgrade felt`.
This is what makes "just run `brew upgrade felt`" actually work end-to-end
— without it, the plugin would lag the binary and hooks would break (see
the `felt-ls-j-empty-emits-array-not-null` fiber for the failure mode that
forced this).

**Codex specifics.** Codex's plugin hooks are off by default;
`felt setup codex` auto-flips `features.plugin_hooks = true` in
`~/.codex/config.toml` along with enabling the plugin. Pre-1.0.8 felt installs
wired Codex via direct `~/.codex/hooks.json` entries; `felt setup codex` now
prunes those (and any stale `~/.agents/skills/{felt,ralph}` symlinks) when
migrating users to the plugin model.

**Apple Reminders sync.** A separate integration: Apple Reminders ↔ felt
(dates, completion status). Unrelated to the agent plugin.

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
scripts/release.sh 1.0.9                # bumps plugin manifests, commits, tags
git push origin main v1.0.9             # triggers goreleaser workflow
```

`scripts/release.sh` keeps `claude-plugin/.claude-plugin/plugin.json` and
`claude-plugin/.codex-plugin/plugin.json` versions in sync with the binary tag.
Both Claude Code and Codex compare plugin.json versions when running
`plugin update`; without a bump, `claude plugin update felt@cailmdaley-felt`
reports "already up to date" even after the binary has shipped new content.
The goreleaser workflow has a `before`-hook guard that refuses to build a
release whose manifests don't match the tag, so a forgotten bump can't ship.

Release workflow builds binaries for darwin/linux × amd64/arm64 and auto-pushes
the Homebrew formula to `cailmdaley/homebrew-tap` via the `HOMEBREW_TAP_TOKEN`
secret.
