# Plugin integration and releasing

felt keeps shared hook and skill sources in `claude-plugin/`. **Claude Code**
installs that combined payload. **Codex** installs two independently refreshed
plugins from a generated `.agents/plugins/marketplace.json`: `felt` contains
only hooks and its manifest; `felt-skills` contains only skills and its manifest.
The Codex hook root contains exactly its manifest, `hooks.json`, and the
`pluginHookBasenames` shell adapters; Pi-only JavaScript is not copied.
Their adapter-format version is independent of the CLI release. **pi** uses
its native package and the same skill sources.

- `felt setup claude` registers the `cailmdaley/felt` marketplace and installs
  the plugin through Claude's native CLI; `felt setup codex` does the same
  through Codex's native marketplace and plugin commands. Neither installer
  hand-writes harness configuration.
- `felt setup pi` installs the same skills plus the pi extension through pi's
  package manager. `felt update` refreshes pi only when the Felt package is
  already registered, so an update never opts a new harness into the
  integration.
- The plugin bundles the `felt` and `shuttle` skills, Felt hooks for
  SessionStart (active and recently touched fibers) and PreToolUse
  (`internal/feltcli/hook.go`), and Shuttle hooks for event and commit records.
  **Updating the binaries updates binary-owned hook behavior**; refresh the plugin when its skills or adapter scripts change.
- Handoff nudges run in felt's Pi extension and the shared Claude Code/Codex `PostToolUse` and `UserPromptSubmit` hooks (which stay silent for Claude Code sessions), independent of a store or running daemon.
  Refresh the package/plugin after changing this integration, not just the binaries.
- `felt update` replaces both Go CLIs as a pair, then reconciles each installed
  integration; Homebrew's `post_install` does the same. Matching payload digests
  skip native plugin installation. A Go-only release changes provenance, not
  Codex plugin bytes; a skills-only release refreshes only `felt-skills`.
- Hook wrappers resolve the separately upgraded binaries through their existing
  environment/PATH/home lookup. CLI hook interfaces must remain backward
  compatible with installed wrappers. This is a trusted-updater boundary,
  not transitive pinning of every executable a hook can invoke.

## Context handoff nudges

Claude Code sessions are never nudged; they decide their own handoff.
Pi and Codex get a first nudge at `min(window × 75%, 500000)` context tokens and a firmer one at `min(window × 88%, 750000)`.
Each level fires once per session, even after resuming or compacting.
If a turn crosses both thresholds, Pi sends the first nudge and escalates on the next turn if work continues.
The integration advises a durable handoff; it neither terminates the session nor changes interactive Pi's compaction settings.
Confer can still veto automatic compaction for its workers, but felt owns their nudges.

The thresholds can be overridden in the environment:

| Environment variable | Default |
|---|---:|
| `SHUTTLE_HANDOFF_PCT` | 75 |
| `SHUTTLE_HANDOFF_TOKENS` | 500000 |
| `SHUTTLE_HANDOFF_HARD_PCT` | 88 |
| `SHUTTLE_HANDOFF_HARD_TOKENS` | 750000 |

Percentages must be positive and at most 100; token limits must be positive.
Hard settings must be at least their corresponding first-nudge settings.
Invalid configuration disables nudges without failing tools.
Pi uses `getContextUsage()` and records `shuttle-handoff` entries in the session; it also honors existing `confer-handoff` entries.

The Claude/Codex shim calls `shuttle hook handoff`; a missing or old binary fails open.
It does not start Node.
It reads at most the last 256 KiB of the transcript and skips malformed, partial, or oversized records.
If that suffix contains no usage record, it emits nothing and tries again at the next hook.
Claude context is the latest assistant's input, cache-read, cache-creation, and output tokens combined.
An explicit `context_window` field, `SHUTTLE_HANDOFF_CONTEXT_WINDOW` override, or `[1m]` model selector supplies the window; otherwise only the absolute limit applies.
No window is guessed from a Claude alias.
The hook stores private atomic per-level claims under `~/.shuttle/handoff/`, keyed by a hash of harness and session ID; `SHUTTLE_HANDOFF_STATE_DIR` overrides this location.
Resumes retain these files; delete a session's claims only to deliberately re-enable its warnings.

[Codex supports these hooks and `additionalContext`](https://developers.openai.com/codex/hooks/).
Its rollout `event_msg/token_count` records provide `info.last_token_usage.total_tokens` and `info.model_context_window`; cumulative billing totals are never used.
The transcript format isn't a stable Codex hook API, so unsupported formats fail open rather than estimating context.
`felt setup codex` records trust for felt's own plugin hooks through a temporary Codex App Server config API (Codex 0.166.0 or newer), only after verifying that Codex's cache holds the promoted generation.
Other hooks' trust is untouched; `felt setup codex --trust-hooks` repairs persisted trust without reinstalling, and `felt setup receipt` detects untrusted or modified hooks in a fresh private runtime.
An older Codex is an advisory receipt note; failure to inspect a supported Codex is a receipt failure.

**Persisted approval does not refresh a running Codex App Server.**
Codex 0.166.0 retains hook definitions and approvals in that process and checks plugin contents again before executing each hook.
If setup replaces the cache, a live session can report `plugin contents changed; hook approval required` even after setup and the receipt confirm trust.
New threads on that same server can fail too; a new terminal alone does not guarantee a fresh runtime.
Exit the affected session, then resume the conversation with `codex --no-daemon resume <session-id>` to load the installed hooks and persisted approvals in a fresh runtime.
If Codex reports an active writer, wait for the previous session to unload before resuming; do not run two writers against the same conversation.
Repeating `--trust-hooks` alone cannot refresh another process's in-memory approval.
Felt neither restarts that process nor bypasses Codex's checks, and a shell guard cannot intercept a refusal that happens before the shell runs.
Codex's native plugin commands own the cache and can remove old version roots.
Setup installs genuine hook-bundle changes normally and prints one cutover warning with the resume command; it does not pin workers or retain generations.
Go-only and skills-only releases leave the installed hook root untouched and do not require that cutover.

**The combined-to-split migration is a hook-bundle change.** The first setup removes skills and release provenance from the hook approval boundary and installs the separate skills bundle.
On Codex 0.166.0, an already-live combined-plugin runtime refuses its next hook with `plugin contents changed; hook approval required`, even when the hook commands themselves are identical and setup has persisted the new approval.
The conversation and process remain alive, but refused hooks do not deliver context, mailbox messages, activity records, or handoff nudges.
The skills are named `felt-skills:felt` and `felt-skills:shuttle`. Old skill paths
in the removed combined cache become unreadable. Codex 0.166.0's live
`skills/list` discovers the new names and paths without forced reload, even
while hooks still refuse execution; previously read skill text in conversation
context is not replaced. A fresh runtime loads the approved split bundles;
recover an existing conversation with the exit-and-resume procedure above.
When manually rolling back to the combined plugin, first run
`codex plugin remove felt-skills@cailmdaley-felt` to avoid duplicate skills.
A healthy receipt describes installed bytes and persisted approval, not the stale live process.

Other plugins' definition-only approvals can also fail after their contents change.
Codex migrates such approvals to a private `.hook-trust` baseline; a missing `trusted_content_hash` alone does not prove failure.
Review and approve those plugins through Codex's `/hooks` interface, then use a fresh runtime if an existing session retains stale approval.
Felt does not approve another plugin's contents on its author's behalf.

Refresh a source build on the current machine with `felt setup claude --source <clean-main-checkout>` and `felt setup codex --source <clean-main-checkout>` for installed harnesses, then check `felt setup receipt --json`.
These commands promote `~/.felt/plugin-runtime/current` transactionally; they don't restart or deploy the daemon.
For an installed Pi package, run `pi update git:github.com/cailmdaley/felt`, then `/reload` or start a new session.

## Plugin promotion

Every Claude/Codex setup source enters the same transaction. Remote GitHub refs
are first acquired into a disposable checkout; local `--source` paths enter
directly. Setup validates and copies only the complete marketplace payload into
`~/.felt/plugin-runtime/`, then promotes it under a cross-process lock with a
crash journal. Both manifests must describe the same version; the two skills,
hook manifest, executable hook files, and the installed Shuttle CLI contract
must all validate before the native CLI sees the candidate. Native
harness CLIs receive only the stable promoted `current` path and remain the
sole writers of their caches and configuration. If native installation reports
failure, setup restores the last known-good staged generation and reconciles the harness's marketplace/plugin state against it.
An unsealed prior Claude source cannot prove cache restoration; setup reports that limitation and retains the reconciliation journal.
A zero exit status alone never
commits a promotion: before the journal records `committed` and `previous` is
discarded, setup reads the cache path each native CLI reports as loaded
(`plugin list --json`), and verifies its bytes directly against the promoted
payload digest. Codex's source path is not its loaded cache: both versioned
native caches are located and verified independently. A failed verify first gets one forced
reinstall (uninstall+install / remove+add), because `plugin update` on an
unchanged manifest version legitimately keeps the old versioned cache; a
cache that still cannot prove the promoted generation after that is a
rejected candidate — the filesystem rolls back and native reconciliation must verify the restored state before its journal is removed.
The journal also records native
activation intent: after an interruption, the next setup restores `current`
first, reinstalls each affected harness from that path, verifies the restored
state, and retains the journal until reconciliation succeeds.

`~/.felt/plugin-runtime/current/.felt-generation.json` holds provenance outside
all plugin roots. It records the canonical source, requested ref, resolved
commit, source plugin version, Felt build identity, the combined Claude digest,
and each Codex bundle's digest. Native caches contain no copy of this file.
The receipt checks the installed Felt build against that external identity and
recomputes every enabled cache's digest. Same-version payload edits are detected
without requiring release metadata inside a hashed root. Pending journals,
missing provenance, or source/cache disagreement are unhealthy, with a setup
command to repair them. Marker and journal writes are fsynced and renamed with
a parent-directory sync, preserving crash recovery.

`TestCodexPluginPayloadClassificationGate` explicitly classifies source plugin
files as hook-bundle, skills-bundle, or Pi-only. An exact hook source allowlist
and a generated-tree equality gate reject unreviewed files and release metadata
without relying on a metadata filename or JSON-key convention.
Real-Codex tests exercise successive Go-only revisions, skills-only refreshes,
combined-to-split migration, and genuine hook changes against a live thread.

Use `felt setup validate --source <checkout>` as the non-mutating candidate
gate. Use `felt setup receipt --json` to report the bundle the harness CLIs
load, the felt binary, and Felt-owned hook state. Run `shuttle doctor` for the
host, listener, and live daemon contract; incidental cache directories are not
authoritative evidence.

CI is a release gate as well as a pull-request check. The UI job runs
`npm test`, which executes the board suite under the pinned
`America/Los_Angeles` timezone, and then runs the production bundle build. A green Go and daemon suite without this UI test is
not a release-ready result.
CI also runs `govulncheck` for reachable Go vulnerabilities, `mix_audit` for
Elixir dependency advisories, and `npm audit --omit=dev` for shipped UI
dependencies. Resolve findings before cutting a stable tag.
The `toolchain` directive in `go.mod` pins the compiler used by source builds,
CI, and release packaging; the `go` directive remains the language minimum.
Keep the toolchain on a supported security patch release.

Release: `scripts/release.sh <version>` first requires the main checkout to be
cleanly aligned with `origin/main` and checks that the new tag is absent both
locally and remotely. It then bumps
`claude-plugin/.claude-plugin/plugin.json` and
`.codex-plugin/plugin.json` in sync with the binary tag, commits that bump, and
creates the annotated tag. The script prints the explicit
`git push origin main v<version>` command; it does not push for you.

Pushing the tag triggers the GoReleaser workflow (darwin/linux ×
amd64/arm64; it updates the Homebrew formula for final public releases). The
workflow puts both Go CLIs in `felt_<os>_<arch>.tar.gz` and pins GoReleaser to
the version used for the published 1.1.0-rc.3 assets. The Mix daemon release
uses `shuttled_<os>_<arch>.tar.gz`. Before packaging, GoReleaser runs the complete candidate validator,
requires the two plugin manifests to agree, and on a real tag refuses a
manifest version that does not match it. Local snapshots skip only the tag
comparison, which keeps development packaging usable while retaining the
agreement check. GoReleaser creates a draft release and defers the Homebrew
tap update; the daemon matrix builds, gates and boot-tests every native
artifact, attaches all four daemon tarballs, and the final job verifies the
complete eight-archive set before making the release public.

The Linux daemon legs run inside an `almalinux:8` container, not on the bare
Ubuntu runner: a Mix release bundles the native ERTS that built it, and that
ERTS inherits the glibc/libstdc++ symbol floor of the build host. Built on
`ubuntu-latest` it needs `GLIBC_2.38`, which no HPC login node has (the fleet
floor is 2.28 — RHEL/Rocky/Alma 8). EL8 is the `manylinux_2_28` baseline, so an
artifact built there runs everywhere newer. There is no prebuilt OTP for EL8,
so the leg builds OTP from source into a cached `/opt/otp`, keyed on the exact
patch pinned in the workflow's `EL8_OTP_VERSION` (same major as `ci.yml`).

The invariant is *declared and gated*, not assumed: `scripts/check-glibc-floor.sh`
runs `objdump -T` over every ELF file in the assembled release and fails the
job if any binary needs more than `GLIBC_2.28` / `GLIBCXX_3.4.25` / `GCC_7.0.0`.
The boot test cannot catch this class of regression — it runs on the host that
produced the binaries, where the symbols are present by construction — which
is why a base-image bump or a leg quietly losing its `container:` fails at the
gate instead of on someone's cluster. Run the script locally against an
untarred release to audit a published artifact (macOS: `brew install binutils`).

GoReleaser's formula is preserved as an Actions artifact alongside those exact
archives; for a final release, that job pushes the preserved file
to the tap through the GitHub Contents API only after publication. A failed
native platform therefore leaves a
draft for repair instead of exposing a stable CLI release that cannot satisfy
`SHUTTLE_DAEMON=1` installs; a tap update cannot point at draft assets either.
Rerunning the same tag reuses that draft and replaces its artifacts.

The tap currently publishes a Homebrew **Formula**, so keep using
`brew install cailmdaley/tap/felt`. GoReleaser reports the legacy `brews`
publisher as deprecated in current v2 releases; moving to `homebrew_casks`
would require a coordinated tap and documentation migration and is tracked as
a packaging follow-up rather than being mixed into a stable release cut.

For an end-to-end binary consumer check, use an explicit published tag in a
fresh home directory and inspect both installed versions before starting the
daemon:

```bash
PROBE_ROOT="$(mktemp -d)"
HOME="$PROBE_ROOT/felt-home" PATH=/usr/bin:/bin \
  FELT_INSTALL_DIR="$PROBE_ROOT/cli" \
  FELT_VERSION=2.0.0-rc.2 SHUTTLE_DAEMON=1 \
  SHUTTLE_HOME="$PROBE_ROOT/shuttle" sh ./install.sh
"$PROBE_ROOT/cli/felt" --version
SHUTTLE_RELEASE="$PROBE_ROOT/shuttle" "$PROBE_ROOT/cli/shuttle" version
```

The installer verifies both Go CLI versions and the daemon release before
replacing an existing installation. With no daemon listener, `shuttle version`
uses the release directory and runs its `shuttled version` command, which starts
the bundled BEAM and fails on a host whose glibc is older than the build
machine's. The native release matrix boots each assembled daemon artifact before
upload, while the [Linux container acceptance test](layout.md#the-stranger-test-bootstrap-in-a-clean-container)
builds from a clean image and polls `/api/v1/version` until its contract is
healthy.

Release candidates: `scripts/release.sh 2.0.0-rc.1` — any `X.Y.Z-<suffix>`
version cuts a prerelease. Three things then keep it away from everyone who
didn't ask for it, and all three key off the `-` in the tag: goreleaser marks
the GitHub release `prerelease: auto`; `install.sh` and `felt update` resolve
through the `releases/latest` API, which skips prereleases; and the Homebrew
tap's `skip_upload` is true for any prerelease, so `brew upgrade felt` never
sees it. The only way in is pinning `FELT_VERSION` (see [Pin a release](../shuttle/installation.md#pin-a-release)). The daemon tarballs
attach to the RC release the same way, stamped with the RC version.
